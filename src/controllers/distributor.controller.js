import PincodeMaster from '../models/PincodeMaster.js';
import PincodeReservation from '../models/PincodeReservation.js';
import DistributorLead from '../models/DistributorLead.js';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler.js';
import { generateOtp, hashOtp, compareOtp } from '../utils/otp.js';
import { checkOtpRateLimit, logOtpRequest } from '../utils/otpRateLimiter.js';
import { sendOtpEmail } from '../services/email.service.js';
import { acquirePincodeLock, QR_REVIEW_LOCK_DURATION_MS } from '../utils/pincodeLock.js';
import { markLeadPaid } from '../utils/paymentReconciliation.js';
import { createRazorpayOrder, verifyPaymentSignature, verifyWebhookSignature } from '../services/razorpay.service.js';
import { config } from '../config/environment.js';
import WebhookLog from '../models/WebhookLog.js';
import { checkEmailValidity } from '../utils/emailVerification.js';

const PINCODE_REGEX = /^\d{6}$/;
const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
const REQUIRED_CONSENTS = ['nonRefundable', 'terms', 'kyc', 'genuineMerchants', 'policyViolation'];
const MAX_OTP_ATTEMPTS = 5;
const OTP_VALIDITY_MS = 5 * 60 * 1000;
const BOOKING_AMOUNT_PAISE = 118000; // ₹1,180, inclusive of GST — never charge extra on top

// POST /api/v1/distributor/check-pincode
// Read-only — no lock is taken here. Two people checking the same pincode
// simultaneously is fine, this doesn't touch PincodeReservation writes.
export const checkPincode = asyncHandler(async (req, res) => {
  const { pincode } = req.body;

  if (!pincode || !PINCODE_REGEX.test(pincode)) {
    const error = new Error('Please enter a valid 6-digit pincode');
    error.statusCode = 400;
    throw error;
  }

  const master = await PincodeMaster.findOne({ pincode });

  if (!master) {
    const error = new Error('This pincode was not found in our serviceable areas');
    error.statusCode = 404;
    throw error;
  }

  const reservation = await PincodeReservation.findOne({ pincode });

  let available = true;
  let reason = null;

  if (reservation) {
    if (reservation.status === 'confirmed') {
      available = false;
      reason = 'already_allotted';
    } else if (reservation.status === 'locked' && (!reservation.expiresAt || reservation.expiresAt > new Date())) {
      available = false;
      reason = 'temporarily_reserved';
    }
    // else: locked but expired — treat as available, Step 4 (lock acquisition)
    // will atomically steal the stale lock when this user actually tries to book.
  }

  res.status(200).json({
    success: true,
    data: {
      pincode: master.pincode,
      district: master.district,
      state: master.statename,
      alternateDistricts: master.alternateDistricts,
      alternateStates: master.alternateStates,
      officeNames: master.offices.map((o) => o.name),
      available,
      reason,
    },
  });
});

// POST /api/v1/distributor/nearby-pincodes
// "Nearby" = same district — no lat/long data is stored (dropped during
// import, see PincodeMaster notes), so this is administratively nearby,
// not geographically precise.
export const getNearbyPincodes = asyncHandler(async (req, res) => {
  const { pincode } = req.body;

  if (!pincode || !PINCODE_REGEX.test(pincode)) {
    const error = new Error('Please provide a valid 6-digit pincode');
    error.statusCode = 400;
    throw error;
  }

  const master = await PincodeMaster.findOne({ pincode });
  if (!master) {
    const error = new Error('This pincode was not found in our serviceable areas');
    error.statusCode = 404;
    throw error;
  }

  const CANDIDATE_POOL_SIZE = 30;
  const SUGGESTION_LIMIT = 5;

  const candidates = await PincodeMaster.find({
    district: master.district,
    statename: master.statename,
    pincode: { $ne: pincode },
  })
    .limit(CANDIDATE_POOL_SIZE)
    .select('pincode district statename');

  if (!candidates.length) {
    return res.status(200).json({ success: true, data: [] });
  }

  const candidatePincodes = candidates.map((c) => c.pincode);
  const now = new Date();

  const unavailableReservations = await PincodeReservation.find({
    pincode: { $in: candidatePincodes },
    $or: [
      { status: 'confirmed' },
      { status: 'locked', expiresAt: { $gt: now } },
      { status: 'locked', expiresAt: { $exists: false } },
    ],
  }).select('pincode');

  const unavailableSet = new Set(unavailableReservations.map((r) => r.pincode));

  const suggestions = candidates
    .filter((c) => !unavailableSet.has(c.pincode))
    .slice(0, SUGGESTION_LIMIT)
    .map((c) => ({ pincode: c.pincode, district: c.district, state: c.statename }));

  res.status(200).json({ success: true, data: suggestions });
});

// POST /api/v1/distributor/find-existing-booking
// Entry point for the "Complete Payment for Existing PIN" flow. Deliberately
// returns only masked identity info — full details require OTP verification
// (see verifyExistingBookingOtp). Only 'paid' and 'activated' leads are
// findable here; anything earlier in the funnel is treated as "not found"
// so this endpoint can't be used to probe internal booking state.
export const findExistingBooking = asyncHandler(async (req, res) => {
  const { pincode } = req.body;

  if (!pincode || !PINCODE_REGEX.test(pincode)) {
    const error = new Error('Please enter a valid 6-digit pincode');
    error.statusCode = 400;
    throw error;
  }

  const lead = await DistributorLead.findOne({
    pincode,
    status: { $in: ['paid', 'activated'] },
  }).sort({ createdAt: -1 });

  if (!lead) {
    const error = new Error('No completed booking was found for this PIN Code');
    error.statusCode = 404;
    throw error;
  }

  const maskedMobile = lead.mobile.length >= 4
    ? 'X'.repeat(lead.mobile.length - 4) + lead.mobile.slice(-4)
    : lead.mobile;

  const [emailUser, emailDomain] = lead.email.split('@');
  const maskedEmail = emailUser.length > 2
    ? emailUser[0] + '*'.repeat(emailUser.length - 2) + emailUser.slice(-1) + '@' + emailDomain
    : lead.email;

  res.status(200).json({
    success: true,
    data: {
      bookingId: lead._id,
      pincode: lead.pincode,
      name: lead.name,
      maskedMobile,
      maskedEmail,
      status: lead.status, // 'paid' → payment pending, 'activated' → already done
    },
  });
});

// POST /api/v1/distributor/existing-booking/send-otp
// Sends OTP to the REGISTERED email on the lead — never to a user-supplied
// email/mobile — so this can't be used to hijack someone else's booking by
// just supplying your own contact details.
export const sendExistingBookingOtp = asyncHandler(async (req, res) => {
  const { bookingId } = req.body;

  if (!bookingId || !mongoose.isValidObjectId(bookingId)) {
    const error = new Error('Invalid bookingId');
    error.statusCode = 400;
    throw error;
  }

  const lead = await DistributorLead.findById(bookingId);
  if (!lead || !['paid', 'activated'].includes(lead.status)) {
    const error = new Error('No completed booking was found for this PIN Code');
    error.statusCode = 404;
    throw error;
  }

  await checkOtpRateLimit(lead.email);

  const otp = generateOtp();
  const otpHash = await hashOtp(otp);

  lead.existingBookingOtpHash = otpHash;
  lead.existingBookingOtpExpiresAt = new Date(Date.now() + OTP_VALIDITY_MS);
  lead.existingBookingOtpAttempts = 0;
  await lead.save();

  await sendOtpEmail({ to: lead.email, name: lead.name, otp });
  await logOtpRequest(lead.email);

  res.status(200).json({
    success: true,
    message: 'OTP sent to your registered email',
    data: { bookingId: lead._id },
  });
});

// POST /api/v1/distributor/existing-booking/verify-otp
// On success, returns the FULL unmasked booking + payment summary — this is
// the gate that unlocks real PII and the payment amount, per the design
// decision to require OTP before revealing anything beyond masked identity.
export const verifyExistingBookingOtp = asyncHandler(async (req, res) => {
  const { bookingId, otp } = req.body;

  if (!bookingId || !otp || !mongoose.isValidObjectId(bookingId)) {
    const error = new Error('bookingId and otp are required');
    error.statusCode = 400;
    throw error;
  }

  const lead = await DistributorLead.findById(bookingId).select('+existingBookingOtpHash');
  if (!lead || !['paid', 'activated'].includes(lead.status)) {
    const error = new Error('No completed booking was found for this PIN Code');
    error.statusCode = 404;
    throw error;
  }

  if (!lead.existingBookingOtpExpiresAt || lead.existingBookingOtpExpiresAt < new Date()) {
    const error = new Error('OTP expired. Please request a new one.');
    error.statusCode = 400;
    throw error;
  }

  if (lead.existingBookingOtpAttempts >= MAX_OTP_ATTEMPTS) {
    const error = new Error('Too many incorrect attempts. Please request a new OTP.');
    error.statusCode = 429;
    throw error;
  }

  const isValid = await compareOtp(otp, lead.existingBookingOtpHash);

  if (!isValid) {
    lead.existingBookingOtpAttempts += 1;
    await lead.save();
    const remaining = Math.max(0, MAX_OTP_ATTEMPTS - lead.existingBookingOtpAttempts);
    const error = new Error(`Incorrect OTP. ${remaining} attempt(s) remaining.`);
    error.statusCode = 400;
    throw error;
  }

  lead.existingBookingOtpHash = undefined;
  await lead.save();

  const totalFee = lead.totalDistributorFee || 0;
  const amountPaid = lead.payments
    .filter((p) => p.status === 'success')
    .reduce((sum, p) => sum + p.amount, 0);
  const pendingAmount = Math.max(0, totalFee - amountPaid);

  res.status(200).json({
    success: true,
    message: 'OTP verified successfully',
    data: {
      bookingId: lead._id,
      pincode: lead.pincode,
      name: lead.name,
      mobile: lead.mobile,
      email: lead.email,
      bookingDate: lead.createdAt,
      status: lead.status,
      totalFee,
      amountPaid,
      pendingAmount,
    },
  });
});

// POST /api/v1/distributor/existing-booking/submit-final-utr
// QR/UTR final payment for the "Complete Payment for Existing PIN" flow.
// Mirrors submitUtr's pattern, but does NOT touch lead.status — per the
// confirmed rule, only an admin approving this UTR can move status to
// 'activated'. Submitting here just queues it for review.
export const submitFinalUtr = asyncHandler(async (req, res) => {
  const { bookingId, utr, panCard, aadhaarAddress, shopName, shopAddress, referralCode } = req.body;

  if (!bookingId || !mongoose.isValidObjectId(bookingId)) {
    const error = new Error('Invalid bookingId');
    error.statusCode = 400;
    throw error;
  }

  const trimmedPanCard = (panCard || '').trim().toUpperCase();
  const trimmedAadhaarAddress = (aadhaarAddress || '').trim();
  const trimmedShopName = (shopName || '').trim();
  const trimmedShopAddress = (shopAddress || '').trim();

  if (!trimmedPanCard || !trimmedAadhaarAddress || !trimmedShopName || !trimmedShopAddress) {
    const error = new Error('PAN card, Aadhaar address, shop name and shop address are required');
    error.statusCode = 400;
    throw error;
  }

  if (!PAN_REGEX.test(trimmedPanCard)) {
    const error = new Error('Please enter a valid PAN card number (e.g. ABCDE1234F)');
    error.statusCode = 400;
    throw error;
  }

  const trimmedUtr = (utr || '').trim();
  if (!UTR_REGEX.test(trimmedUtr)) {
    const error = new Error('Please enter a valid UTR / transaction reference number');
    error.statusCode = 400;
    throw error;
  }

  const lead = await DistributorLead.findById(bookingId);
  if (!lead || lead.status !== 'paid') {
    const error = new Error('This booking is not eligible for final payment');
    error.statusCode = 400;
    throw error;
  }

  const totalFee = lead.totalDistributorFee || 0;
  const amountPaid = lead.payments
    .filter((p) => p.status === 'success')
    .reduce((sum, p) => sum + p.amount, 0);
  const pendingAmount = Math.max(0, totalFee - amountPaid);

  if (pendingAmount <= 0) {
    const error = new Error('No pending amount remains for this booking');
    error.statusCode = 400;
    throw error;
  }

  // Block resubmission while an earlier final-UTR is still pending review —
  // same spirit as submitUtr's booking-stage guard.
  const hasPendingFinalUtr = lead.payments.some(
    (p) => p.stage === 'final' && p.status === 'pending'
  );
  if (hasPendingFinalUtr) {
    const error = new Error('A payment reference is already submitted for this booking and is awaiting review');
    error.statusCode = 400;
    throw error;
  }

  // App-level uniqueness check — payments[].utr can't carry a DB unique
  // index (it's inside an array), so this is a query-then-insert check.
  // Small race window is acceptable since this is staff-reviewed, not an
  // automated activation trigger.
  const utrAlreadyUsed = await DistributorLead.findOne({
    $or: [{ 'qrPayment.utr': trimmedUtr }, { 'payments.utr': trimmedUtr }],
  });
  if (utrAlreadyUsed) {
    const error = new Error(
      'This transaction reference number has already been submitted. If you believe this is a mistake, please contact support.'
    );
    error.statusCode = 409;
    throw error;
  }

  lead.panCard = trimmedPanCard;
  lead.aadhaarAddress = trimmedAadhaarAddress;
  lead.shopName = trimmedShopName;
  lead.shopAddress = trimmedShopAddress;
  lead.finalReferralCode = (referralCode || '').trim();

  lead.payments.push({
    stage: 'final',
    method: 'qr_self',
    amount: pendingAmount,
    status: 'pending',
    utr: trimmedUtr,
  });
  await lead.save();

  res.status(200).json({
    success: true,
    message: 'Your payment reference has been submitted and is pending verification.',
    data: { bookingId: lead._id, status: 'pending_review' },
  });
});

// POST /api/v1/distributor/send-otp
// Creates/updates the DistributorLead, sends a fresh OTP. No pincode lock is
// taken here — that happens later, after OTP verification (Step 4 in the HLD).
export const sendOtp = asyncHandler(async (req, res) => {
  const { name, mobile, email, pincode, asmCode, referralCode, consents } = req.body;

  if (!name || !mobile || !email || !pincode) {
    const error = new Error('Name, mobile, email and pincode are required');
    error.statusCode = 400;
    throw error;
  }

  if (!PINCODE_REGEX.test(pincode)) {
    const error = new Error('Please enter a valid 6-digit pincode');
    error.statusCode = 400;
    throw error;
  }

  // Server-side re-validation — never trust the client's checkbox state alone.
  const allConsentsGiven = consents && REQUIRED_CONSENTS.every((key) => consents[key] === true);
  if (!allConsentsGiven) {
    const error = new Error('Please accept all consent terms to proceed');
    error.statusCode = 400;
    throw error;
  }

  const master = await PincodeMaster.findOne({ pincode });
  if (!master) {
    const error = new Error('This pincode was not found in our serviceable areas');
    error.statusCode = 404;
    throw error;
  }

  const normalizedEmail = email.trim().toLowerCase();

  const emailCheck = await checkEmailValidity(normalizedEmail);
  if (!emailCheck.valid) {
    const error = new Error('Please enter a valid, deliverable email address');
    error.statusCode = 400;
    throw error;
  }

  // One distributor = one PIN code, for life. Checked on EITHER email or
  // mobile matching an existing PAID lead — blocks the obvious workaround of
  // reusing one identifier with a different other. Deliberately excludes
  // 'lock_lost' leads: those already paid but didn't end up with a pincode,
  // and are handled separately via manual outreach (see HLD Section 5) —
  // this rule shouldn't lock them out while that's still being resolved.
  const existingPaidLead = await DistributorLead.findOne({
    status: 'paid',
    $or: [{ email: normalizedEmail }, { mobile }],
  });

  if (existingPaidLead) {
    const error = new Error(
      `You have already reserved PIN Code ${existingPaidLead.pincode}. Only one PIN Code reservation is allowed per distributor.`
    );
    error.statusCode = 409;
    throw error;
  }

  // Block a second concurrent attempt while an earlier one is still in
  // flight — lock_acquired covers both the QR-review-pending window and
  // the manual-payment-pending window, since both paths set this status
  // (see verifyOtp / submitUtr). Without this, the same person could hold
  // two different pincodes locked at once under the same identity.
  const existingLockedLead = await DistributorLead.findOne({
    status: 'lock_acquired',
    $or: [{ email: normalizedEmail }, { mobile }],
  });

  if (existingLockedLead) {
    const error = new Error(
      `You already have a pending PIN Code reservation (${existingLockedLead.pincode}) awaiting approval. Please wait for it to be processed, or use a different email/mobile.`
    );
    error.statusCode = 409;
    throw error;
  }

  // Layer 2 rate limit — identifier-based, survives restarts (Section 4a of the HLD)
  await checkOtpRateLimit(normalizedEmail);

  const otp = generateOtp();
  const otpHash = await hashOtp(otp);
  const otpExpiresAt = new Date(Date.now() + OTP_VALIDITY_MS);

  // Idempotency: reuse an in-progress lead for the same email+pincode instead
  // of creating a duplicate on every resend or repeated form submit — but
  // ONLY while it's still pre-verification. A lead that's already otp_verified
  // or beyond (lock_acquired, order_created, ...) must never be touched here,
  // or a stray resend could reset its status out from under an active pincode
  // lock while PincodeReservation still thinks that lead owns it.
  let lead = await DistributorLead.findOne({
    email: normalizedEmail,
    pincode,
    status: { $nin: ['paid', 'failed', 'expired', 'lock_lost'] },
  });

  if (lead) {
    lead.name = name;
    lead.mobile = mobile;
    lead.asmCode = asmCode || '';
    lead.referralCode = referralCode || '';
    lead.district = master.district;
    lead.state = master.statename;
    lead.consents = consents;
    lead.otpHash = otpHash;
    lead.otpExpiresAt = otpExpiresAt;
    lead.otpAttempts = 0;
    lead.otpVerified = false;
    lead.status = 'otp_sent';
    await lead.save();
  } else {
    lead = await DistributorLead.create({
      name,
      mobile,
      email: normalizedEmail,
      asmCode: asmCode || '',
      referralCode: referralCode || '',
      pincode,
      district: master.district,
      state: master.statename,
      consents,
      otpHash,
      otpExpiresAt,
      status: 'otp_sent',
    });
  }

  await sendOtpEmail({ to: normalizedEmail, name, otp });
  await logOtpRequest(normalizedEmail);

  res.status(200).json({
    success: true,
    message: 'OTP sent to your email',
    data: { bookingId: lead._id },
  });
});

// POST /api/v1/distributor/verify-otp
export const verifyOtp = asyncHandler(async (req, res) => {
  const { bookingId, otp } = req.body;

  if (!bookingId || !otp) {
    const error = new Error('bookingId and otp are required');
    error.statusCode = 400;
    throw error;
  }

  if (!mongoose.isValidObjectId(bookingId)) {
    const error = new Error('Invalid bookingId');
    error.statusCode = 400;
    throw error;
  }

  const lead = await DistributorLead.findById(bookingId).select('+otpHash');
  if (!lead) {
    const error = new Error('Booking not found');
    error.statusCode = 404;
    throw error;
  }

  if (lead.otpVerified) {
    return res.status(200).json({
      success: true,
      message: 'OTP already verified',
      // Read from the lead itself, not current config — config may have
      // changed since this lead was originally verified, but the lead's
      // own stored paymentMethod is what's actually true for it.
      data: { bookingId: lead._id, manualPayment: lead.paymentMethod === 'manual', paymentMode: lead.paymentMethod },
    });
  }

  if (!lead.otpExpiresAt || lead.otpExpiresAt < new Date()) {
    const error = new Error('OTP expired. Please request a new one.');
    error.statusCode = 400;
    throw error;
  }

  if (lead.otpAttempts >= MAX_OTP_ATTEMPTS) {
    const error = new Error('Too many incorrect attempts. Please request a new OTP.');
    error.statusCode = 429;
    throw error;
  }

  const isValid = await compareOtp(otp, lead.otpHash);

  if (!isValid) {
    lead.otpAttempts += 1;
    await lead.save();
    const remaining = Math.max(0, MAX_OTP_ATTEMPTS - lead.otpAttempts);
    const error = new Error(`Incorrect OTP. ${remaining} attempt(s) remaining.`);
    error.statusCode = 400;
    throw error;
  }

  lead.otpVerified = true;
  lead.otpVerifiedAt = new Date();
  lead.status = 'otp_verified';
  lead.otpHash = undefined;
  await lead.save();

  if (config.distributor.qrPaymentMode) {
    lead.paymentMethod = 'qr_self';
    const baseAmount = Math.round(BOOKING_AMOUNT_PAISE / 1.18);
    const gstAmount = BOOKING_AMOUNT_PAISE - baseAmount;
    lead.gst = { baseAmount, gstAmount, totalAmount: BOOKING_AMOUNT_PAISE };
  } else if (config.distributor.manualPaymentMode) {
    lead.paymentMethod = 'manual';
    lead.leadCallStatus = 'pending_call';
    const baseAmount = Math.round(BOOKING_AMOUNT_PAISE / 1.18);
    const gstAmount = BOOKING_AMOUNT_PAISE - baseAmount;
    lead.gst = { baseAmount, gstAmount, totalAmount: BOOKING_AMOUNT_PAISE };
  }

  await lead.save();

  res.status(200).json({
    success: true,
    message: 'OTP verified successfully',
    // manualPayment is kept for backward compatibility with the current
    // frontend; paymentMode is the new, more explicit field going forward.
    data: {
      bookingId: lead._id,
      manualPayment: lead.paymentMethod === 'manual',
      paymentMode: lead.paymentMethod,
    },
  });
});

// POST /api/v1/distributor/create-order
// HLD Steps 4+5 combined: acquire the pincode lock (the race-condition-proof
// step), then create the Razorpay order. Requires OTP already verified.
export const createOrder = asyncHandler(async (req, res) => {
  const { bookingId } = req.body;

  if (!bookingId || !mongoose.isValidObjectId(bookingId)) {
    const error = new Error('Invalid bookingId');
    error.statusCode = 400;
    throw error;
  }

  const lead = await DistributorLead.findById(bookingId);
  if (!lead) {
    const error = new Error('Booking not found');
    error.statusCode = 404;
    throw error;
  }

  if (!lead.otpVerified) {
    const error = new Error('Please verify your OTP before proceeding');
    error.statusCode = 400;
    throw error;
  }

  if (lead.status === 'paid') {
    const error = new Error('This booking has already been paid for');
    error.statusCode = 400;
    throw error;
  }

  // Idempotent — verifyOtp already acquired this lead's lock; this just
  // refreshes the TTL so Razorpay checkout gets a fresh 15-minute window.
  await acquirePincodeLock({ pincode: lead.pincode, bookingId: lead._id });

  lead.status = 'lock_acquired';
  await lead.save();

  const baseAmount = Math.round(BOOKING_AMOUNT_PAISE / 1.18);
  const gstAmount = BOOKING_AMOUNT_PAISE - baseAmount;

  let order;
  try {
    order = await createRazorpayOrder({
      amount: BOOKING_AMOUNT_PAISE,
      currency: 'INR',
      receipt: lead._id.toString(),
      notes: { bookingId: lead._id.toString(), pincode: lead.pincode },
    });
  } catch (err) {
    const error = new Error('Failed to create payment order. Please try again.');
    error.statusCode = 502;
    error.details = err.message;
    throw error;
  }

  lead.razorpay = {
    orderId: order.id,
    amount: BOOKING_AMOUNT_PAISE,
    currency: 'INR',
    receipt: lead._id.toString(),
  };
  lead.gst = { baseAmount, gstAmount, totalAmount: BOOKING_AMOUNT_PAISE };
  lead.status = 'order_created';
  await lead.save();

  res.status(200).json({
    success: true,
    data: {
      manualPayment: false,
      orderId: order.id,
      amount: BOOKING_AMOUNT_PAISE,
      currency: 'INR',
      keyId: config.razorpay.keyId,
      bookingId: lead._id,
      gst: { baseAmount, gstAmount, totalAmount: BOOKING_AMOUNT_PAISE },
    },
  });
});


const UTR_REGEX = /^[A-Za-z0-9]{6,22}$/;

// POST /api/v1/distributor/submit-utr
// Self-serve QR flow: customer scans the static QR, pays externally, then
// submits the UTR their UPI app showed them. This does NOT mark the lead
// paid — it only queues it for admin review (see distributorAdmin.controller.js
// approveUtr/rejectUtr). The pincode lock is extended to a 48-hour window
// here, since admin review isn't instant like Razorpay's callback.
export const submitUtr = asyncHandler(async (req, res) => {
  const { bookingId, utr } = req.body;

  if (!bookingId || !mongoose.isValidObjectId(bookingId)) {
    const error = new Error('Invalid bookingId');
    error.statusCode = 400;
    throw error;
  }

  const trimmedUtr = (utr || '').trim();
  if (!UTR_REGEX.test(trimmedUtr)) {
    const error = new Error('Please enter a valid UTR / transaction reference number');
    error.statusCode = 400;
    throw error;
  }

  const lead = await DistributorLead.findById(bookingId);
  if (!lead) {
    const error = new Error('Booking not found');
    error.statusCode = 404;
    throw error;
  }

  if (lead.paymentMethod !== 'qr_self') {
    const error = new Error('This booking is not set up for QR payment submission');
    error.statusCode = 400;
    throw error;
  }

  if (lead.status === 'paid') {
    const error = new Error('This booking has already been paid for');
    error.statusCode = 400;
    throw error;
  }

  if (lead.status !== 'otp_verified') {
    const error = new Error('This booking is not in a state that accepts a UTR submission');
    error.statusCode = 400;
    throw error;
  }

  // Allow resubmission after a rejection, but not while one is already
  // pending or has been approved (approval should only ever happen once,
  // via the admin endpoint, which moves status to 'paid' anyway).
  if (lead.qrPayment?.reviewStatus === 'pending') {
    const error = new Error('A UTR is already submitted for this booking and is awaiting review');
    error.statusCode = 400;
    throw error;
  }
  if (lead.qrPayment?.reviewStatus === 'approved') {
    const error = new Error('This booking has already been approved');
    error.statusCode = 400;
    throw error;
  }

  // Refresh the lock to the longer review window before anything else, so
  // a slow admin queue doesn't risk losing the pincode mid-submission.
  try {
    await acquirePincodeLock({
      pincode: lead.pincode,
      bookingId: lead._id,
      durationMs: null,
    });
  } catch (err) {
    // Extremely unlikely at this stage (lead already owns the lock from
    // verifyOtp), but if the lock was somehow lost in the meantime, surface
    // that clearly rather than letting the UTR get submitted against a
    // pincode this lead no longer holds.
    const error = new Error('Your pincode reservation could not be extended. Please contact support.');
    error.statusCode = 409;
    throw error;
  }

  lead.status = 'lock_acquired';

  lead.qrPayment = {
    utr: trimmedUtr,
    submittedAt: new Date(),
    reviewStatus: 'pending',
  };

  try {
    await lead.save();
  } catch (err) {
    // Sparse unique index on qrPayment.utr — this is MongoDB's duplicate
    // key error, meaning someone already submitted this exact UTR before.
    if (err.code === 11000) {
      const error = new Error(
        'This transaction reference number has already been submitted. If you believe this is a mistake, please contact support.'
      );
      error.statusCode = 409;
      throw error;
    }
    throw err;
  }

  // TODO: notify the admin team that a new UTR is pending review — needs
  // email.service.js to wire up correctly, not adding a guessed call here.

  res.status(200).json({
    success: true,
    message: 'Your payment reference has been submitted and is pending verification.',
    data: { bookingId: lead._id, status: 'pending_review' },
  });
});

// POST /api/v1/distributor/verify-payment
// HLD Step 7a — client-side checkout callback. Optimistic, UX-only. NOT the
// source of truth (see razorpayWebhook below) — just lets the frontend show
// a success page immediately without waiting on the webhook round-trip.
export const verifyPayment = asyncHandler(async (req, res) => {
  const { bookingId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  if (!bookingId || !mongoose.isValidObjectId(bookingId)) {
    const error = new Error('Invalid bookingId');
    error.statusCode = 400;
    throw error;
  }

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    const error = new Error('Missing payment verification fields');
    error.statusCode = 400;
    throw error;
  }

  const isValid = verifyPaymentSignature({
    orderId: razorpay_order_id,
    paymentId: razorpay_payment_id,
    signature: razorpay_signature,
  });

  if (!isValid) {
    const error = new Error('Payment signature verification failed');
    error.statusCode = 400;
    throw error;
  }

  const { lockLost } = await markLeadPaid({
    bookingId,
    orderId: razorpay_order_id,
    paymentId: razorpay_payment_id,
    signature: razorpay_signature,
  });

  res.status(200).json({
    success: true,
    message: lockLost
      ? 'Payment received, but there was an issue with your pincode reservation. Our team will contact you shortly.'
      : 'Payment verified successfully',
    data: { bookingId, lockLost },
  });
});

// POST /api/v1/distributor/webhook/razorpay
// HLD Step 7b — the ACTUAL source of truth. Fires independently of what the
// browser does, so this is what catches the case where the user closes the
// tab right after paying and before the client-side redirect fires.
// Requires req.rawBody (raw Buffer, captured before JSON parsing) — see
// app.js instructions for the express.json({ verify }) change needed.
export const razorpayWebhook = asyncHandler(async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];

  if (!signature || !req.rawBody) {
    await WebhookLog.create({
      signatureValid: false,
      processingStatus: 'invalid_signature',
      processingNote: 'Missing signature header or raw body',
    });
    return res.status(400).json({ success: false, message: 'Missing signature or raw body' });
  }

  const isValid = verifyWebhookSignature(req.rawBody, signature);

  if (!isValid) {
    await WebhookLog.create({
      signatureValid: false,
      processingStatus: 'invalid_signature',
      payload: req.body,
      processingNote: 'Signature verification failed',
    });
    return res.status(400).json({ success: false, message: 'Invalid webhook signature' });
  }

  const event = req.body;
  const eventType = event.event;
  let relatedBookingId = null;
  let processingStatus = 'ignored';
  let processingNote = `Unhandled event type: ${eventType}`;

  if (eventType === 'payment.captured') {
    const payment = event.payload?.payment?.entity;
    const bookingId = payment?.notes?.bookingId;

    if (!bookingId || !mongoose.isValidObjectId(bookingId)) {
      processingStatus = 'error';
      processingNote = `payment.captured missing/invalid bookingId in notes (payment: ${payment?.id})`;
      console.error('❌', processingNote);
    } else {
      relatedBookingId = bookingId;
      try {
        const { lockLost } = await markLeadPaid({
          bookingId,
          orderId: payment.order_id,
          paymentId: payment.id,
        });
        processingStatus = 'processed';
        processingNote = lockLost
          ? 'Marked paid, but lock_lost (pincode was re-sold before webhook arrived)'
          : 'Marked paid successfully';
        if (lockLost) {
          console.warn(`⚠️  Booking ${bookingId} paid but lock_lost — flagged for manual outreach/refund.`);
        }
      } catch (err) {
        processingStatus = 'error';
        processingNote = `markLeadPaid threw: ${err.message}`;
        console.error('❌', processingNote);
      }
    }
  } else if (eventType === 'payment.failed') {
    const payment = event.payload?.payment?.entity;
    const bookingId = payment?.notes?.bookingId;

    if (bookingId && mongoose.isValidObjectId(bookingId)) {
      relatedBookingId = bookingId;
      await DistributorLead.findOneAndUpdate(
        { _id: bookingId, status: { $ne: 'paid' } },
        { $set: { status: 'failed', leadCallStatus: 'pending_call' } }
      );
      processingStatus = 'processed';
      processingNote = 'Marked failed';
    } else {
      processingStatus = 'ignored';
      processingNote = 'payment.failed with no bookingId in notes';
    }
  }

  await WebhookLog.create({
    eventType,
    razorpayEventId: event.id,
    signatureValid: true,
    payload: event,
    relatedBookingId,
    processingStatus,
    processingNote,
  });

  res.status(200).json({ success: true });
});
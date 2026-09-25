import PincodeMaster from '../models/PincodeMaster.js';
import PincodeReservation from '../models/PincodeReservation.js';
import DistributorLead from '../models/DistributorLead.js';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler.js';
import { generateOtp, hashOtp, compareOtp } from '../utils/otp.js';
import { checkOtpRateLimit, logOtpRequest } from '../utils/otpRateLimiter.js';
import { sendOtpEmail } from '../services/email.service.js';
import { acquirePincodeLock } from '../utils/pincodeLock.js';
import { sumPayments } from '../utils/distributorPayments.js';
import { DISTRIBUTOR_PLANS, isValidPlan, gstBreakdown, publicPlans } from '../config/distributorFees.js';
import { checkEmailValidity } from '../utils/emailVerification.js';
import { uploadFile } from '../services/s3.service.js';

const PINCODE_REGEX = /^\d{6}$/;
const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
const REQUIRED_CONSENTS = ['nonRefundable', 'terms', 'kyc', 'genuineMerchants', 'policyViolation'];
const MAX_OTP_ATTEMPTS = 5;
const OTP_VALIDITY_MS = 5 * 60 * 1000;
const UTR_REGEX = /^[A-Za-z0-9]{6,22}$/;

// Shared by the full-plan UTR submission and the booking plan's final
// payment — both collect the same KYC details. Returns the cleaned values or
// throws a 400.
const validateKyc = ({ panCard, aadhaarAddress, shopName, shopAddress }) => {
  const kyc = {
    panCard: (panCard || '').trim().toUpperCase(),
    aadhaarAddress: (aadhaarAddress || '').trim(),
    shopName: (shopName || '').trim(),
    shopAddress: (shopAddress || '').trim(),
  };

  if (!kyc.panCard || !kyc.aadhaarAddress || !kyc.shopName || !kyc.shopAddress) {
    const error = new Error('PAN card, Aadhaar address, shop name and shop address are required');
    error.statusCode = 400;
    throw error;
  }

  if (!PAN_REGEX.test(kyc.panCard)) {
    const error = new Error('Please enter a valid PAN card number (e.g. ABCDE1234F)');
    error.statusCode = 400;
    throw error;
  }

  return kyc;
};

const assertAadhaarUploaded = (lead) => {
  if (!lead.aadhaarFrontUrl || !lead.aadhaarBackUrl) {
    const error = new Error('Please upload both the front and back images of your Aadhaar card');
    error.statusCode = 400;
    throw error;
  }
};

const assertValidUtr = (utr) => {
  const trimmed = (utr || '').trim();
  if (!UTR_REGEX.test(trimmed)) {
    const error = new Error('Please enter a valid UTR / transaction reference number');
    error.statusCode = 400;
    throw error;
  }
  return trimmed;
};

// App-level UTR uniqueness across every place a UTR can live. payments[].utr
// can't carry a DB unique index (it's inside an array), so this is a
// query-then-insert check — the small race window is acceptable since every
// UTR is staff-reviewed before it moves any status.
const assertUtrUnused = async (utr) => {
  const used = await DistributorLead.findOne({
    $or: [{ 'qrPayment.utr': utr }, { 'payments.utr': utr }, { 'refund.utr': utr }],
  });
  if (used) {
    const error = new Error(
      'This transaction reference number has already been submitted. If you believe this is a mistake, please contact support.'
    );
    error.statusCode = 409;
    throw error;
  }
};

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
  const amountPaid = sumPayments(lead);
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

// POST /api/v1/distributor/existing-booking/upload-aadhaar
// Uploads a single Aadhaar image (front or back) and stores its R2 URL
// directly on the lead. Used by both KYC steps: the booking plan's final
// payment (lead 'paid') and the full plan before its only payment (lead
// 'otp_verified'). Deliberately separate from
// submitFinalUtr so the frontend can upload+preview each side immediately
// on file selection, rather than holding files in memory until final submit.
export const uploadAadhaarImage = asyncHandler(async (req, res) => {
  const { bookingId, side } = req.body;

  if (!bookingId || !mongoose.isValidObjectId(bookingId)) {
    const error = new Error('Invalid bookingId');
    error.statusCode = 400;
    throw error;
  }

  if (side !== 'front' && side !== 'back') {
    const error = new Error('side must be "front" or "back"');
    error.statusCode = 400;
    throw error;
  }

  if (!req.file) {
    const error = new Error('No image file was uploaded');
    error.statusCode = 400;
    throw error;
  }

  const lead = await DistributorLead.findById(bookingId);
  if (!lead || !['paid', 'otp_verified'].includes(lead.status)) {
    const error = new Error('This booking is not eligible for KYC upload');
    error.statusCode = 400;
    throw error;
  }

  const { publicUrl } = await uploadFile(
    req.file.buffer,
    req.file.originalname,
    req.file.mimetype,
    'distributor/aadhaar'
  );

  if (side === 'front') {
    lead.aadhaarFrontUrl = publicUrl;
  } else {
    lead.aadhaarBackUrl = publicUrl;
  }
  await lead.save();

  res.status(200).json({
    success: true,
    data: { bookingId: lead._id, side, url: publicUrl },
  });
});

// POST /api/v1/distributor/existing-booking/submit-final-utr
// QR/UTR final payment for the "Complete Payment for Existing PIN" flow.
// Mirrors submitUtr's pattern, but does NOT touch lead.status — per the
// confirmed rule, only an admin approving this UTR can move status to
// 'activated'. Submitting here just queues it for review.
export const submitFinalUtr = asyncHandler(async (req, res) => {
  const { bookingId, utr, referralCode } = req.body;

  if (!bookingId || !mongoose.isValidObjectId(bookingId)) {
    const error = new Error('Invalid bookingId');
    error.statusCode = 400;
    throw error;
  }

  const kyc = validateKyc(req.body);
  const trimmedUtr = assertValidUtr(utr);

  const lead = await DistributorLead.findById(bookingId);
  if (!lead || lead.status !== 'paid') {
    const error = new Error('This booking is not eligible for final payment');
    error.statusCode = 400;
    throw error;
  }

  assertAadhaarUploaded(lead);

  const pendingAmount = Math.max(0, (lead.totalDistributorFee || 0) - sumPayments(lead));
  if (pendingAmount <= 0) {
    const error = new Error('No pending amount remains for this booking');
    error.statusCode = 400;
    throw error;
  }

  // Block resubmission while an earlier final-UTR is still pending review.
  if (lead.payments.some((p) => p.stage === 'final' && p.status === 'pending')) {
    const error = new Error('A payment reference is already submitted for this booking and is awaiting review');
    error.statusCode = 400;
    throw error;
  }

  await assertUtrUnused(trimmedUtr);

  Object.assign(lead, kyc);
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
// taken here — that happens at UTR submission (submitUtr).
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

  const normalizedMobile = mobile.trim();

  // One distributor = one PIN code, for life. Checked on EITHER email or
  // mobile — blocks the obvious workaround of reusing one identifier with a
  // different other. Covers every state where this identity holds (or is
  // about to hold) a pincode: under review (lock_acquired), mid-checkout
  // (order_created), booked (paid) and activated. 'activated' was previously
  // missing here, which let an activated distributor book a second pincode.
  // Deliberately excludes refunded/cancelled/failed/expired (no pincode
  // held) and 'lock_lost' (paid but didn't end up with a pincode — handled
  // via manual outreach, and shouldn't be locked out while that's resolved).
  const existingLead = await DistributorLead.findOne({
    status: { $in: ['lock_acquired', 'order_created', 'paid', 'activated'] },
    $or: [{ email: normalizedEmail }, { mobile: normalizedMobile }],
  });

  if (existingLead) {
    const message = ['lock_acquired', 'order_created'].includes(existingLead.status)
      ? `You already have a pending PIN Code reservation (${existingLead.pincode}) awaiting approval. Please wait for it to be processed, or use a different email/mobile.`
      : `You have already reserved PIN Code ${existingLead.pincode}. Only one PIN Code reservation is allowed per distributor.`;
    const error = new Error(message);
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
  // ONLY while it hasn't progressed past OTP verification. Anything beyond
  // (lock_acquired, paid, activated, ...) must never be touched here, or a
  // stray resend could reset its status out from under an active pincode
  // lock. Terminal leads (refunded, cancelled, failed, expired, lock_lost)
  // aren't reused either — a returning user gets a fresh lead, so the old
  // one's payments[] ledger, qrPayment review state and refund record stay
  // intact and never leak into the new booking's amounts.
  let lead = await DistributorLead.findOne({
    email: normalizedEmail,
    pincode,
    status: { $in: ['form_submitted', 'otp_sent', 'otp_verified'] },
  });

  if (lead) {
    lead.name = name;
    lead.mobile = normalizedMobile;
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
      mobile: normalizedMobile,
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
      data: { bookingId: lead._id, paymentMode: 'qr_self', plans: publicPlans() },
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
  lead.paymentMethod = 'qr_self';
  await lead.save();

  res.status(200).json({
    success: true,
    message: 'OTP verified successfully',
    // paymentMode is always 'qr_self' now (Razorpay and manual mode are
    // retired) — kept in the response so the checkout's branch still works.
    // plans carries the live amounts so the frontend never hardcodes them.
    data: { bookingId: lead._id, paymentMode: 'qr_self', plans: publicPlans() },
  });
});

// POST /api/v1/distributor/submit-utr
// The customer picks a plan, pays the plan's first amount by scanning the
// static QR, then submits the UTR their UPI app showed them. This does NOT
// mark anything paid — it records a pending payments[] entry for admin
// review (approve/reject in distributorAdmin.controller.js).
//
// plan 'booking' (default): ₹1,180 now, ₹5,900 later → 'paid' on approval.
// plan 'full': ₹6,490 once, KYC + Aadhaar images required here first →
//   'activated' on approval.
//
// The pincode lock is taken here with NO expiry — only an admin decision
// (approve, reject, refund) ends it. The customer has already paid by this
// point, so if the pincode was taken in the meantime the UTR is still
// recorded (status 'lock_lost', call queue) for an agent to refund.
export const submitUtr = asyncHandler(async (req, res) => {
  const { bookingId, utr, plan = 'booking', referralCode } = req.body;

  if (!bookingId || !mongoose.isValidObjectId(bookingId)) {
    const error = new Error('Invalid bookingId');
    error.statusCode = 400;
    throw error;
  }

  if (!isValidPlan(plan)) {
    const error = new Error('Please choose a valid payment plan');
    error.statusCode = 400;
    throw error;
  }

  const trimmedUtr = assertValidUtr(utr);

  const lead = await DistributorLead.findById(bookingId);
  if (!lead) {
    const error = new Error('Booking not found');
    error.statusCode = 404;
    throw error;
  }

  if (lead.status !== 'otp_verified' || !lead.otpVerified) {
    const error = new Error('This booking is not in a state that accepts a UTR submission');
    error.statusCode = 400;
    throw error;
  }

  if (plan === 'full') {
    Object.assign(lead, validateKyc(req.body));
    lead.finalReferralCode = (referralCode || '').trim();
    assertAadhaarUploaded(lead);
  }

  await assertUtrUnused(trimmedUtr);

  const { total, firstStage, firstAmount } = DISTRIBUTOR_PLANS[plan];
  lead.plan = plan;
  lead.paymentMethod = 'qr_self';
  lead.totalDistributorFee = total;
  lead.gst = gstBreakdown(firstAmount);
  lead.payments.push({
    stage: firstStage,
    method: 'qr_self',
    amount: firstAmount,
    status: 'pending',
    utr: trimmedUtr,
  });

  try {
    await acquirePincodeLock({ pincode: lead.pincode, bookingId: lead._id, durationMs: null });
  } catch (err) {
    if (err.statusCode !== 409) throw err;

    lead.status = 'lock_lost';
    lead.lostReason = 'PIN Code was taken by another applicant before this UTR was submitted';
    lead.leadCallStatus = 'pending_call';
    await lead.save();

    const error = new Error(
      'Sorry, this PIN Code was just reserved by someone else. We have recorded your payment reference and our team will contact you about a refund.'
    );
    error.statusCode = 409;
    throw error;
  }

  lead.status = 'lock_acquired';
  await lead.save();

  // TODO: notify the admin team that a new UTR is pending review — needs
  // email.service.js to wire up correctly, not adding a guessed call here.

  res.status(200).json({
    success: true,
    message: 'Your payment reference has been submitted and is pending verification.',
    data: { bookingId: lead._id, plan, status: 'pending_review' },
  });
});

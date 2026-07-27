import PincodeMaster from '../models/PincodeMaster.js';
import PincodeReservation from '../models/PincodeReservation.js';
import DistributorLead from '../models/DistributorLead.js';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler.js';
import { generateOtp, hashOtp, compareOtp } from '../utils/otp.js';
import { checkOtpRateLimit, logOtpRequest } from '../utils/otpRateLimiter.js';
import { sendOtpEmail } from '../services/email.service.js';
import { acquirePincodeLock } from '../utils/pincodeLock.js';
import { markLeadPaid } from '../utils/paymentReconciliation.js';
import { createRazorpayOrder, verifyPaymentSignature, verifyWebhookSignature } from '../services/razorpay.service.js';
import { config } from '../config/environment.js';
import WebhookLog from '../models/WebhookLog.js';

const PINCODE_REGEX = /^\d{6}$/;
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
    } else if (reservation.status === 'locked' && reservation.expiresAt > new Date()) {
      // Someone else is mid-checkout right now. Not yet sold — softer message
      // than "already allotted", since it may free up shortly.
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
    $or: [{ status: 'confirmed' }, { status: 'locked', expiresAt: { $gt: now } }],
  }).select('pincode');

  const unavailableSet = new Set(unavailableReservations.map((r) => r.pincode));

  const suggestions = candidates
    .filter((c) => !unavailableSet.has(c.pincode))
    .slice(0, SUGGESTION_LIMIT)
    .map((c) => ({ pincode: c.pincode, district: c.district, state: c.statename }));

  res.status(200).json({ success: true, data: suggestions });
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
      data: { bookingId: lead._id, manualPayment: config.distributor.manualPaymentMode },
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

  // Lock the pincode immediately on successful verification, in BOTH modes —
  // previously this only happened inside createOrder. The frontend advances
  // straight from OTP-verify into the payment step anyway, so this just
  // closes a small race window, and lets manual-mode leads skip createOrder
  // entirely (they redirect to the "we'll call you" page instead).
  await acquirePincodeLock({ pincode: lead.pincode, bookingId: lead._id });
  lead.status = 'lock_acquired';

  if (config.distributor.manualPaymentMode) {
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
    data: { bookingId: lead._id, manualPayment: config.distributor.manualPaymentMode },
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
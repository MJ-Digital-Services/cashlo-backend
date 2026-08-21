import express from 'express';
import rateLimit from 'express-rate-limit';
import {
  checkPincode,
  sendOtp,
  verifyOtp,
  createOrder,
  verifyPayment,
  razorpayWebhook,
  getNearbyPincodes,
  submitUtr,
  findExistingBooking,
  sendExistingBookingOtp,
  verifyExistingBookingOtp,
  submitFinalUtr,
} from '../controllers/distributor.controller.js';

const router = express.Router();

// Layer 1 — generic per-IP flood guard on all /distributor/* routes.
const ipLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again shortly.' },
});

router.use(ipLimiter);

router.post('/check-pincode', checkPincode);
router.post('/send-otp', sendOtp);
router.post('/verify-otp', verifyOtp);
router.post('/create-order', createOrder);
router.post('/verify-payment', verifyPayment);
router.post('/submit-utr', submitUtr);
router.post('/nearby-pincodes', getNearbyPincodes);
router.post('/find-existing-booking', findExistingBooking);
router.post('/existing-booking/send-otp', sendExistingBookingOtp);
router.post('/existing-booking/verify-otp', verifyExistingBookingOtp);
router.post('/existing-booking/submit-final-utr', submitFinalUtr);

// Razorpay calls this directly — no user-facing rate limit concerns beyond
// the generic IP limiter above, which is generous enough for Razorpay's
// retry behavior.
router.post('/webhook/razorpay', razorpayWebhook);

// Next: reconciliation cron (HLD Step 8) — separate script, not a route.

export default router;
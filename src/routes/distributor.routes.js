import express from 'express';
import rateLimit from 'express-rate-limit';
import {
  checkPincode,
  sendOtp,
  verifyOtp,
  getNearbyPincodes,
  submitUtr,
  findExistingBooking,
  sendExistingBookingOtp,
  verifyExistingBookingOtp,
  uploadAadhaarImage,
  submitFinalUtr,
} from '../controllers/distributor.controller.js';
import { uploadImage } from '../middlewares/upload.js';

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
router.post('/submit-utr', submitUtr);
router.post('/nearby-pincodes', getNearbyPincodes);
router.post('/find-existing-booking', findExistingBooking);
router.post('/existing-booking/send-otp', sendExistingBookingOtp);
router.post('/existing-booking/verify-otp', verifyExistingBookingOtp);
router.post('/existing-booking/upload-aadhaar', uploadImage.single('image'), uploadAadhaarImage);
router.post('/existing-booking/submit-final-utr', submitFinalUtr);

export default router;
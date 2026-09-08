import OtpRequestLog from '../models/OtpRequestLog.js';

const MAX_PER_HOUR = 30;
const COOLDOWN_SECONDS = 45;

// Throws a 429 if this identifier (email, in our case) has hit the hourly cap
// or is still inside its resend cooldown. Call this BEFORE generating a new
// OTP; call logOtpRequest AFTER successfully sending it.
export const checkOtpRateLimit = async (identifier) => {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const recentCount = await OtpRequestLog.countDocuments({
    identifier,
    createdAt: { $gt: oneHourAgo },
  });

  if (recentCount >= MAX_PER_HOUR) {
    const error = new Error('Too many OTP requests. Please try again after some time.');
    error.statusCode = 429;
    throw error;
  }

  const last = await OtpRequestLog.findOne({ identifier }).sort({ createdAt: -1 });

  if (last) {
    const secondsSinceLast = (Date.now() - last.createdAt.getTime()) / 1000;
    if (secondsSinceLast < COOLDOWN_SECONDS) {
      const waitSeconds = Math.ceil(COOLDOWN_SECONDS - secondsSinceLast);
      const error = new Error(`Please wait ${waitSeconds}s before requesting another OTP.`);
      error.statusCode = 429;
      throw error;
    }
  }
};

export const logOtpRequest = (identifier) => OtpRequestLog.create({ identifier });
import dotenv from 'dotenv';
dotenv.config();

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: process.env.PORT || 5002,
  mongoUri: process.env.MONGODB_URI,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  r2: {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucketName: process.env.R2_BUCKET_NAME || 'cashlo-media',
    publicUrl: process.env.R2_PUBLIC_URL,
  },
  smtp: {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    fromName: process.env.SMTP_FROM_NAME || 'Cashlo',
  },
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID,
    keySecret: process.env.RAZORPAY_KEY_SECRET,
    // Configured separately in the Razorpay dashboard under Webhooks —
    // different secret than keySecret above. See HLD Section 4b.
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
  },
  distributor: {
    manualPaymentMode: process.env.DISTRIBUTOR_MANUAL_PAYMENT_MODE === 'true',
    // Self-serve QR + UTR flow. If both this and manualPaymentMode are set
    // true at once, qrPaymentMode wins (checked first in verifyOtp) — don't
    // run both simultaneously, pick one.
    qrPaymentMode: process.env.DISTRIBUTOR_QR_PAYMENT_MODE === 'true',
  },
};
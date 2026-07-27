import mongoose from 'mongoose';

const distributorLeadSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
    },
    mobile: {
      type: String,
      required: [true, 'Mobile number is required'],
      trim: true,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      trim: true,
      lowercase: true,
    },
    asmCode: {
      type: String,
      trim: true,
      default: '',
    },
    referralCode: {
      type: String,
      trim: true,
      default: '',
    },

    pincode: {
      type: String,
      required: [true, 'Pincode is required'],
      trim: true,
    },
    district: {
      type: String,
      trim: true,
      default: '',
    },
    state: {
      type: String,
      trim: true,
      default: '',
    },
    country: {
      type: String,
      trim: true,
      default: 'India',
    },

    consents: {
      nonRefundable: { type: Boolean, default: false },
      terms: { type: Boolean, default: false },
      kyc: { type: Boolean, default: false },
      genuineMerchants: { type: Boolean, default: false },
      policyViolation: { type: Boolean, default: false },
    },

    // select: false — OTP hash should never come back on a normal .find(),
    // only when explicitly requested during verification.
    otpHash: {
      type: String,
      select: false,
    },
    otpExpiresAt: Date,
    otpAttempts: {
      type: Number,
      default: 0,
    },
    otpVerified: {
      type: Boolean,
      default: false,
    },
    otpVerifiedAt: Date,

    status: {
      type: String,
      enum: [
        'form_submitted',
        'otp_sent',
        'otp_verified',
        'lock_acquired',
        'order_created',
        'paid',
        'failed',
        'expired',
        'cancelled',
        'lock_lost',
      ],
      default: 'form_submitted',
    },

    razorpay: {
      orderId: String,
      paymentId: String,
      signature: String,
      amount: Number, // paise
      currency: { type: String, default: 'INR' },
      receipt: String,
    },
    paymentMethod: {
      type: String,
      enum: ['razorpay', 'manual', 'qr_self'],
      default: 'razorpay',
    },

    manualPayment: {
      mode: { type: String, enum: ['cash', 'qr', 'bank_transfer', 'other'] },
      reference: { type: String, trim: true, default: '' },
      notes: { type: String, trim: true, default: '' },
      collectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      collectedAt: Date,
    },

    // Self-serve QR + UTR flow: customer scans a static QR, pays externally,
    // then submits the UTR themselves. Distinct from `manualPayment` above,
    // which is for admin-collected payments over a phone call. On approval,
    // this gets folded into `manualPayment` (mode: 'qr') so markLeadPaid()
    // and the receipt/email logic don't need to know this flow exists.
    qrPayment: {
      utr: { type: String, trim: true, default: '' },
      submittedAt: Date,
      reviewStatus: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
      },
      rejectionReason: { type: String, trim: true, default: '' },
      reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      reviewedAt: Date,
    },

    gst: {
      baseAmount: Number,
      gstAmount: Number,
      totalAmount: Number, // set explicitly by createOrder once a real order exists — never defaulted here
    },

    // For the admin "call this lead" queue — covers both ordinary payment
    // failures and the lock_lost edge case, distinguished by lostReason.
    leadCallStatus: {
      type: String,
      enum: ['not_required', 'pending_call', 'called', 'converted'],
      default: 'not_required',
    },
    receiptUrl: {
      type: String,
      default: '',
    },
    lostReason: {
      type: String,
      trim: true,
      default: '',
    },
  },
  { timestamps: true }
);

distributorLeadSchema.index({ email: 1 });
distributorLeadSchema.index({ mobile: 1 });
distributorLeadSchema.index({ pincode: 1 });
distributorLeadSchema.index({ status: 1 });
distributorLeadSchema.index({ leadCallStatus: 1 });
distributorLeadSchema.index({ 'razorpay.orderId': 1 });
// Sparse: only leads that actually submitted a UTR have this field, so the
// uniqueness constraint doesn't apply to (and reject) every other document
// that lacks one.
distributorLeadSchema.index(
  { 'qrPayment.utr': 1 },
  { unique: true, sparse: true }
);

export default mongoose.model('DistributorLead', distributorLeadSchema);
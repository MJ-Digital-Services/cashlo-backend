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
    // Captured separately on the final-payment step (submitFinalUtr) — kept
    // distinct from referralCode above (captured at initial form submission)
    // since they can legitimately differ and neither should overwrite the other.
    finalReferralCode: {
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

    // Collected on the final-payment step of the "Complete Payment for
    // Existing PIN" flow, before the final UTR is accepted.
    panCard: {
      type: String,
      trim: true,
      uppercase: true,
      default: '',
    },
    aadhaarAddress: {
      type: String,
      trim: true,
      default: '',
    },
    shopName: {
      type: String,
      trim: true,
      default: '',
    },
    shopAddress: {
      type: String,
      trim: true,
      default: '',
    },
    aadhaarFrontUrl: {
      type: String,
      trim: true,
      default: '',
    },
    aadhaarBackUrl: {
      type: String,
      trim: true,
      default: '',
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

    // Live flow: otp_sent → otp_verified → lock_acquired (UTR under review)
    // → paid (booking plan) → activated; or lock_acquired → activated (full
    // plan). Side exits: cancelled (payment rejected), refunded, lock_lost
    // (UTR submitted after the pincode was taken). form_submitted,
    // order_created, failed and expired are Razorpay-era values kept only
    // for old documents.
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
        'activated',
        'refunded',
      ],
      default: 'form_submitted',
    },

    // Which pricing plan this lead is on — see src/config/distributorFees.js.
    // Set at UTR submission. Leads from before plans existed have no value
    // and are treated as 'booking' (planOf()).
    plan: {
      type: String,
      enum: ['booking', 'full'],
    },
    // QR + UTR is the only payment method. 'razorpay' and 'manual' are kept
    // in the enum only so old documents still validate — nothing writes
    // them any more. No default: a lead has no payment method until it
    // verifies OTP.
    paymentMethod: {
      type: String,
      enum: ['razorpay', 'manual', 'qr_self'],
    },

    // LEGACY (read-only): admin-collected offline payments from the retired
    // manual mode, and QR approvals from before payments[] became the
    // source of truth. Nothing writes this any more.
    manualPayment: {
      mode: { type: String, enum: ['cash', 'qr', 'bank_transfer', 'other'] },
      reference: { type: String, trim: true, default: '' },
      notes: { type: String, trim: true, default: '' },
      collectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      collectedAt: Date,
    },

    // LEGACY (read-only except for review-status bookkeeping): booking-stage
    // UTRs submitted before payments[] became the single source of truth.
    // New submissions only write a payments[] entry. The sparse unique index
    // on qrPayment.utr below stays for these old records.
    qrPayment: {
      utr: { type: String, trim: true },
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
      totalAmount: Number,
    }, // breakdown of the first payment for this lead's plan (₹1,180 booking or ₹6,490 full)
    
    // Snapshot of the plan's total fee (₹7,080 booking plan / ₹6,490 full
    // plan), taken when the plan is chosen at UTR submission. Stored per-lead
    // so a future fee change never alters what an existing lead owes.
    totalDistributorFee: {
      type: Number, // paise, inclusive of GST
    },

    // Ledger of every payment across all stages — the single source of
    // truth. Each UTR submission adds a 'pending' entry that an admin
    // approves or rejects (src/utils/distributorPayments.js).
    // pendingAmount = totalDistributorFee - sum(success).
    payments: [
      {
        stage: { type: String, enum: ['booking', 'final', 'full'], required: true },
        method: { type: String, enum: ['razorpay', 'qr_self', 'manual'], required: true }, // only 'qr_self' is written now
        amount: { type: Number, required: true }, // paise
        status: { type: String, enum: ['pending', 'success', 'failed'], required: true },
        orderId: String,
        paymentId: String,
        utr: String,
        collectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        reviewedAt: Date,
        rejectionReason: { type: String, trim: true, default: '' },
        createdAt: { type: Date, default: Date.now },
      },
    ],

    // Set by the admin approval that activates the lead (final payment on
    // the booking plan, or the single payment on the full plan).
    activatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    activatedAt: Date,
    
    idCreated: {
      type: Boolean,
      default: false,
    },
    idCreatedRemark: {
      type: String,
      trim: true,
      default: '',
    },

    // Admin-marked refund. Only settable while idCreated is false — once an
    // ID is created downstream, refund is blocked entirely (see
    // markRefunded in distributorAdmin.controller.js). amount is NEVER
    // admin-entered — it's computed server-side from payments[] at the
    // moment of refund, so it always matches exactly what was collected.
    refund: {
      // 'bank_transfer' covers the original UTR-based flow; 'wallet' skips
      // UTR entirely (wallet refunds often have no formal reference number)
      // and requires paymentInfo instead — see markRefunded.
      method: { type: String, enum: ['bank_transfer', 'wallet'], default: 'bank_transfer' },
      utr: { type: String, trim: true }, // required only when method === 'bank_transfer'
      paymentInfo: { type: String, trim: true, default: '' }, // required only when method === 'wallet' — freeform, not UTR-format-validated
      remark: { type: String, trim: true, default: '' },
      amount: Number, // paise — sum of payments[] with status: 'success' at refund time
      previousStatus: { type: String, trim: true }, // 'paid' | 'activated' | 'lock_lost' — audit trail
      refundedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      refundedAt: Date,
    },

    // Separate OTP state for the "Complete Payment for Existing PIN" flow —
    // deliberately not reusing otpHash/otpExpiresAt/otpAttempts above, since
    // those belong to the original booking flow and a paid/activated lead
    // must never have that state disturbed.
    existingBookingOtpHash: {
      type: String,
      select: false,
    },
    existingBookingOtpExpiresAt: Date,
    existingBookingOtpAttempts: {
      type: Number,
      default: 0,
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
    activationReceiptUrl: {
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
// Sparse: only leads that actually submitted a UTR have this field, so the
// uniqueness constraint doesn't apply to (and reject) every other document
// that lacks one.
distributorLeadSchema.index(
  { 'qrPayment.utr': 1 },
  { unique: true, sparse: true }
);

// Same reasoning — only refunded leads have refund.utr, and the same UTR
// should never be usable for two different refunds.
distributorLeadSchema.index(
  { 'refund.utr': 1 },
  { unique: true, sparse: true }
);

export default mongoose.model('DistributorLead', distributorLeadSchema);
import mongoose from 'mongoose';

const invalidEmailSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
    },
    // Why QuickEmailVerification flagged it — useful for support/debugging,
    // and lets us distinguish 'invalid_email' from 'disposable_email' later.
    reason: {
      type: String,
      enum: ['invalid_email', 'disposable_email'],
      required: true,
    },
  },
  { timestamps: true }
);

// email already has a unique index from `unique: true` above — no extra
// index needed for the lookup itself.

export default mongoose.model('InvalidEmail', invalidEmailSchema);
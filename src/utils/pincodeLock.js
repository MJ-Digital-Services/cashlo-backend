import PincodeReservation from '../models/PincodeReservation.js';

const LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes
export const QR_REVIEW_LOCK_DURATION_MS = 48 * 60 * 60 * 1000; // 48 hours

export const acquirePincodeLock = async ({ pincode, bookingId, durationMs = LOCK_DURATION_MS }) => {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + durationMs);

  try {
    await PincodeReservation.create({ pincode, status: 'locked', bookingId, lockedAt: now, expiresAt });
    return;
  } catch (err) {
    if (err.code !== 11000) throw err;

    const existing = await PincodeReservation.findOne({ pincode });

    if (!existing) {
      return acquirePincodeLock({ pincode, bookingId });
    }

    if (existing.status === 'confirmed') {
      const error = new Error('This pincode has already been allotted to another distributor');
      error.statusCode = 409;
      error.reason = 'already_allotted';
      throw error;
    }

    if (existing.status === 'locked' && existing.expiresAt > now) {
      if (String(existing.bookingId) === String(bookingId)) {
        await PincodeReservation.findOneAndUpdate({ pincode, bookingId }, { $set: { expiresAt } });
        return;
      }

      const error = new Error('This pincode is currently being reserved by another user. Please try again shortly.');
      error.statusCode = 409;
      error.reason = 'temporarily_reserved';
      throw error;
    }

    const stolen = await PincodeReservation.findOneAndReplace(
      { pincode, status: 'locked', expiresAt: { $lt: now } },
      { pincode, status: 'locked', bookingId, lockedAt: now, expiresAt },
      { returnDocument: 'after' }
    );

    if (!stolen) {
      const error = new Error('This pincode just got reserved by someone else. Please try again.');
      error.statusCode = 409;
      error.reason = 'race_lost';
      throw error;
    }
  }
};

export const confirmPincodeLock = ({ pincode, bookingId }) =>
  PincodeReservation.findOneAndUpdate(
    { pincode, bookingId },
    { $set: { status: 'confirmed' }, $unset: { expiresAt: '' } }
  );
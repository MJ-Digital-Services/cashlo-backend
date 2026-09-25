import PincodeReservation from '../models/PincodeReservation.js';

const LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes

// durationMs: null → a lock with no expiresAt, which the TTL index never
// removes. That's what submitUtr uses: once a customer has paid and
// submitted a UTR, only an admin decision (approve / reject / refund) ends
// the lock.

export const acquirePincodeLock = async ({ pincode, bookingId, durationMs = LOCK_DURATION_MS }) => {
  const now = new Date();
  const expiresAt = durationMs == null ? undefined : new Date(now.getTime() + durationMs);

  try {
    const doc = { pincode, status: 'locked', bookingId, lockedAt: now };
    if (expiresAt) doc.expiresAt = expiresAt;
    await PincodeReservation.create(doc);
    return;
  } catch (err) {
    if (err.code !== 11000) throw err;

    const existing = await PincodeReservation.findOne({ pincode });

    if (!existing) {
      return acquirePincodeLock({ pincode, bookingId, durationMs }); // fix: pass durationMs through
    }

    if (existing.status === 'confirmed') {
      const error = new Error('This pincode has already been allotted to another distributor');
      error.statusCode = 409;
      error.reason = 'already_allotted';
      throw error;
    }

    const existingIsActive = existing.status === 'locked' && (!existing.expiresAt || existing.expiresAt > now);

    if (existingIsActive) {
      if (String(existing.bookingId) === String(bookingId)) {
        const update = expiresAt ? { $set: { expiresAt } } : { $unset: { expiresAt: '' } };
        await PincodeReservation.findOneAndUpdate({ pincode, bookingId }, update);
        return;
      }

      const error = new Error('This pincode is currently being reserved by another user. Please try again shortly.');
      error.statusCode = 409;
      error.reason = 'temporarily_reserved';
      throw error;
    }

    const replacement = { pincode, status: 'locked', bookingId, lockedAt: now };
    if (expiresAt) replacement.expiresAt = expiresAt;

    const stolen = await PincodeReservation.findOneAndReplace(
      { pincode, status: 'locked', expiresAt: { $lt: now } },
      replacement,
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
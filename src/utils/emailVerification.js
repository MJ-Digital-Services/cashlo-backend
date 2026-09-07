import InvalidEmail from '../models/InvalidEmail.js';
import { config } from '../config/environment.js';

const QEV_ENDPOINT = 'https://api.quickemailverification.com/v1/verify';
const QEV_TIMEOUT_MS = 4000; // don't let a slow/limited API stall signup

// Fails OPEN by design: any problem with QuickEmailVerification (limit
// exceeded, timeout, outage) means we skip the check and let the OTP
// flow proceed normally — this API should never be the reason Cashlo
// signups break.
export const checkEmailValidity = async (email) => {
  const normalizedEmail = email.trim().toLowerCase();

  // 1. Local block-list first — free, fast, no API credit spent.
  const alreadyKnownInvalid = await InvalidEmail.findOne({ email: normalizedEmail });
  if (alreadyKnownInvalid) {
    return { valid: false, reason: alreadyKnownInvalid.reason };
  }

  // 2. Call the API, with a hard timeout so a hung request can't block signup.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), QEV_TIMEOUT_MS);

  try {
    const url = `${QEV_ENDPOINT}?email=${encodeURIComponent(normalizedEmail)}&apikey=${config.quickEmailVerification.apiKey}`;
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      // Non-2xx (e.g. credits exhausted, key invalid) — skip check, proceed.
      console.error(`QuickEmailVerification returned ${response.status}, skipping check`);
      return { valid: true, skipped: true };
    }

    const data = await response.json();

    if (data.result === 'invalid' || data.disposable === 'true') {
      const reason = data.result === 'invalid' ? 'invalid_email' : 'disposable_email';

      // Best-effort save to block-list — don't let a DB hiccup here block
      // the actual rejection response to the user.
      InvalidEmail.create({ email: normalizedEmail, reason }).catch((err) =>
        console.error('Failed to save invalid email to block-list:', err.message)
      );

      return { valid: false, reason };
    }

    return { valid: true };
  } catch (err) {
    // Covers network errors, timeout/abort, and JSON parse failures.
    console.error('QuickEmailVerification check failed, allowing email through:', err.message);
    return { valid: true, skipped: true };
  } finally {
    clearTimeout(timeout);
  }
};
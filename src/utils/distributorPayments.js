import DistributorLead from '../models/DistributorLead.js';
import PincodeReservation from '../models/PincodeReservation.js';
import { acquirePincodeLock, confirmPincodeLock } from './pincodeLock.js';
import { DISTRIBUTOR_PLANS, planOf, gstBreakdown } from '../config/distributorFees.js';
import { generateReceiptPdfBuffer } from '../services/receipt.service.js';
import { uploadFile } from '../services/s3.service.js';
import { sendPaymentConfirmationEmail, sendDistributorActivationEmail } from '../services/email.service.js';

// All distributor money is collected by QR + customer-submitted UTR. Every
// submission is a `payments[]` entry with status 'pending'; an admin either
// approves or rejects that one entry. This module is the single place that
// happens — replaces the old markLeadPaid()/approveUtr/approveFinalUtr split.
//
// Stage → lead status required to act on it → status after approval:
//   booking: lock_acquired → paid
//   full:    lock_acquired → activated
//   final:   paid          → activated

const httpError = (message, statusCode) => Object.assign(new Error(message), { statusCode });

export const sumPayments = (lead, statuses = ['success']) =>
  (lead.payments || []).filter((p) => statuses.includes(p.status)).reduce((sum, p) => sum + p.amount, 0);

export const findPendingEntry = (lead) => (lead.payments || []).find((p) => p.status === 'pending');

// Leads whose booking UTR was submitted before this ledger-based flow only
// have lead.qrPayment (no payments[] entry). Fold that into a pending entry
// so they can be approved/rejected like any other.
const backfillLegacyPendingEntry = async (lead) => {
  if (findPendingEntry(lead) || lead.qrPayment?.reviewStatus !== 'pending') return;
  lead.payments.push({
    stage: 'booking',
    method: 'qr_self',
    amount: lead.gst?.totalAmount || DISTRIBUTOR_PLANS.booking.firstAmount,
    status: 'pending',
    utr: lead.qrPayment.utr,
    createdAt: lead.qrPayment.submittedAt,
  });
  await lead.save();
};

const RECEIPT_LABELS = {
  booking: 'PIN Code Reservation Fee (Booking)',
  full: 'Distributor Fee (Full Payment)',
  final: 'Distributor Activation Fee (Final Payment)',
};

const issueReceipt = async (lead, entry) => {
  try {
    const pdfBuffer = await generateReceiptPdfBuffer({
      bookingId: String(lead._id),
      name: lead.name,
      mobile: lead.mobile,
      email: lead.email,
      pincode: lead.pincode,
      district: lead.district,
      state: lead.state,
      ...gstBreakdown(entry.amount),
      lineItemLabel: RECEIPT_LABELS[entry.stage],
      paymentId: entry.utr || '—',
      orderId: `QR-${entry.stage.toUpperCase()}`,
      date: new Date().toISOString(),
    });
    const fileName = entry.stage === 'final' ? `activation-receipt-${lead._id}.pdf` : `receipt-${lead._id}.pdf`;
    const { publicUrl } = await uploadFile(pdfBuffer, fileName, 'application/pdf', 'receipts');
    return publicUrl;
  } catch (err) {
    console.error('❌ Failed to generate/upload receipt PDF:', err.message);
    return '';
  }
};

export const approvePendingPayment = async ({ leadId, adminId }) => {
  const lead = await DistributorLead.findById(leadId);
  if (!lead) throw httpError('Lead not found', 404);

  await backfillLegacyPendingEntry(lead);
  const entry = findPendingEntry(lead);
  if (!entry) throw httpError('There is no pending payment to approve for this lead', 400);

  const isFinal = entry.stage === 'final';
  const requiredStatus = isFinal ? 'paid' : 'lock_acquired';
  if (lead.status !== requiredStatus) {
    throw httpError(`A ${entry.stage} payment can only be approved while the lead is "${requiredStatus}" (currently "${lead.status}")`, 400);
  }

  // Booking/full approval is what makes the pincode permanent. The lock was
  // taken with no expiry at UTR submission, so this is normally just a
  // confirm; acquirePincodeLock is idempotent for the same bookingId and
  // re-takes it if it's somehow free. If another lead holds it, stop — the
  // admin should reject + refund rather than activate a pincode we don't own.
  if (!isFinal) {
    try {
      await acquirePincodeLock({ pincode: lead.pincode, bookingId: lead._id, durationMs: null });
    } catch (err) {
      if (err.statusCode === 409) {
        throw httpError('This PIN Code is held by another lead — reject this payment and refund instead', 409);
      }
      throw err;
    }
    await confirmPincodeLock({ pincode: lead.pincode, bookingId: lead._id });
  }

  const now = new Date();
  const nextStatus = entry.stage === 'booking' ? 'paid' : 'activated';
  const set = {
    'payments.$.status': 'success',
    'payments.$.reviewedBy': adminId,
    'payments.$.reviewedAt': now,
    status: nextStatus,
    leadCallStatus: 'not_required',
  };
  if (!isFinal) {
    const plan = planOf(lead);
    set.plan = plan;
    set.totalDistributorFee = lead.totalDistributorFee || DISTRIBUTOR_PLANS[plan].total;
  }
  if (nextStatus === 'activated') {
    set.activatedBy = adminId;
    set.activatedAt = now;
  }
  if (lead.qrPayment?.reviewStatus === 'pending') {
    set['qrPayment.reviewStatus'] = 'approved';
    set['qrPayment.reviewedBy'] = adminId;
    set['qrPayment.reviewedAt'] = now;
  }

  // Conditional on both the lead status and this exact entry still being
  // pending — two admins clicking approve at once can't both succeed.
  const updated = await DistributorLead.findOneAndUpdate(
    { _id: lead._id, status: requiredStatus, payments: { $elemMatch: { _id: entry._id, status: 'pending' } } },
    { $set: set },
    { returnDocument: 'after' }
  );
  if (!updated) throw httpError('This payment was already processed — refresh and try again', 409);

  const receiptUrl = await issueReceipt(updated, entry);
  if (receiptUrl) {
    if (isFinal) updated.activationReceiptUrl = receiptUrl;
    else updated.receiptUrl = receiptUrl;
    await updated.save();
  }

  if (entry.stage === 'booking') {
    await sendPaymentConfirmationEmail({
      to: updated.email,
      name: updated.name,
      pincode: updated.pincode,
      district: updated.district,
      state: updated.state,
      amount: entry.amount,
      paymentId: entry.utr,
      receiptUrl,
    });
  } else {
    await sendDistributorActivationEmail({
      to: updated.email,
      name: updated.name,
      pincode: updated.pincode,
      district: updated.district,
      state: updated.state,
      totalAmount: updated.totalDistributorFee ?? sumPayments(updated),
      receiptUrl,
    });
  }

  return updated;
};

export const rejectPendingPayment = async ({ leadId, adminId, reason }) => {
  const lead = await DistributorLead.findById(leadId);
  if (!lead) throw httpError('Lead not found', 404);

  await backfillLegacyPendingEntry(lead);
  const entry = findPendingEntry(lead);
  if (!entry) throw httpError('There is no pending payment to reject for this lead', 400);

  const isFinal = entry.stage === 'final';
  // lock_lost here = UTR submitted after someone else took the pincode; the
  // admin rejects it if the money never actually arrived.
  const allowedStatuses = isFinal ? ['paid'] : ['lock_acquired', 'lock_lost'];
  if (!allowedStatuses.includes(lead.status)) {
    throw httpError(`This payment can't be rejected while the lead is "${lead.status}"`, 400);
  }

  const now = new Date();
  const set = {
    'payments.$.status': 'failed',
    'payments.$.rejectionReason': reason,
    'payments.$.reviewedBy': adminId,
    'payments.$.reviewedAt': now,
  };
  // A rejected final payment leaves the lead 'paid' so the distributor keeps
  // their pincode and can resubmit. A rejected booking/full payment cancels
  // the lead and frees the pincode — the customer starts over, which creates
  // a fresh lead (sendOtp never reuses a cancelled one).
  if (!isFinal) {
    set.status = 'cancelled';
    set.leadCallStatus = 'pending_call';
  }
  if (lead.qrPayment?.reviewStatus === 'pending') {
    set['qrPayment.reviewStatus'] = 'rejected';
    set['qrPayment.rejectionReason'] = reason;
    set['qrPayment.reviewedBy'] = adminId;
    set['qrPayment.reviewedAt'] = now;
  }

  const updated = await DistributorLead.findOneAndUpdate(
    { _id: lead._id, status: lead.status, payments: { $elemMatch: { _id: entry._id, status: 'pending' } } },
    { $set: set },
    { returnDocument: 'after' }
  );
  if (!updated) throw httpError('This payment was already processed — refresh and try again', 409);

  if (!isFinal) {
    await PincodeReservation.findOneAndDelete({ pincode: lead.pincode, bookingId: lead._id, status: 'locked' });
  }

  return updated;
};

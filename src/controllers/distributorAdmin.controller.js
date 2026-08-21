import mongoose from 'mongoose';
import DistributorLead from '../models/DistributorLead.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import WebhookLog from '../models/WebhookLog.js';
import PincodeReservation from '../models/PincodeReservation.js';
import { markLeadPaid } from '../utils/paymentReconciliation.js';

const ALLOWED_CALL_STATUSES = ['not_required', 'pending_call', 'called', 'converted'];

// GET /api/v1/admin/distributor/leads?status=&leadCallStatus=&search=&page=&limit=
export const listLeads = asyncHandler(async (req, res) => {
  const { status, leadCallStatus, paymentMethod, search, startDate, endDate, page = 1, limit = 20 } = req.query;

  const filter = {};
  if (status) filter.status = status;
  if (leadCallStatus) filter.leadCallStatus = leadCallStatus;
  if (paymentMethod) filter.paymentMethod = paymentMethod;
  if (search) {
    filter.$or = [
      { name: new RegExp(search, 'i') },
      { email: new RegExp(search, 'i') },
      { mobile: new RegExp(search, 'i') },
      { pincode: new RegExp(search, 'i') },
      { 'qrPayment.utr': new RegExp(search, 'i') },
      { 'manualPayment.reference': new RegExp(search, 'i') },
    ];
  }

  if (startDate || endDate) {
    filter.createdAt = {};
    if (startDate) {
      const from = new Date(startDate);
      if (!isNaN(from)) filter.createdAt.$gte = from;
    }
    if (endDate) {
      const to = new Date(endDate);
      if (!isNaN(to)) {
        to.setHours(23, 59, 59, 999); // include the whole end day
        filter.createdAt.$lte = to;
      }
    }
    if (Object.keys(filter.createdAt).length === 0) delete filter.createdAt;
  }

  const skip = (Number(page) - 1) * Number(limit);

  const [leads, total] = await Promise.all([
    DistributorLead.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
    DistributorLead.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    data: leads,
    pagination: { page: Number(page), limit: Number(limit), total, pages: Math.ceil(total / Number(limit)) },
  });
});

// GET /api/v1/admin/distributor/leads/:id
export const getLead = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    const error = new Error('Invalid lead id');
    error.statusCode = 400;
    throw error;
  }

  const lead = await DistributorLead.findById(id);
  if (!lead) {
    const error = new Error('Lead not found');
    error.statusCode = 404;
    throw error;
  }

  res.status(200).json({ success: true, data: lead });
});

const MANUAL_PAYMENT_MODES = ['cash', 'qr', 'bank_transfer', 'other'];

// PATCH /api/v1/admin/distributor/leads/:id/mark-paid
// Manual-payment workaround only — sales collected payment outside Razorpay
// (QR/bank transfer/cash) and admin confirms it here.
export const markLeadPaidManually = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { mode, reference, notes } = req.body;

  if (!mongoose.isValidObjectId(id)) {
    const error = new Error('Invalid lead id');
    error.statusCode = 400;
    throw error;
  }

  if (!MANUAL_PAYMENT_MODES.includes(mode)) {
    const error = new Error(`mode must be one of: ${MANUAL_PAYMENT_MODES.join(', ')}`);
    error.statusCode = 400;
    throw error;
  }

  const existingLead = await DistributorLead.findById(id);
  if (!existingLead) {
    const error = new Error('Lead not found');
    error.statusCode = 404;
    throw error;
  }

  if (!(existingLead.status === 'lock_acquired' && existingLead.paymentMethod === 'manual') && existingLead.status !== 'lock_lost') {
    const error = new Error(`Cannot mark this lead as paid from its current state`);
    error.statusCode = 400;
    throw error;
  }

  const { lead, lockLost } = await markLeadPaid({
    bookingId: id,
    manualPayment: {
      mode,
      reference: reference || '',
      notes: notes || '',
      collectedBy: req.user._id,
      collectedAt: new Date(),
    },
    allowRelockIfFree: true,
  });

  res.status(200).json({
    success: true,
    message: lockLost
      ? 'Payment recorded, but this PIN Code was already taken by another distributor before confirmation. Please arrange a refund.'
      : 'Payment recorded and PIN Code confirmed for this distributor.',
    data: { lead, lockLost },
  });
});

// PATCH /api/v1/admin/distributor/leads/:id/approve-utr
// Approves a customer-submitted UTR from the self-serve QR flow. Reuses
// markLeadPaid() by passing the UTR through as a manualPayment record
// (mode: 'qr') — same reasoning as markLeadPaidManually below: keeps the
// receipt/email/lock-confirmation logic in exactly one place.
export const approveUtr = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    const error = new Error('Invalid lead id');
    error.statusCode = 400;
    throw error;
  }

  const existingLead = await DistributorLead.findById(id);
  if (!existingLead) {
    const error = new Error('Lead not found');
    error.statusCode = 404;
    throw error;
  }

  if (existingLead.paymentMethod !== 'qr_self') {
    const error = new Error('This lead did not use the QR self-payment flow');
    error.statusCode = 400;
    throw error;
  }

  if (existingLead.qrPayment?.reviewStatus !== 'pending') {
    const error = new Error('There is no pending UTR submission to approve for this lead');
    error.statusCode = 400;
    throw error;
  }

  existingLead.qrPayment.reviewStatus = 'approved';
  existingLead.qrPayment.reviewedBy = req.user._id;
  existingLead.qrPayment.reviewedAt = new Date();
  await existingLead.save();

  const { lead, lockLost } = await markLeadPaid({
    bookingId: id,
    manualPayment: {
      mode: 'qr',
      reference: existingLead.qrPayment.utr,
      notes: 'Self-submitted via website QR flow, approved by admin',
      collectedBy: req.user._id,
      collectedAt: new Date(),
    },
    allowRelockIfFree: true,
  });

  res.status(200).json({
    success: true,
    message: lockLost
      ? 'UTR approved, but this PIN Code was already taken by another distributor before confirmation. Please arrange a refund.'
      : 'UTR approved and PIN Code confirmed for this distributor.',
    data: { lead, lockLost },
  });
});

// PATCH /api/v1/admin/distributor/leads/:id/approve-final-utr
// Approves the final (activation) payment UTR for a lead already at
// status 'paid'. This is the ONLY way — besides self-service payment,
// once that's added — that a lead can move from 'paid' to 'activated'.
export const approveFinalUtr = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    const error = new Error('Invalid lead id');
    error.statusCode = 400;
    throw error;
  }

  const lead = await DistributorLead.findById(id);
  if (!lead) {
    const error = new Error('Lead not found');
    error.statusCode = 404;
    throw error;
  }

  if (lead.status !== 'paid') {
    const error = new Error('Only bookings with status "paid" can be activated');
    error.statusCode = 400;
    throw error;
  }

  const pendingEntry = lead.payments.find(
    (p) => p.stage === 'final' && p.status === 'pending'
  );

  if (!pendingEntry) {
    const error = new Error('There is no pending final payment submission to approve for this lead');
    error.statusCode = 400;
    throw error;
  }

  pendingEntry.status = 'success';
  pendingEntry.reviewedBy = req.user._id;
  pendingEntry.reviewedAt = new Date();

  lead.status = 'activated';
  lead.activatedBy = req.user._id;
  lead.activatedAt = new Date();

  await lead.save();

  res.status(200).json({
    success: true,
    message: 'Final payment approved. Distributor PIN Code is now activated.',
    data: lead,
  });
});

// PATCH /api/v1/admin/distributor/leads/:id/reject-final-utr
// Rejects a submitted final-payment UTR. Unlike rejectUtr (booking stage),
// this does NOT touch lead.status or any pincode lock — status stays 'paid'
// so the distributor keeps their PIN Code and can simply resubmit a
// corrected UTR via submitFinalUtr.
export const rejectFinalUtr = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  if (!mongoose.isValidObjectId(id)) {
    const error = new Error('Invalid lead id');
    error.statusCode = 400;
    throw error;
  }

  if (!reason || !reason.trim()) {
    const error = new Error('A rejection reason is required');
    error.statusCode = 400;
    throw error;
  }

  const lead = await DistributorLead.findById(id);
  if (!lead) {
    const error = new Error('Lead not found');
    error.statusCode = 404;
    throw error;
  }

  if (lead.status !== 'paid') {
    const error = new Error('This lead is not in a state that has a pending final payment to reject');
    error.statusCode = 400;
    throw error;
  }

  const pendingEntry = lead.payments.find(
    (p) => p.stage === 'final' && p.status === 'pending'
  );

  if (!pendingEntry) {
    const error = new Error('There is no pending final payment submission to reject for this lead');
    error.statusCode = 400;
    throw error;
  }

  pendingEntry.status = 'failed';
  pendingEntry.rejectionReason = reason.trim();
  pendingEntry.reviewedBy = req.user._id;
  pendingEntry.reviewedAt = new Date();

  await lead.save();

  res.status(200).json({ success: true, data: lead });
});

// PATCH /api/v1/admin/distributor/leads/:id/reject-utr
// Rejects a submitted UTR (couldn't be verified against the bank statement,
// wrong amount, etc). Routes the lead into the existing pending_call queue
// so a human follows up — doesn't touch booking status, so the lock (and
// the customer's ability to resubmit a corrected UTR via submitUtr) stays intact.
export const rejectUtr = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  if (!mongoose.isValidObjectId(id)) {
    const error = new Error('Invalid lead id');
    error.statusCode = 400;
    throw error;
  }

  if (!reason || !reason.trim()) {
    const error = new Error('A rejection reason is required');
    error.statusCode = 400;
    throw error;
  }

  const lead = await DistributorLead.findById(id);
  if (!lead) {
    const error = new Error('Lead not found');
    error.statusCode = 404;
    throw error;
  }

  if (lead.paymentMethod !== 'qr_self') {
    const error = new Error('This lead did not use the QR self-payment flow');
    error.statusCode = 400;
    throw error;
  }

  if (lead.qrPayment?.reviewStatus !== 'pending') {
    const error = new Error('There is no pending UTR submission to reject for this lead');
    error.statusCode = 400;
    throw error;
  }

  lead.qrPayment.reviewStatus = 'rejected';
  lead.qrPayment.rejectionReason = reason.trim();
  lead.qrPayment.reviewedBy = req.user._id;
  lead.qrPayment.reviewedAt = new Date();
  lead.leadCallStatus = 'pending_call';
  lead.status = 'cancelled';
  await PincodeReservation.findOneAndDelete({
    pincode: lead.pincode,
    bookingId: lead._id,
    status: 'locked',
  });
  await lead.save();

  res.status(200).json({ success: true, data: lead });
});

// PATCH /api/v1/admin/distributor/leads/:id/cancel
// Releases a pending_manual_payment lead that never converted, freeing the
// pincode for others. Only valid while still pending — once paid/lock_lost,
// use other flows (refund process, not cancellation).
export const cancelManualLead = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    const error = new Error('Invalid lead id');
    error.statusCode = 400;
    throw error;
  }

  const lead = await DistributorLead.findById(id);
  if (!lead) {
    const error = new Error('Lead not found');
    error.statusCode = 404;
    throw error;
  }

  if (!(lead.status === 'lock_acquired' && lead.paymentMethod === 'manual')) {
    const error = new Error(`Cannot cancel a lead in its current state`);
    error.statusCode = 400;
    throw error;
  }

  await PincodeReservation.findOneAndDelete({
    pincode: lead.pincode,
    bookingId: lead._id,
    status: 'locked',
  });

  lead.status = 'cancelled';
  lead.leadCallStatus = 'not_required';
  await lead.save();

  res.status(200).json({ success: true, data: lead });
});

// PATCH /api/v1/admin/distributor/leads/:id/call-status
// Deliberately narrow — only leadCallStatus can be changed here, never
// payment fields or the booking status itself, so this endpoint can't
// accidentally be used to fake a payment confirmation.
export const updateLeadCallStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { leadCallStatus } = req.body;

  if (!mongoose.isValidObjectId(id)) {
    const error = new Error('Invalid lead id');
    error.statusCode = 400;
    throw error;
  }

  if (!ALLOWED_CALL_STATUSES.includes(leadCallStatus)) {
    const error = new Error(`leadCallStatus must be one of: ${ALLOWED_CALL_STATUSES.join(', ')}`);
    error.statusCode = 400;
    throw error;
  }

  const lead = await DistributorLead.findOneAndUpdate(
    { _id: id },
    { $set: { leadCallStatus } },
    { returnDocument: 'after' }
  );

  if (!lead) {
    const error = new Error('Lead not found');
    error.statusCode = 404;
    throw error;
  }

  res.status(200).json({ success: true, data: lead });
});

// GET /api/v1/admin/distributor/webhook-logs?bookingId=&page=&limit=
export const listWebhookLogs = asyncHandler(async (req, res) => {
  const { bookingId, page = 1, limit = 20 } = req.query;
  const filter = {};
  if (bookingId) filter.relatedBookingId = bookingId;

  const skip = (Number(page) - 1) * Number(limit);
  const [logs, total] = await Promise.all([
    WebhookLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
    WebhookLog.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    data: logs,
    pagination: { page: Number(page), limit: Number(limit), total, pages: Math.ceil(total / Number(limit)) },
  });
});
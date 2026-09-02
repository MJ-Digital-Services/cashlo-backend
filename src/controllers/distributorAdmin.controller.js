import mongoose from 'mongoose';
import DistributorLead from '../models/DistributorLead.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import WebhookLog from '../models/WebhookLog.js';
import PincodeReservation from '../models/PincodeReservation.js';
import { markLeadPaid } from '../utils/paymentReconciliation.js';
import { sendDistributorActivationEmail } from '../services/email.service.js';
import { generateReceiptPdfBuffer } from '../services/receipt.service.js';
import { uploadFile } from '../services/s3.service.js';

const ALLOWED_CALL_STATUSES = ['not_required', 'pending_call', 'called', 'converted'];

// startDate/endDate come from the admin UI as plain "YYYY-MM-DD" strings
// meant to represent an IST calendar day (all leads are IST-timezone
// users). `new Date("YYYY-MM-DD")` parses as UTC midnight, which is WRONG
// for IST — IST is UTC+5:30, so IST midnight is actually 18:30 UTC the
// previous day. Without this correction, anything created between
// 00:00–05:29 IST gets bucketed into the previous UTC day and silently
// excluded from "today" filters.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istDayStartUtc(dateStr) {
  const utcMidnight = new Date(`${dateStr}T00:00:00.000Z`);
  if (isNaN(utcMidnight)) return null;
  return new Date(utcMidnight.getTime() - IST_OFFSET_MS);
}

function istDayEndUtc(dateStr) {
  const start = istDayStartUtc(dateStr);
  if (!start) return null;
  return new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
}

function buildLeadsFilter(query) {
  const { status, leadCallStatus, paymentMethod, search, startDate, endDate } = query;

  const filter = {};
  if (status) filter.status = status;
  if (leadCallStatus) filter.leadCallStatus = leadCallStatus;
  if (paymentMethod) filter.paymentMethod = paymentMethod;
  if (query.pendingFinalReview === 'true') {
    filter.status = 'paid';
    filter.payments = { $elemMatch: { stage: 'final', status: 'pending' } };
  }
  if (query.pendingBookingReview === 'true') {
    filter.paymentMethod = 'qr_self';
    filter['qrPayment.reviewStatus'] = 'pending';
  }
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
      const from = istDayStartUtc(startDate);
      if (from) filter.createdAt.$gte = from;
    }
    if (endDate) {
      const to = istDayEndUtc(endDate);
      if (to) filter.createdAt.$lte = to;
    }
    if (Object.keys(filter.createdAt).length === 0) delete filter.createdAt;
  }

  return filter;
}

// GET /api/v1/admin/distributor/leads?status=&leadCallStatus=&search=&page=&limit=
export const listLeads = asyncHandler(async (req, res) => {
  const {
    status,
    leadCallStatus,
    paymentMethod,
    search,
    startDate,
    endDate,
    page = 1,
    limit = 20,
    sortBy = 'createdAt',
    sortOrder = 'desc',
  } = req.query;

  // Whitelisted to prevent arbitrary field sort injection via query string.
  const SORTABLE_FIELDS = ['createdAt', 'updatedAt', 'name', 'status', 'pincode'];
  const SORT_FIELD = SORTABLE_FIELDS.includes(sortBy) ? sortBy : 'createdAt';
  const SORT_DIR = sortOrder === 'asc' ? 1 : -1;

  const filter = buildLeadsFilter(req.query);

  const skip = (Number(page) - 1) * Number(limit);

  const [leads, total] = await Promise.all([
    DistributorLead.find(filter).sort({ [SORT_FIELD]: SORT_DIR }).skip(skip).limit(Number(limit)),
    DistributorLead.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    data: leads,
    pagination: { page: Number(page), limit: Number(limit), total, pages: Math.ceil(total / Number(limit)) },
  });
});

// GET /api/v1/admin/distributor/leads/export?status=&leadCallStatus=&search=&startDate=&endDate=...
// Same filters as listLeads, no pagination — streams every matching lead as CSV.
const CSV_COLUMNS = [
  { header: 'Name', get: (l) => l.name },
  { header: 'Mobile', get: (l) => l.mobile },
  { header: 'Email', get: (l) => l.email },
  { header: 'Pincode', get: (l) => l.pincode },
  { header: 'District', get: (l) => l.district },
  { header: 'State', get: (l) => l.state },
  { header: 'Status', get: (l) => l.status },
  { header: 'Call Status', get: (l) => l.leadCallStatus },
  { header: 'Payment Method', get: (l) => l.paymentMethod || '' },
  { header: 'Total Distributor Fee', get: (l) => (l.totalDistributorFee != null ? l.totalDistributorFee / 100 : '') },
  { header: 'Shop Name', get: (l) => l.shopName || '' },
  { header: 'Shop Address', get: (l) => l.shopAddress || '' },
  { header: 'Aadhaar Address', get: (l) => l.aadhaarAddress || '' },
  { header: 'Created At', get: (l) => l.createdAt?.toISOString?.() || '' },
  { header: 'Updated At', get: (l) => l.updatedAt?.toISOString?.() || '' },
];

function csvEscape(value) {
  const str = value == null ? '' : String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export const exportLeads = asyncHandler(async (req, res) => {
  const { sortBy = 'createdAt', sortOrder = 'desc' } = req.query;
  const SORTABLE_FIELDS = ['createdAt', 'updatedAt', 'name', 'status', 'pincode'];
  const SORT_FIELD = SORTABLE_FIELDS.includes(sortBy) ? sortBy : 'createdAt';
  const SORT_DIR = sortOrder === 'asc' ? 1 : -1;

  const filter = buildLeadsFilter(req.query);

  const leads = await DistributorLead.find(filter).sort({ [SORT_FIELD]: SORT_DIR });

  const headerRow = CSV_COLUMNS.map((c) => csvEscape(c.header)).join(',');
  const rows = leads.map((lead) => CSV_COLUMNS.map((c) => csvEscape(c.get(lead))).join(','));
  const csv = [headerRow, ...rows].join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="distributor-leads-${Date.now()}.csv"`);
  res.status(200).send(csv);
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

  let activationReceiptUrl = '';
  try {
    const pdfBuffer = await generateReceiptPdfBuffer({
      bookingId: String(lead._id),
      name: lead.name,
      mobile: lead.mobile,
      email: lead.email,
      pincode: lead.pincode,
      district: lead.district,
      state: lead.state,
      includeGstBreakdown: false,
      lineItemLabel: 'Distributor Activation Fee (Final Payment)',
      totalAmount: pendingEntry.amount,
      paymentId: pendingEntry.utr || 'Final Payment',
      orderId: `FINAL-${(pendingEntry.method || 'qr_self').toUpperCase()}`,
      date: new Date().toISOString(),
    });

    const uploaded = await uploadFile(
      pdfBuffer,
      `activation-receipt-${lead._id}.pdf`,
      'application/pdf',
      'receipts'
    );
    activationReceiptUrl = uploaded.publicUrl;
    lead.activationReceiptUrl = activationReceiptUrl;
    await lead.save();
  } catch (err) {
    console.error('❌ Failed to generate/upload activation receipt PDF:', err.message);
  }

  await sendDistributorActivationEmail({
    to: lead.email,
    name: lead.name,
    pincode: lead.pincode,
    district: lead.district,
    state: lead.state,
    totalAmount: lead.totalDistributorFee ?? pendingEntry.amount,
    receiptUrl: activationReceiptUrl,
  });

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
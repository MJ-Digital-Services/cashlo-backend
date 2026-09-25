import mongoose from 'mongoose';
import DistributorLead from '../models/DistributorLead.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import PincodeReservation from '../models/PincodeReservation.js';
import { sendDistributorRefundEmail } from '../services/email.service.js';
import { approvePendingPayment, rejectPendingPayment, sumPayments } from '../utils/distributorPayments.js';

const ALLOWED_CALL_STATUSES = ['not_required', 'pending_call', 'called', 'converted'];
const REFUND_UTR_REGEX = /^[A-Za-z0-9]{6,22}$/;
const REFUND_ELIGIBLE_STATUSES = ['paid', 'activated', 'lock_lost'];

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
  const { status, leadCallStatus, paymentMethod, plan, search, startDate, endDate } = query;

  const filter = {};
  if (status) filter.status = status;
  if (leadCallStatus) filter.leadCallStatus = leadCallStatus;
  if (paymentMethod) filter.paymentMethod = paymentMethod;
  // Leads from before plans existed have no `plan` — they're booking-plan.
  if (plan === 'booking') filter.plan = { $in: ['booking', null] };
  if (plan === 'full') filter.plan = 'full';
  if (query.pendingFinalReview === 'true') {
    filter.status = 'paid';
    filter.payments = { $elemMatch: { stage: 'final', status: 'pending' } };
  }
  // Every lock_acquired lead has a booking or full-plan UTR awaiting review
  // (QR is the only payment method, and lock_acquired is only set by
  // submitUtr) — including legacy leads whose UTR lives on qrPayment.
  if (query.pendingBookingReview === 'true') {
    filter.status = 'lock_acquired';
  }
  if (query.pendingIdCreation === 'true') {
    filter.status = 'activated';
    filter.idCreated = { $ne: true };
  }
  if (query.idCreated === 'true') {
    filter.status = 'activated';
    filter.idCreated = true;
  }
  if (query.refunded === 'true') {
    filter.status = 'refunded';
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

  // Pending ID creation and refund views scan the entire backlog, not just
  // a date window — strip any date filter regardless of what the client sent.
  if (query.pendingIdCreation === 'true' || query.idCreated === 'true' || query.refunded === 'true') {
    delete filter.createdAt;
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
  { header: 'Plan', get: (l) => (l.plan === 'full' ? 'Full' : 'Booking') },
  { header: 'Payment Method', get: (l) => l.paymentMethod || '' },
  { header: 'Total Distributor Fee', get: (l) => (l.totalDistributorFee != null ? l.totalDistributorFee / 100 : '') },
  { header: 'Shop Name', get: (l) => l.shopName || '' },
  { header: 'Shop Address', get: (l) => l.shopAddress || '' },
  { header: 'Aadhaar Address', get: (l) => l.aadhaarAddress || '' },
  { header: 'Final Referral Code', get: (l) => l.finalReferralCode || '' },
  { header: 'Refund Status', get: (l) => (l.status === 'refunded' ? 'Refunded' : '') },
  { header: 'Refund Amount', get: (l) => (l.refund?.amount != null ? l.refund.amount / 100 : '') },
  { header: 'Refund UTR', get: (l) => l.refund?.utr || '' },
  { header: 'Refund Remark', get: (l) => l.refund?.remark || '' },
  { header: 'Refunded At', get: (l) => l.refund?.refundedAt?.toISOString?.() || '' },
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

// PATCH /api/v1/admin/distributor/leads/:id/approve-payment
// Approves the lead's single pending payments[] entry, whatever its stage:
// booking → 'paid', full or final → 'activated'. See distributorPayments.js.
export const approvePayment = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    const error = new Error('Invalid lead id');
    error.statusCode = 400;
    throw error;
  }

  const lead = await approvePendingPayment({ leadId: id, adminId: req.user._id });

  res.status(200).json({
    success: true,
    message: lead.status === 'activated'
      ? 'Payment approved. Distributor PIN Code is now activated.'
      : 'Payment approved and PIN Code confirmed for this distributor.',
    data: lead,
  });
});

// PATCH /api/v1/admin/distributor/leads/:id/reject-payment
// Rejects the lead's pending payment. Booking/full → lead 'cancelled' and
// pincode released; final → lead stays 'paid' and can resubmit.
export const rejectPayment = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const reason = (req.body.reason || '').trim();

  if (!mongoose.isValidObjectId(id)) {
    const error = new Error('Invalid lead id');
    error.statusCode = 400;
    throw error;
  }

  if (!reason) {
    const error = new Error('A rejection reason is required');
    error.statusCode = 400;
    throw error;
  }

  const lead = await rejectPendingPayment({ leadId: id, adminId: req.user._id, reason });

  res.status(200).json({ success: true, data: lead });
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

// PATCH /api/v1/admin/distributor/leads/:id/mark-refunded
// Admin-only manual refund marker — no payment gateway integration, this
// just records that money was returned outside the system (bank transfer,
// UPI, wallet, etc). Only allowed while idCreated is false: once a
// distributor ID exists downstream, refund is permanently blocked here —
// same one-way reasoning as idCreated itself. Releases the pincode
// reservation (locked or confirmed) so it becomes bookable by someone else
// again.
// body.method: 'wallet' switches the requirement from a formal UTR (wallet
// refunds often don't have one) to a freeform paymentInfo note instead.
export const markRefunded = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { utr, paymentInfo, remark } = req.body;
  const isWalletRefund = req.body.method === 'wallet';

  if (!mongoose.isValidObjectId(id)) {
    const error = new Error('Invalid lead id');
    error.statusCode = 400;
    throw error;
  }

  const trimmedUtr = (utr || '').trim();
  const trimmedPaymentInfo = (paymentInfo || '').trim();
  const trimmedRemark = (remark || '').trim();

  if (isWalletRefund) {
    if (!trimmedPaymentInfo) {
      const error = new Error('Payment information is required for a wallet refund');
      error.statusCode = 400;
      throw error;
    }
    // A UTR is optional here, but if the admin did supply one, still hold
    // it to the same format so it stays meaningful for the uniqueness check.
    if (trimmedUtr && !REFUND_UTR_REGEX.test(trimmedUtr)) {
      const error = new Error('The UTR / transaction reference number entered is not valid');
      error.statusCode = 400;
      throw error;
    }
  } else if (!trimmedUtr || !REFUND_UTR_REGEX.test(trimmedUtr)) {
    const error = new Error('A valid UTR / transaction reference number is required for refund');
    error.statusCode = 400;
    throw error;
  }

  if (!trimmedRemark) {
    const error = new Error('A remark is required to mark this lead as refunded');
    error.statusCode = 400;
    throw error;
  }

  const lead = await DistributorLead.findById(id);
  if (!lead) {
    const error = new Error('Lead not found');
    error.statusCode = 404;
    throw error;
  }

  if (lead.idCreated) {
    const error = new Error('This lead already has a distributor ID created — refund is no longer possible');
    error.statusCode = 400;
    throw error;
  }

  if (lead.status === 'refunded') {
    const error = new Error('This lead has already been refunded');
    error.statusCode = 400;
    throw error;
  }

  if (!REFUND_ELIGIBLE_STATUSES.includes(lead.status)) {
    const error = new Error(
      `Only leads with status ${REFUND_ELIGIBLE_STATUSES.join(', ')} are eligible for refund`
    );
    error.statusCode = 400;
    throw error;
  }

  // App-level uniqueness check across every place a UTR can live — same
  // reasoning as submitUtr/submitFinalUtr, since refund.utr can't carry a
  // meaningful unique constraint check any other way before the save-time
  // sparse index catches a true race. Skipped entirely for a wallet refund
  // with no UTR supplied — nothing to collide with.
  if (trimmedUtr) {
    const utrAlreadyUsed = await DistributorLead.findOne({
      $or: [
        { 'qrPayment.utr': trimmedUtr },
        { 'payments.utr': trimmedUtr },
        { 'refund.utr': trimmedUtr },
      ],
    });
    if (utrAlreadyUsed) {
      const error = new Error(
        'This transaction reference number has already been used elsewhere. If you believe this is a mistake, please contact support.'
      );
      error.statusCode = 409;
      throw error;
    }
  }

  // A 'lock_lost' lead's pending entry is the payment being refunded (UTR
  // submitted after the pincode was taken — the agent has confirmed the
  // money arrived by refunding it). Anywhere else, a pending payment must be
  // approved or rejected first, or the refund amount would silently exclude
  // money the customer may have actually paid.
  const isLockLost = lead.status === 'lock_lost';
  if (!isLockLost && lead.payments.some((p) => p.status === 'pending')) {
    const error = new Error('This lead has a payment awaiting review — approve or reject it before refunding');
    error.statusCode = 400;
    throw error;
  }

  // Refund amount is always derived from the ledger, never admin-entered —
  // guarantees it matches exactly what was actually collected.
  const refundAmount = sumPayments(lead, isLockLost ? ['success', 'pending'] : ['success']);

  if (refundAmount <= 0) {
    const error = new Error('No successful payment was found on this lead to refund');
    error.statusCode = 400;
    throw error;
  }

  if (isLockLost) {
    for (const p of lead.payments) {
      if (p.status !== 'pending') continue;
      p.status = 'success';
      p.reviewedBy = req.user._id;
      p.reviewedAt = new Date();
    }
  }

  const previousStatus = lead.status;

  lead.refund = {
    method: isWalletRefund ? 'wallet' : 'bank_transfer',
    utr: trimmedUtr || undefined,
    paymentInfo: isWalletRefund ? trimmedPaymentInfo : '',
    remark: trimmedRemark,
    amount: refundAmount,
    previousStatus,
    refundedBy: req.user._id,
    refundedAt: new Date(),
  };
  lead.status = 'refunded';
  lead.leadCallStatus = 'not_required';

  try {
    await lead.save();
  } catch (err) {
    if (err.code === 11000) {
      const error = new Error(
        'This transaction reference number has already been used elsewhere. If you believe this is a mistake, please contact support.'
      );
      error.statusCode = 409;
      throw error;
    }
    throw err;
  }

  // Release the pincode — whether it was still 'locked' (e.g. a lock_lost
  // lead refunded before ever confirming) or 'confirmed' (paid/activated).
  // No status filter here deliberately, unlike rejectPendingPayment's
  // narrower delete, since a refund can legitimately happen from either
  // lock state. Scoped to this bookingId, so a lock_lost lead never deletes
  // the reservation of the lead that actually holds the pincode.
  await PincodeReservation.findOneAndDelete({
    pincode: lead.pincode,
    bookingId: lead._id,
  });

  await sendDistributorRefundEmail({
    to: lead.email,
    name: lead.name,
    pincode: lead.pincode,
    district: lead.district,
    state: lead.state,
    amount: refundAmount,
    method: lead.refund.method,
    utr: trimmedUtr,
    paymentInfo: trimmedPaymentInfo,
  });

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

// PATCH /api/v1/admin/distributor/leads/:id/id-created
// Deliberately narrow, same reasoning as updateLeadCallStatus above — only
// idCreated can be changed here. Only allowed once the lead is 'activated'
// (i.e. final payment has been approved), since the distributor ID is
// created manually in another application only after that point.
export const updateIdCreated = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { idCreated, remark } = req.body;

  if (!mongoose.isValidObjectId(id)) {
    const error = new Error('Invalid lead id');
    error.statusCode = 400;
    throw error;
  }

  if (typeof idCreated !== 'boolean') {
    const error = new Error('idCreated must be a boolean');
    error.statusCode = 400;
    throw error;
  }

  const lead = await DistributorLead.findById(id);
  if (!lead) {
    const error = new Error('Lead not found');
    error.statusCode = 404;
    throw error;
  }

  if (lead.status !== 'activated') {
    const error = new Error('idCreated can only be set once this lead is activated');
    error.statusCode = 400;
    throw error;
  }

  if (lead.idCreated && !idCreated) {
    const error = new Error('idCreated cannot be reverted once set — this action is one-time only');
    error.statusCode = 400;
    throw error;
  }

  // Remark is only required when actually marking as created (true) — not
  // meaningful/required for any other call shape, though in practice this
  // endpoint is only ever called with true given the one-way lock above.
  if (idCreated) {
    const trimmedRemark = (remark || '').trim();
    if (!trimmedRemark) {
      const error = new Error('A remark is required when marking this lead as ID created');
      error.statusCode = 400;
      throw error;
    }
    lead.idCreatedRemark = trimmedRemark;
  }

  lead.idCreated = idCreated;
  await lead.save();

  res.status(200).json({ success: true, data: lead });
});
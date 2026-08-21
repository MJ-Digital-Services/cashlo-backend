import DistributorLead from '../models/DistributorLead.js';
import PincodeReservation from '../models/PincodeReservation.js';
import { acquirePincodeLock, confirmPincodeLock } from './pincodeLock.js';
import { sendPaymentConfirmationEmail } from '../services/email.service.js';
import { generateReceiptPdfBuffer } from '../services/receipt.service.js';
import { uploadFile } from '../services/s3.service.js';

// ₹7,080 — current commercial value for full distributor activation.
// Snapshotted onto the lead at booking-payment time (not read live) so a
// future fee change never alters what an already-paid distributor owes.
const TOTAL_DISTRIBUTOR_FEE_PAISE = 708000;

// allowRelockIfFree: only ever passed as true from the manual "mark as paid"
// admin action (see distributorAdmin.controller.js). Razorpay's own webhook
// and reconciliation cron never pass this — their timing is tight enough
// (minutes, not hours) that this scenario isn't worth the extra behavior
// change there, and we don't want to touch that path's semantics.
export const markLeadPaid = async ({
  bookingId,
  orderId,
  paymentId,
  signature,
  manualPayment,
  allowRelockIfFree = false,
}) => {
  const setFields = { status: 'paid', leadCallStatus: 'not_required' };
  if (orderId) setFields['razorpay.orderId'] = orderId;
  if (paymentId) setFields['razorpay.paymentId'] = paymentId;
  if (signature) setFields['razorpay.signature'] = signature;
  if (manualPayment) {
    setFields.manualPayment = manualPayment;
    setFields.paymentMethod = 'manual';
  }

  // Snapshot the full distributor fee + record this as the booking-stage
  // payment entry, the moment a lead first becomes paid. Without this,
  // the "Complete Payment for Existing PIN" flow has no baseline to
  // calculate the pending balance from (see distributor.controller.js
  // findExistingBooking / verifyExistingBookingOtp).
  setFields.totalDistributorFee = TOTAL_DISTRIBUTOR_FEE_PAISE;

  const lead = await DistributorLead.findOneAndUpdate(
    { _id: bookingId, status: { $ne: 'paid' } },
    { $set: setFields },
    { returnDocument: 'after' }
  );

  if (!lead) return { lead: null, lockLost: false };

  // Record the booking-stage payment in the ledger — same data source used
  // by the old migration script, just done live now instead of backfilled.
  const bookingAmount = lead.razorpay?.amount || lead.gst?.totalAmount || 0;
  const bookingMethod =
    lead.paymentMethod === 'qr_self' ? 'qr_self' : lead.paymentMethod === 'manual' ? 'manual' : 'razorpay';

  lead.payments.push({
    stage: 'booking',
    method: bookingMethod,
    amount: bookingAmount,
    status: 'success',
    orderId: lead.razorpay?.orderId,
    paymentId: lead.razorpay?.paymentId,
    utr: lead.qrPayment?.utr,
  });
  await lead.save();

  const reservation = await PincodeReservation.findOne({ pincode: lead.pincode });
  let ownsReservation = reservation && String(reservation.bookingId) === String(lead._id);

  // Reservation is gone (TTL expired) but nobody else re-booked it in the
  // gap — only attempted on explicit admin instruction (manual payment flow).
  if (!reservation && allowRelockIfFree) {
    try {
      await acquirePincodeLock({ pincode: lead.pincode, bookingId: lead._id });
      ownsReservation = true;
    } catch (err) {
      // Someone grabbed it in the exact window between our check and this
      // re-lock attempt — genuinely lost, fall through to lock_lost below.
      ownsReservation = false;
    }
  }

  if (ownsReservation) {
    await confirmPincodeLock({ pincode: lead.pincode, bookingId: lead._id });

    let receiptUrl = '';
    try {
      const pdfBuffer = await generateReceiptPdfBuffer({
        bookingId: String(lead._id),
        name: lead.name,
        mobile: lead.mobile,
        email: lead.email,
        pincode: lead.pincode,
        district: lead.district,
        state: lead.state,
        baseAmount: lead.gst?.baseAmount ?? 0,
        gstAmount: lead.gst?.gstAmount ?? 0,
        totalAmount: lead.gst?.totalAmount ?? lead.razorpay?.amount ?? 0,
        paymentId: lead.razorpay?.paymentId || manualPayment?.reference || 'Manual Payment',
        orderId: lead.razorpay?.orderId || (manualPayment ? `MANUAL-${(manualPayment.mode || '').toUpperCase()}` : ''),
        date: new Date().toISOString(),
      });

      const uploaded = await uploadFile(pdfBuffer, `receipt-${lead._id}.pdf`, 'application/pdf', 'receipts');
      receiptUrl = uploaded.publicUrl;
      lead.receiptUrl = receiptUrl;
      await lead.save();
    } catch (err) {
      console.error('❌ Failed to generate/upload receipt PDF:', err.message);
    }

    await sendPaymentConfirmationEmail({
      to: lead.email,
      name: lead.name,
      pincode: lead.pincode,
      district: lead.district,
      state: lead.state,
      amount: lead.gst?.totalAmount ?? lead.razorpay?.amount,
      paymentId: lead.razorpay?.paymentId || manualPayment?.reference || 'Manual Payment',
      receiptUrl,
    });

    return { lead, lockLost: false };
  }

  lead.status = 'lock_lost';
  lead.lostReason = reservation
    ? 'Pincode was re-sold before payment was confirmed'
    : 'Pincode reservation expired and was re-sold before payment was confirmed';
  lead.leadCallStatus = 'pending_call';
  await lead.save();

  return { lead, lockLost: true };
};
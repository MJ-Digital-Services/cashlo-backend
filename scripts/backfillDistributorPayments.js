import mongoose from 'mongoose';
import DistributorLead from '../src/models/DistributorLead.js';
import { config } from '../src/config/environment.js';

const TOTAL_DISTRIBUTOR_FEE_PAISE = 708000; // ₹7,080 — current commercial value

async function run() {
  await mongoose.connect(config.mongoUri);

  const leads = await DistributorLead.find({
    status: 'paid',
    $or: [
      { payments: { $exists: false } },
      { payments: { $size: 0 } },
    ],
  });

  console.log(`Found ${leads.length} paid leads to backfill.`);

  for (const lead of leads) {
    // Prefer the actual recorded amount over the current constant, in case
    // BOOKING_AMOUNT_PAISE ever changed historically.
    const amount =
      lead.razorpay?.amount || lead.gst?.totalAmount || 118000;

    const method =
      lead.paymentMethod === 'qr_self'
        ? 'qr_self'
        : lead.paymentMethod === 'manual'
        ? 'manual'
        : 'razorpay';

    lead.totalDistributorFee = TOTAL_DISTRIBUTOR_FEE_PAISE;
    lead.payments.push({
      stage: 'booking',
      method,
      amount,
      status: 'success',
      orderId: lead.razorpay?.orderId,
      paymentId: lead.razorpay?.paymentId,
      utr: lead.qrPayment?.utr,
      createdAt: lead.updatedAt,
    });

    await lead.save();
    console.log(`Backfilled ${lead.pincode} (${lead._id})`);
  }

  console.log('Done.');
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
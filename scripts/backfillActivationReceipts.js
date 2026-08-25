import mongoose from 'mongoose';
import DistributorLead from '../src/models/DistributorLead.js';
import { config } from '../src/config/environment.js';
import { generateReceiptPdfBuffer } from '../src/services/receipt.service.js';
import { uploadFile } from '../src/services/s3.service.js';

async function run() {
  await mongoose.connect(config.mongoUri);

  const leads = await DistributorLead.find({
    status: 'activated',
    $or: [{ activationReceiptUrl: '' }, { activationReceiptUrl: { $exists: false } }],
  });

  console.log(`Found ${leads.length} activated leads missing an activation receipt.`);

  for (const lead of leads) {
    const finalPayment = lead.payments.find((p) => p.stage === 'final' && p.status === 'success');

    if (!finalPayment) {
      console.log(`Skipping ${lead.pincode} (${lead._id}) — no successful final payment entry found.`);
      continue;
    }

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
        totalAmount: finalPayment.amount,
        paymentId: finalPayment.utr || 'Final Payment',
        orderId: `FINAL-${(finalPayment.method || 'qr_self').toUpperCase()}`,
        date: (finalPayment.reviewedAt || lead.activatedAt || lead.updatedAt).toISOString(),
      });

      const uploaded = await uploadFile(
        pdfBuffer,
        `activation-receipt-${lead._id}.pdf`,
        'application/pdf',
        'receipts'
      );

      lead.activationReceiptUrl = uploaded.publicUrl;
      await lead.save();
      console.log(`Backfilled activation receipt for ${lead.pincode} (${lead._id})`);
    } catch (err) {
      console.error(`Failed for ${lead.pincode} (${lead._id}):`, err.message);
    }
  }

  console.log('Done.');
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
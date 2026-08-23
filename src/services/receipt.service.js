import PDFDocument from 'pdfkit';

const BRAND = '#445df0';

function formatMoney(paise) {
  return `Rs. ${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

// Returns a Promise<Buffer> — PDFKit streams internally, so we collect
// chunks and resolve once the document is fully written.
export const generateReceiptPdfBuffer = (data) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const receiptNumber = `CSH-${data.bookingId.slice(-8).toUpperCase()}`;

    doc.fontSize(22).fillColor(BRAND).font('Helvetica-Bold').text('Cashlo', 50, 50);
    doc.fontSize(10).fillColor('#888888').font('Helvetica').text('Payment Receipt', 50, 78);

    doc.fontSize(10).fillColor('#333333').text(receiptNumber, 400, 50, { align: 'right' });
    doc.fillColor('#888888').text(
      new Date(data.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
      400,
      65,
      { align: 'right' }
    );
    doc.fillColor('#16a34a').font('Helvetica-Bold').text('PAID', 400, 82, { align: 'right' });

    doc.moveTo(50, 110).lineTo(545, 110).strokeColor('#e5e7eb').stroke();

    doc.fillColor('#888888').fontSize(9).font('Helvetica').text('BILLED TO', 50, 130);
    doc.fillColor('#111111').fontSize(11).font('Helvetica-Bold').text(data.name, 50, 145);
    doc.font('Helvetica').fontSize(10).fillColor('#444444').text(data.mobile, 50, 162).text(data.email, 50, 176);

    doc.fillColor('#888888').fontSize(9).font('Helvetica').text('RESERVED TERRITORY', 320, 130);
    doc.fillColor('#111111').fontSize(11).font('Helvetica-Bold').text(`PIN Code ${data.pincode}`, 320, 145);
    doc.font('Helvetica').fontSize(10).fillColor('#444444').text(`${data.district}, ${data.state}`, 320, 162);

    doc.moveTo(50, 210).lineTo(545, 210).strokeColor('#e5e7eb').stroke();

    let y = 230;
    doc.fillColor('#888888').fontSize(9).font('Helvetica').text('DESCRIPTION', 50, y);
    doc.text('AMOUNT', 450, y, { align: 'right', width: 95 });

    if (data.includeGstBreakdown === false) {
      y += 20;
      doc.fillColor('#333333').fontSize(10).font('Helvetica').text(
        data.lineItemLabel || 'Payment',
        50,
        y
      );
      doc.text(formatMoney(data.totalAmount), 450, y, { align: 'right', width: 95 });
      y += 20;
    } else {
      y += 20;
      doc.fillColor('#333333').fontSize(10).font('Helvetica').text(
        data.lineItemLabel || 'PIN Code Reservation Fee',
        50,
        y
      );
      doc.text(formatMoney(data.baseAmount), 450, y, { align: 'right', width: 95 });

      y += 20;
      doc.text('GST (18%)', 50, y);
      doc.text(formatMoney(data.gstAmount), 450, y, { align: 'right', width: 95 });
      y += 5;
    }

    y += 20;
    doc.moveTo(50, y).lineTo(545, y).strokeColor('#111111').lineWidth(1.5).stroke();

    y += 12;
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#111111').text('Total Paid', 50, y);
    doc.text(formatMoney(data.totalAmount), 450, y, { align: 'right', width: 95 });

    y += 40;
    doc.fontSize(9).font('Helvetica').fillColor('#888888');
    doc.text(`Payment ID: ${data.paymentId}`, 50, y);
    doc.text(`Order ID: ${data.orderId}`, 320, y);

    y += 40;
    doc
      .fontSize(8)
      .fillColor('#aaaaaa')
      .text(
        'This is a computer-generated receipt and does not require a signature. For any queries, contact support@cashlo.in.',
        50,
        y,
        { width: 495, align: 'center' }
      );

    doc.end();
  });
};
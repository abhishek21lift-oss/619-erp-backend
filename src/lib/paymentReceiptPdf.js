// src/lib/paymentReceiptPdf.js
// Receipt for one payment on a client's ledger (pt_payments) — cash, card or
// UPI taken at the studio desk.
//
// The UPI checkout has its own, fuller receipt (upiReceiptPdf.js: UTR, order
// number, GST split, validity window). This one is for everything else, so a
// member can download a receipt for every payment they have made, not only
// the ones they made in the app. Rendered on demand, never stored — the same
// reasoning upiReceiptPdf.js gives.
'use strict';

const PDFDocument = require('pdfkit');
const { fmtDate, drawSectionHeading, drawLabelValue } = require('./pdfHelpers');
const { formatInr } = require('./upiReceiptPdf');

const INK = '#0B1220';
const MUTE = '#6B7280';
const RULE = '#E5E7EB';
const BRAND = '#0060E0';

const METHOD_LABEL = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', BANK: 'Bank transfer', CHEQUE: 'Cheque' };

/**
 * @param {object} p  the payment with its member and studio (see
 *                    member-renewal.service myPaymentForReceipt)
 * @returns {Promise<Buffer>}
 */
async function generatePaymentReceiptPdf(p) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));

  const receiptNo = p.payment_ref || `P-${String(p.id).slice(0, 8).toUpperCase()}`;

  doc.fontSize(20).font('Helvetica-Bold').fillColor(INK)
    .text(p.studio_name || 'MY PT STUDIO', { align: 'center' });
  doc.moveDown(0.2);
  doc.fontSize(9).font('Helvetica').fillColor(MUTE).text('Powered by MY PT STUDIO', { align: 'center' });
  doc.moveDown(0.8);
  doc.fontSize(15).font('Helvetica-Bold').fillColor(BRAND).text('PAYMENT RECEIPT', { align: 'center' });
  doc.moveDown(0.2);
  doc.fontSize(9).font('Helvetica').fillColor(MUTE).text(`Receipt No. ${receiptNo}`, { align: 'center' });
  doc.moveDown(0.6);
  doc.moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .strokeColor(RULE).lineWidth(1).stroke();
  doc.moveDown(0.6);

  drawSectionHeading(doc, 'Member');
  drawLabelValue(doc, 'Name:', p.member_name);
  drawLabelValue(doc, 'Mobile:', p.member_mobile);
  drawLabelValue(doc, 'Email:', p.member_email);

  drawSectionHeading(doc, 'Payment');
  drawLabelValue(doc, 'Date:', fmtDate(p.date));
  const method = String(p.payment_method || '').toUpperCase();
  drawLabelValue(doc, 'Method:', METHOD_LABEL[method] || p.payment_method || '—');
  if (p.notes) drawLabelValue(doc, 'For:', p.notes);
  doc.moveDown(0.2);
  doc.fontSize(12).font('Helvetica-Bold').fillColor(INK).text(`Amount Paid:  ${formatInr(p.amount)}`);
  doc.font('Helvetica').fontSize(10);

  doc.moveDown(1.2);
  doc.moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .strokeColor(RULE).lineWidth(1).stroke();
  doc.moveDown(0.5);
  doc.fontSize(8).font('Helvetica').fillColor(MUTE).text(
    'Recorded by the studio. This receipt is computer generated and valid without a signature.',
    { align: 'center' }
  );
  doc.moveDown(0.3);
  doc.fontSize(8).fillColor(MUTE).text(`Generated ${new Date().toISOString()}`, { align: 'center' });

  doc.end();
  return new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

module.exports = { generatePaymentReceiptPdf };

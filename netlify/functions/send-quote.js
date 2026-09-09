// netlify/functions/send-quote.js
// ESM (package.json has "type": "module").
// Sends the quote as a PDF attachment via SMTP.
// One shared SMTP mailbox authenticates the send; each user's email is set as Reply-To
// so replies land in the sender's inbox, not the shared mailbox.
//
// Required Netlify environment variables:
//   SMTP_HOST       e.g. smtp.gmail.com
//   SMTP_PORT       e.g. 465
//   SMTP_SECURE     "true" for port 465, "false" for 587
//   SMTP_USER       e.g. bodyshop.e.s@gmail.com  (the shared authenticated mailbox)
//   SMTP_PASS       Gmail App Password (16 chars, no spaces)
//   SMTP_FROM_NAME  optional display name, defaults to "Car-O-Liner Southwest"

import nodemailer from 'nodemailer';
import PDFDocument from 'pdfkit';

const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;

function buildPdf(data) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Header
      doc.fontSize(22).text('SERVICE REQUEST / QUOTE', { align: 'left' });
      doc.moveDown(0.3);
      doc.fontSize(10)
        .text('Car-O-Liner Southwest', { align: 'left' })
        .text('2805 Singleton St, Rowlett, TX 75088')
        .text('T: (972) 412-5147   F: (972) 412-5287');
      doc.moveDown(0.5);
      doc.fontSize(10).text(`Date: ${data.date || ''}`, { align: 'right' });
      doc.text(`Rep: ${data.rep || ''}`, { align: 'right' });
      doc.moveDown();

      // Customer
      doc.fontSize(12).text('Sold To:', { underline: true });
      doc.fontSize(11)
        .text(data.customer || '')
        .text(data.contact || '')
        .text(data.address || '')
        .text([data.city, data.state, data.zip].filter(Boolean).join(', '))
        .text(`Phone: ${data.phone || ''}`)
        .text(`Email: ${data.email || ''}`);
      doc.moveDown();

      if (data.notes) {
        doc.fontSize(12).text('Notes:', { underline: true });
        doc.fontSize(10).text(data.notes);
        doc.moveDown();
      }

      // Items table
      doc.fontSize(12).text('Items:', { underline: true });
      doc.moveDown(0.3);
      doc.fontSize(10);
      const startX = doc.x;
      const cols = [
        { label: '#', w: 25 },
        { label: 'Item',  w: 90 },
        { label: 'Description', w: 200 },
        { label: 'Qty', w: 35 },
        { label: 'Price', w: 60 },
        { label: 'Total', w: 60 },
      ];
      let y = doc.y;
      // header
      let x = startX;
      doc.font('Helvetica-Bold');
      cols.forEach(c => { doc.text(c.label, x, y, { width: c.w }); x += c.w; });
      doc.font('Helvetica');
      y += 16;
      doc.moveTo(startX, y - 4).lineTo(startX + cols.reduce((a, c) => a + c.w, 0), y - 4).stroke();

      let subtotal = 0;
      (data.cart || []).forEach((it, i) => {
        const qty = Number(it.qty) || 0;
        const price = Number(it.price) || 0;
        const line = qty * price;
        subtotal += line;
        x = startX;
        const row = [
          String(i + 1),
          it.num || it.item || '',
          `${it.desc || ''}${it.type ? ' — ' + it.type : ''}${it.rr === 'Repair' ? ' (REPAIR)' : ''}${it.notes ? ' — ' + it.notes : ''}`,
          String(qty),
          money(price),
          money(line),
        ];
        // measure the description height for row height
        const descHeight = doc.heightOfString(row[2], { width: cols[2].w });
        const rowH = Math.max(14, descHeight + 4);
        row.forEach((cell, ci) => {
          doc.text(cell, x, y, { width: cols[ci].w });
          x += cols[ci].w;
        });
        y += rowH;
        if (y > 720) { doc.addPage(); y = 50; }
        doc.y = y;
      });

      doc.moveDown();
      const totals = data.totals || {};
      doc.fontSize(11).text(`Subtotal: ${totals.subtotal || money(subtotal)}`, { align: 'right' });
      if (totals.tax)     doc.text(`Tax: ${totals.tax}`,     { align: 'right' });
      if (totals.freight) doc.text(`Freight: ${totals.freight}`, { align: 'right' });
      doc.font('Helvetica-Bold').text(`Total: ${totals.grand || money(subtotal)}`, { align: 'right' });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

export const handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  let data;
  try { data = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const to = data.to;
  if (!to)               return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing recipient (to)' }) };
  if (!(data.cart || []).length) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Cart is empty' }) };

  const {
    SMTP_HOST, SMTP_PORT, SMTP_SECURE,
    SMTP_USER, SMTP_PASS, SMTP_FROM_NAME
  } = process.env;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: 'SMTP not configured on server (set SMTP_HOST, SMTP_USER, SMTP_PASS in Netlify env vars)' }),
    };
  }

  try {
    const pdfBuffer = await buildPdf(data);

    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT) || 465,
      secure: String(SMTP_SECURE || 'true') === 'true',
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });

    const senderEmail = data.senderEmail || data.email || SMTP_USER;
    const senderName  = data.rep || SMTP_FROM_NAME || 'Car-O-Liner Southwest';
    const subject     = `Service Request – ${data.customer || 'Customer'} – ${data.date || ''}`.trim();
    const bodyLines = [
      `New service request submitted via the COL Southwest app.`,
      ``,
      `Customer: ${data.customer || ''}`,
      `Contact:  ${data.contact || ''}`,
      `Phone:    ${data.phone || ''}`,
      `Email:    ${data.email || ''}`,
      `Rep:      ${data.rep || ''}`,
      ``,
      `Total:    ${(data.totals && data.totals.grand) || ''}`,
      ``,
      `Notes: ${data.notes || '(none)'}`,
    ].join('\n');

    await transporter.sendMail({
      from: `"${senderName}" <${SMTP_USER}>`,   // must match authenticated user
      replyTo: senderEmail,                     // replies go to the actual sender
      to,
      subject,
      text: bodyLines,
      attachments: [{
        filename: `Quote-${(data.customer || 'customer').replace(/[^A-Za-z0-9]+/g, '_')}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      }],
    });

    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: err.message || 'Send failed' }),
    };
  }
};

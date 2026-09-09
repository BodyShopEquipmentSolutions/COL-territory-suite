// netlify/functions/send-quote.js
// ESM (package.json has "type": "module").
// Sends the quote as a PDF attachment via SMTP.
// Uses pdf-lib (Standard-14 fonts embedded, no external file assets — works
// cleanly in esbuild-bundled Netlify Functions where pdfkit's .afm files fail
// to resolve at runtime).
//
// Required Netlify environment variables:
//   SMTP_HOST       e.g. smtp.gmail.com
//   SMTP_PORT       e.g. 465
//   SMTP_SECURE     "true" for port 465, "false" for 587
//   SMTP_USER       shared authenticated mailbox (e.g. noreply.colsw@gmail.com)
//   SMTP_PASS       Gmail App Password (16 chars)
//   SMTP_FROM_NAME  optional display name

import nodemailer from 'nodemailer';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;

// LETTER: 612 x 792 pts. Margins & column widths in pts.
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN_L = 50;
const MARGIN_R = 50;
const MARGIN_T = 50;
const MARGIN_B = 60;
const CONTENT_W = PAGE_W - MARGIN_L - MARGIN_R;

function wrap(text, font, size, maxWidth) {
  const words = String(text || '').split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const trial = line ? line + ' ' + w : w;
    if (font.widthOfTextAtSize(trial, size) <= maxWidth) {
      line = trial;
    } else {
      if (line) lines.push(line);
      // very-long single word: hard-break
      if (font.widthOfTextAtSize(w, size) > maxWidth) {
        let chunk = '';
        for (const ch of w) {
          if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth) {
            lines.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        line = chunk;
      } else {
        line = w;
      }
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

async function buildPdf(data) {
  const pdf = await PDFDocument.create();
  const helv     = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page = pdf.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN_T;

  const ensureRoom = (h) => {
    if (y - h < MARGIN_B) {
      page = pdf.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN_T;
    }
  };

  const draw = (text, opts = {}) => {
    const font = opts.bold ? helvBold : helv;
    const size = opts.size || 10;
    const align = opts.align || 'left';
    const width = opts.width || CONTENT_W;
    const x0 = opts.x != null ? opts.x : MARGIN_L;
    const color = opts.color || rgb(0, 0, 0);
    const lines = wrap(text, font, size, width);
    const lineH = size + 3;
    for (const ln of lines) {
      ensureRoom(lineH);
      let x = x0;
      if (align === 'right') {
        const w = font.widthOfTextAtSize(ln, size);
        x = x0 + width - w;
      } else if (align === 'center') {
        const w = font.widthOfTextAtSize(ln, size);
        x = x0 + (width - w) / 2;
      }
      page.drawText(ln, { x, y: y - size, size, font, color });
      y -= lineH;
    }
    return lines.length * lineH;
  };

  const spacer = (h) => { ensureRoom(h); y -= h; };
  const rule = () => {
    ensureRoom(2);
    page.drawLine({
      start: { x: MARGIN_L, y },
      end:   { x: MARGIN_L + CONTENT_W, y },
      thickness: 0.5,
      color: rgb(0.5, 0.5, 0.5),
    });
    y -= 4;
  };

  // Header
  draw('SERVICE REQUEST / QUOTE', { size: 22, bold: true });
  spacer(4);
  draw('Car-O-Liner Southwest', { size: 10 });
  draw('2805 Singleton St, Rowlett, TX 75088', { size: 10 });
  draw('T: (972) 412-5147   F: (972) 412-5287', { size: 10 });
  spacer(4);
  draw(`Date: ${data.date || ''}`, { size: 10, align: 'right' });
  draw(`Rep: ${data.rep || ''}`, { size: 10, align: 'right' });
  spacer(8);

  // Customer
  draw('Sold To:', { size: 12, bold: true });
  rule();
  draw(data.customer || '', { size: 11 });
  if (data.contact) draw(data.contact, { size: 11 });
  if (data.address) draw(data.address, { size: 11 });
  const csz = [data.city, data.state, data.zip].filter(Boolean).join(', ');
  if (csz) draw(csz, { size: 11 });
  if (data.phone) draw(`Phone: ${data.phone}`, { size: 11 });
  if (data.email) draw(`Email: ${data.email}`, { size: 11 });
  spacer(8);

  if (data.notes) {
    draw('Notes:', { size: 12, bold: true });
    rule();
    draw(data.notes, { size: 10 });
    spacer(8);
  }

  // Items
  draw('Items:', { size: 12, bold: true });
  rule();

  const cols = [
    { key: 'n',     label: '#',           w: 25  },
    { key: 'item',  label: 'Item',        w: 85  },
    { key: 'desc',  label: 'Description', w: 200 },
    { key: 'qty',   label: 'Qty',         w: 30, align: 'right' },
    { key: 'price', label: 'Price',       w: 60, align: 'right' },
    { key: 'total', label: 'Total',       w: 60, align: 'right' },
  ];
  const colX = [];
  {
    let cx = MARGIN_L;
    for (const c of cols) { colX.push(cx); cx += c.w; }
  }

  const drawRow = (cells, opts = {}) => {
    const size = opts.size || 10;
    const font = opts.bold ? helvBold : helv;
    // measure row height using the wider column heights
    let rowH = size + 3;
    const cellLines = cells.map((cell, i) => wrap(String(cell ?? ''), font, size, cols[i].w - 4));
    for (const lines of cellLines) rowH = Math.max(rowH, lines.length * (size + 3));
    ensureRoom(rowH);
    for (let i = 0; i < cells.length; i++) {
      const lines = cellLines[i];
      let ly = y;
      for (const ln of lines) {
        let x = colX[i] + 2;
        const w = font.widthOfTextAtSize(ln, size);
        if (cols[i].align === 'right') x = colX[i] + cols[i].w - w - 2;
        page.drawText(ln, { x, y: ly - size, size, font });
        ly -= (size + 3);
      }
    }
    y -= rowH;
  };

  // Header row
  drawRow(cols.map(c => c.label), { bold: true, size: 10 });
  rule();

  let subtotal = 0;
  (data.cart || []).forEach((it, i) => {
    const qty = Number(it.qty) || 0;
    // Client stores numeric unit price under `base` (see service.html:addToCart);
    // fall back to `price` for older payloads. Repair lines are $0 by design.
    const rawUnit = it.base != null ? it.base
                  : (typeof it.price === 'string'
                       ? Number(String(it.price).replace(/[^0-9.\-]/g, ''))
                       : Number(it.price));
    const unit = it.rr === 'Repair' ? 0 : (Number(rawUnit) || 0);
    const price = unit;
    const line  = qty * unit;
    subtotal   += line;
    const desc  = `${it.desc || ''}${it.type ? ' — ' + it.type : ''}${it.rr === 'Repair' ? ' (REPAIR)' : ''}${it.notes ? ' — ' + it.notes : ''}`;
    drawRow([
      String(i + 1),
      it.num || it.item || '',
      desc,
      String(qty),
      money(price),
      money(line),
    ]);
  });

  spacer(8);
  const totals = data.totals || {};
  draw(`Subtotal: ${totals.subtotal || money(subtotal)}`, { size: 11, align: 'right' });
  if (totals.tax)     draw(`Tax: ${totals.tax}`,         { size: 11, align: 'right' });
  if (totals.freight) draw(`Freight: ${totals.freight}`, { size: 11, align: 'right' });
  draw(`Total: ${totals.grand || money(subtotal)}`, { size: 12, bold: true, align: 'right' });

  const bytes = await pdf.save();
  return Buffer.from(bytes);
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
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!data.senderEmail || !EMAIL_RE.test(data.senderEmail)) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Please enter your email in the Send To section so replies come back to you.' }) };
  }

  let ccList = [];
  if (Array.isArray(data.cc)) ccList = data.cc;
  else if (typeof data.cc === 'string') ccList = data.cc.split(/[,;\s]+/);
  ccList = ccList.map(s => String(s).trim()).filter(Boolean);
  const badCc = ccList.filter(e => !EMAIL_RE.test(e));
  if (badCc.length) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid CC email(s): ' + badCc.join(', ') }) };
  }

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

    const csz = [data.city, data.state, data.zip].filter(Boolean).join(', ').replace(', ,', ',');
    const addressLine = [data.address, csz].filter(Boolean).join(' — ');

    const bodyLines = [
      `New service request submitted via the COL Southwest app.`,
      ``,
    ];
    if (data.message) {
      bodyLines.push('Message from ' + (data.rep || 'the rep') + ':');
      bodyLines.push(data.message);
      bodyLines.push('');
    }
    bodyLines.push('Ordered by:    ' + (data.orderedBy || ''));
    bodyLines.push('Address:       ' + addressLine);
    bodyLines.push('Phone number:  ' + (data.phone || ''));
    bodyLines.push('Email address: ' + (data.email || ''));
    bodyLines.push('');
    bodyLines.push('Customer: ' + (data.customer || ''));
    bodyLines.push('Contact:  ' + (data.contact || ''));
    bodyLines.push('Rep:      ' + (data.rep || ''));
    bodyLines.push('');
    bodyLines.push('Total:    ' + ((data.totals && data.totals.grand) || ''));
    bodyLines.push('');
    bodyLines.push('Notes: ' + (data.notes || '(none)'));
    const bodyText = bodyLines.join('\n');

    await transporter.sendMail({
      from: `"${senderName}" <${SMTP_USER}>`,
      replyTo: senderEmail,
      to,
      cc: ccList.length ? ccList : undefined,
      subject,
      text: bodyText,
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

// netlify/functions/export_csv_zip.js
//
// Serverless function to accept a PDF invoice (base64 encoded),
// parse it into header and line items, generate two CSV files and
// return them in a single ZIP archive. This version uses CommonJS
// syntax and renames the ZIP instance to avoid name conflicts.

const pdf = require('pdf-parse');
const JSZip = require('jszip');

// -----------------------------------------------------------------------------
// Regex and helper constants for parsing
// -----------------------------------------------------------------------------

const usStates = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME",
  "MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA",
  "RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"
];
const STATE_RE = new RegExp(`\\b(?:${usStates.join("|")})\\b`);
const MONEY_RE = String.raw`-?\\$?\\d{1,3}(?:,\\d{3})*(?:\\.\\d{2})?|-?\\$?\\d+(?:\\.\\d{2})?`;
const QTY_RE   = String.raw`\\d+(?:\\.\\d+)?`;

// -----------------------------------------------------------------------------
// Utility functions for cleaning and parsing text
// -----------------------------------------------------------------------------

function cleanLines(text) {
  return text
    .replace(/\\r/g, "")
    .split("\\n")
    .map(l => l.replace(/\\u00A0/g, " ").replace(/\\s+$/g, "").replace(/^\\s+/g, ""))
    .filter(l => l.length > 0);
}

function unmoney(s) {
  if (s == null) return null;
  const v = String(s).replace(/\\$/g, "").replace(/,/g, "").trim();
  return v === "" ? null : Number(v);
}

function parseDate(raw) {
  if (!raw) return null;
  const m = raw.match(/(\\d{1,2})[\\/\\-](\\d{1,2})[\\/\\-](\\d{2,4})/);
  if (!m) return null;
  let [ , mm, dd, yyyy ] = m;
  if (yyyy.length === 2) {
    const yy = parseInt(yyyy, 10);
    yyyy = (yy >= 70 ? 1900 + yy : 2000 + yy).toString();
  }
  const mm2 = mm.padStart(2, "0");
  const dd2 = dd.padStart(2, "0");
  return `${mm2}/${dd2}/${yyyy}`;
}

function findCustomer(lines) {
  const custMarkers = [
    /^(?:Customer|Bill To|Sold To)\\s*:\\s*(.+)$/i,
    /^(?:Customer|Bill To|Sold To)\\s+(.+)$/i,
  ];
  for (const l of lines.slice(0, 40)) {
    for (const re of custMarkers) {
      const m = l.match(re);
      if (m) return m[1].trim();
    }
  }
  const idx = lines.findIndex(l => /Bill To|Sold To|Customer/i.test(l));
  if (idx >= 0) {
    for (let i = idx + 1; i < Math.min(idx + 5, lines.length); i++) {
      const t = lines[i];
      if (!/^(Address|Phone|Email|Fax|Attn|City|State|Zip)[:\\s]/i.test(t) && t.length > 3) {
        return t.trim();
      }
    }
  }
  return null;
}

function findInvoice(lines) {
  const re = /(?:Invoice\\s*(?:#|No\\.?|Number)?\\s*[:\\-]?\\s*)([A-Z0-9\\-]+)/i;
  for (const l of lines.slice(0, 80)) {
    const m = l.match(re);
    if (m) return m[1].trim();
  }
  for (const l of lines.slice(0, 80)) {
    const m = l.match(/\\bINVOICE\\s+([A-Z0-9\\-]+)/i);
    if (m) return m[1].trim();
  }
  return null;
}

function findDate(lines) {
  const re = /(?:Invoice\\s*Date|Date)\\s*[:\\-]?\\s*(\\d{1,2}[\\/\\-]\\d{1,2}[\\/\\-]\\d{2,4})/i;
  for (const l of lines.slice(0, 80)) {
    const m = l.match(re);
    if (m) return parseDate(m[1]);
  }
  for (const l of lines.slice(0, 50)) {
    const m = l.match(/(\\d{1,2}[\\/\\-]\\d{1,2}[\\/\\-]\\d{2,4})/);
    if (m) return parseDate(m[1]);
  }
  return null;
}

function findRep(lines) {
  const re = /(?:Sales\\s*Rep|Salesperson|Sold\\s*By|Rep)\\s*[:\\-]?\\s*([A-Za-z .,'-]+)(?:\\s{2,}|$)/i;
  for (const l of lines.slice(0, 120)) {
    const m = l.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

function findZip(lines) {
  const zipRe = /\\b(\\d{5}(?:-\\d{4})?)\\b/;
  for (const l of lines.slice(0, 50)) {
    if (STATE_RE.test(l) && zipRe.test(l)) {
      const m = l.match(zipRe);
      if (m) return m[1];
    }
  }
  for (const l of lines.slice(0, 50).reverse()) {
    const m = l.match(zipRe);
    if (m) return m[1];
  }
  return null;
}

function findTableStart(lines) {
  const headerRe = /ACTIVITY/i;
  const descRe   = /DESCRIPTION/i;
  const qtyRe    = /\\bQTY\\b|\\bQUANTITY\\b/i;
  const rateRe   = /\\bRATE\\b|\\bPRICE\\b/i;
  const amtRe    = /\\bAMOUNT\\b|\\bEXT\\.?\\b|\\bTOTAL\\b/i;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (headerRe.test(l) && descRe.test(l) && qtyRe.test(l) && rateRe.test(l) && amtRe.test(l)) {
      return i;
    }
  }
  return -1;
}

function shouldStopRow(line) {
  return /^(Subtotal|Sub\\-Total|Tax|Sales Tax|Total|Balance Due)\\b/i.test(line) ||
         /^INVOICE\\b/i.test(line) ||
         /^Page \\d+/i.test(line);
}

function parseLines(lines, headerIdx) {
  if (headerIdx < 0) return [];
  const start = headerIdx + 1;
  const out = [];
  const tailRe = new RegExp(
    String.raw`(${QTY_RE})\\s+(${MONEY_RE})\\s+(${MONEY_RE})$`
  );
  for (let i = start; i < lines.length; i++) {
    const raw = lines[i];
    if (shouldStopRow(raw)) break;
    if (!raw.trim()) continue;
    const mTail = raw.match(tailRe);
    if (mTail) {
      const trailStart = raw.lastIndexOf(mTail[0]);
      const left = raw.slice(0, trailStart).trim();
      const mLeft = left.match(/^([A-Za-z0-9._\\-/]+)\\s+(.*)$/);
      let activity;
      let description;
      if (mLeft) {
        activity    = mLeft[1].trim();
        description = mLeft[2].trim();
      } else {
        activity    = "";
        description = left;
      }
      out.push({
        activity,
        description,
        qty: Number(mTail[1]),
        rate: unmoney(mTail[2]),
        amount: unmoney(mTail[3]),
      });
      continue;
    }
    if (out.length === 0) {
      const mSeed = raw.match(/^([A-Za-z0-9._\\-/]+)\\s+(.*)$/);
      if (mSeed) {
        out.push({
          activity: mSeed[1].trim(),
          description: mSeed[2].trim(),
          qty: null,
          rate: null,
          amount: null,
        });
        continue;
      }
    }
    if (out.length > 0) {
      const last = out[out.length - 1];
      last.description = (last.description ? last.description + " " : "") + raw.trim();
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Main handler
// -----------------------------------------------------------------------------

exports.handler = async function (event) {
  try {
    const isJson = event.headers["content-type"]?.includes("application/json");
    if (!isJson) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Send JSON: { filename, mimeType, base64 }" }),
      };
    }
    const body = JSON.parse(event.body || "{}");
    const { filename = "invoice.pdf", base64, mimeType = "application/pdf" } = body;
    if (!base64) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing 'base64' PDF content" }) };
    }
    const pdfBuf = Buffer.from(base64, "base64");
    const data = await pdf(pdfBuf);
    const rawText = data.text || "";
    const lines = cleanLines(rawText);
    const customer = findCustomer(lines);
    const invoice  = findInvoice(lines);
    const date     = findDate(lines);
    const rep      = findRep(lines);
    const zip      = findZip(lines);
    const header   = { customer, rep, date, invoice, zip };
    const headerIdx = findTableStart(lines);
    const items     = parseLines(lines, headerIdx);
    const headerCsvRows = [
      ["Customer","Rep","Date","Invoice","Zip"],
      [
        header.customer ?? "",
        header.rep      ?? "",
        header.date     ?? "",
        header.invoice  ?? "",
        header.zip      ?? "",
      ],
    ];
    const headerCsv = headerCsvRows.map(r => r.map(escapeCsv).join(",")).join("\\n");
    const linesCsvRows = [
      ["Activity","Description","Qty","Rate","Amount"],
      ...items.map(item => [
        item.activity,
        item.description,
        item.qty != null ? String(item.qty) : "",
        item.rate != null ? String(item.rate) : "",
        item.amount != null ? String(item.amount) : "",
      ]),
    ];
    const linesCsv = linesCsvRows.map(r => r.map(escapeCsv).join(",")).join("\\n");
    // Create the ZIP archive using a unique variable name
    const archive = new JSZip();
    archive.file("invoice_header.csv", headerCsv);
    archive.file("invoice_lines.csv", linesCsv);
    const zipBuf = await archive.generateAsync({ type: "nodebuffer" });
    // Determine a friendly ZIP name
    const safe = (s) => (s || "").toString().replace(/[^A-Za-z0-9.-]+/g, "_");
    const parts = [safe(customer), safe(rep), safe(invoice)].filter(Boolean);
    const zipName = parts.length > 0 ? `${parts.join("_")}_extract.zip` : "invoice_extract.zip";
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename=${zipName}`,
      },
      body: zipBuf.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: String(err?.message || err) }),
    };
  }
};

// -----------------------------------------------------------------------------
// CSV utilities
// -----------------------------------------------------------------------------

function escapeCsv(value) {
  if (value == null) return "";
  const str = String(value);
  if (/[,\\r\\n\"]/.test(str)) {
    return '\"' + str.replace(/\"/g, '\"\"') + '\"';
  }
  return str;
}

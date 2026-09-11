// netlify/functions/create-qw-quote.js
// ESM (package.json has "type": "module").
//
// Two actions, routed by POST body { action }:
//   - "search_customers" -> proxies CRMCompanies/search
//   - "create_quote"     -> creates a DocumentHeaders row + DocumentItems, emails the rep
//
// Required Netlify environment variables:
//   QW_API_KEY   the QuoteWerks Web REST API key (must be set on Netlify)
//   QW_API_BASE  defaults to https://qwwapi.quotewerks.com when unset
//   SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM_NAME
//                (reused from send-quote.js — same shared mailbox)

import nodemailer from 'nodemailer';

const QW_BASE_DEFAULT = 'https://qwwapi.quotewerks.com';

// ---------------------------------------------------------------------------
// Rep username -> email map. QW SecurityAccounts has no email column, so this
// is Ryan-editable. Anything not in the map falls through to a shared inbox
// with a subject line noting the intended rep.
// ---------------------------------------------------------------------------
const REP_EMAIL_MAP = {
  'ryan.harthcock': 'bodyshop.e.s@gmail.com',
  // TODO(ryan): fill in the rest. Missing entries fall back to FALLBACK_EMAIL.
};
const FALLBACK_EMAIL = 'bodyshop.e.s@gmail.com';

function prettyRep(username) {
  if (!username) return '';
  if (username.startsWith('<') && username.endsWith('>')) return username;
  return username
    .split('.')
    .map(s => s ? s[0].toUpperCase() + s.slice(1) : s)
    .join(' ');
}

// ---------------------------------------------------------------------------
// Thin QW REST helper. Every call injects X-API-Key and JSON:API-ish envelope.
// Throws on non-2xx with the response body appended for easier debugging.
// ---------------------------------------------------------------------------
async function qwFetch(base, apiKey, path, opts = {}) {
  const url = base.replace(/\/+$/, '') + path;
  const headers = {
    'X-API-Key': apiKey,
    'Accept': 'application/json',
    ...(opts.headers || {}),
  };
  if (opts.body != null && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers,
    body: opts.body != null ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* leave data null */ }
  if (!res.ok) {
    const snippet = text ? text.slice(0, 400) : '';
    const err = new Error(`QW ${opts.method || 'GET'} ${path} -> ${res.status}${snippet ? ': ' + snippet : ''}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------------------
// action: search_customers
// ---------------------------------------------------------------------------
async function searchCustomers(base, apiKey, query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const body = {
    filter: [{ name: 'CompanyName', op: 'contains', val: q }],
    page: { number: 1, size: 20 },
    fields: { CRMCompanies: ['CompanyName', 'City', 'State', 'PhoneMain', 'ID'] },
  };
  const data = await qwFetch(base, apiKey, '/api/v1/qw/tables/CRMCompanies/search', { method: 'POST', body });
  const rows = Array.isArray(data && data.data) ? data.data : [];
  return rows.map(r => {
    const a = (r && r.attributes) || {};
    return {
      id: r.id || a.ID || '',
      name: a.CompanyName || '',
      city: a.City || '',
      state: a.State || '',
      phone: a.PhoneMain || '',
    };
  });
}

// ---------------------------------------------------------------------------
// action: create_quote
// ---------------------------------------------------------------------------
function nowIso() {
  return new Date().toISOString();
}

async function createHeader(base, apiKey, { rep, customer }) {
  const attrs = {
    DocType: 'QUOTE',
    DocStatus: 'Open',
    DocDate: nowIso(),
    SalesRep: rep,
  };
  // SoldTo fields — populate what we have; QW ignores unknown fields.
  // Accept both { company } and { customer } (frontend picker uses the latter).
  if (customer) {
    const company = customer.company || customer.customer;
    if (company)          attrs.SoldToCompany  = company;
    if (customer.city)    attrs.SoldToCity     = customer.city;
    if (customer.state)   attrs.SoldToState    = customer.state;
    if (customer.phone)   attrs.SoldToPhone    = customer.phone;
    if (customer.email)   attrs.SoldToEmail    = customer.email;
    if (customer.address) attrs.SoldToAddress1 = customer.address;
    if (customer.zip)     attrs.SoldToZip      = customer.zip;
    if (customer.contact || customer.attention)
      attrs.SoldToContact = customer.contact || customer.attention;
  }
  const body = { data: { type: 'DocumentHeaders', attributes: attrs } };
  const res = await qwFetch(base, apiKey, '/api/v1/qw/tables/DocumentHeaders', { method: 'POST', body });
  const id = res && res.data && res.data.id;
  const docNo = res && res.data && res.data.attributes && res.data.attributes.DocNo;
  if (!id) throw new Error('QW did not return a DocID for the new header');
  return { id, docNo: docNo || null };
}

async function createLine(base, apiKey, docRecGuid, attrs) {
  // QW requires DocRecGUID (the header's `id`) on every DocumentItems insert.
  const body = {
    data: {
      type: 'DocumentItems',
      attributes: { DocRecGUID: docRecGuid, ...attrs },
    },
  };
  return qwFetch(base, apiKey, '/api/v1/qw/tables/DocumentItems', { method: 'POST', body });
}

async function fetchHeader(base, apiKey, docId) {
  return qwFetch(base, apiKey, `/api/v1/qw/tables/DocumentHeaders/${encodeURIComponent(docId)}`);
}

async function createQuote(base, apiKey, { rep, customer, panels }) {
  if (!rep) throw new Error('rep is required');
  if (!panels || !panels.length) throw new Error('At least one audit panel is required');

  const header = await createHeader(base, apiKey, { rep, customer });
  const docId = header.id;

  // Build the line stream. Skip any panel that has nothing to quote.
  for (const panel of panels) {
    const bundle = panel.bundle_name || 'Bundle';
    const unit = panel.unit_number || 1;
    const missing = Array.isArray(panel.missing) ? panel.missing : [];
    const damaged = Array.isArray(panel.damaged) ? panel.damaged : [];
    const custom  = Array.isArray(panel.custom)  ? panel.custom  : [];
    if (!missing.length && !damaged.length && !custom.length) continue;

    // Header/comment line for this unit (LineType 2 = comment in QW)
    await createLine(base, apiKey, docId, {
      LineType: 2,
      PartNumber: '',
      Description: `═ ${bundle} #${unit} — Missing/Damaged Items ═`,
    });

    // BOM leaves identify their sellable parent through parentPartNumber.
    // Consolidate every flagged leaf beneath one parent SKU, but preserve the
    // findings as non-billable comment lines directly after that parent.
    const catalogRows = [
      ...missing.map(it => ({ ...it, auditStatus: 'Missing' })),
      ...damaged.map(it => ({ ...it, auditStatus: 'Damaged' })),
    ];
    const rollups = new Map();
    catalogRows.forEach(it => {
      const partNumber = it.parentPartNumber || it.partNumber || '';
      const description = it.parentDescription || it.description || '';
      const key = `${partNumber}\u0000${description}`;
      if (!rollups.has(key)) rollups.set(key, {
        partNumber,
        description,
        leaves: [],
        // "Expanded" means we itemize sub-parts as comments under the parent SKU.
        // If the user marked the whole assembly missing/damaged, we quote the
        // parent as ONE line with no sub-part detail.
        isExpanded: !!it.parentPartNumber && !it.wholeAssembly,
        wholeAssembly: !!it.wholeAssembly,
      });
      if (it.wholeAssembly) {
        const r = rollups.get(key);
        r.wholeAssembly = true;
        r.isExpanded = false;
      }
      rollups.get(key).leaves.push(it);
    });
    for (const rollup of rollups.values()) {
      const billableQty = rollup.isExpanded ? 1 : (Number(rollup.leaves[0].qty) || 1);
      const first = rollup.leaves[0];
      await createLine(base, apiKey, docId, {
        LineType: 1,
        Manufacturer: 'CAR',
        ManufacturerPartNumber: rollup.partNumber,
        PartNumber: rollup.partNumber,
        Description: rollup.description,
        QtyBase: billableQty,
        Notes: rollup.wholeAssembly
          ? `${first.auditStatus.toUpperCase()} — whole assembly from ${bundle} #${unit}${first.note ? ' — ' + first.note : ''}`
          : rollup.isExpanded
            ? `BOM audit finding from ${bundle} #${unit}; see following comment lines.`
            : `${first.auditStatus.toUpperCase()} from ${bundle} #${unit}${first.note ? ' — ' + first.note : ''}`,
      });
      if (rollup.isExpanded) {
        for (const leaf of rollup.leaves) {
          const note = leaf.note ? ` — ${leaf.note}` : '';
          await createLine(base, apiKey, docId, {
            LineType: 2,
            PartNumber: '',
            Description: `  - ${leaf.partNumber || ''} (${leaf.auditStatus} ${Number(leaf.qty) || 1}) — ${leaf.description || ''}${note}`,
          });
        }
      }
    }
    for (const it of custom) {
      const pn = it.partNumber || (it.id ? `CAR${it.id}` : '');
      await createLine(base, apiKey, docId, {
        LineType: 1,
        Manufacturer: 'CAR',
        ManufacturerPartNumber: pn,
        PartNumber: pn,
        Description: it.description || '',
        QtyBase: Number(it.qty) || 1,
        Notes: `Custom addition from ${bundle} #${unit} audit${it.note ? ' — ' + it.note : ''}`,
      });
    }
  }

  // Re-fetch header to pick up the DocNo (assigned server-side on create in
  // some QW versions; safe re-read either way).
  let docNo = header.docNo;
  if (!docNo) {
    try {
      const refreshed = await fetchHeader(base, apiKey, docId);
      docNo = refreshed && refreshed.data && refreshed.data.attributes && refreshed.data.attributes.DocNo;
    } catch (e) {
      // Non-fatal — the quote exists; we just don't have the human number.
    }
  }
  return { docId, docNo: docNo || null };
}

// ---------------------------------------------------------------------------
// Email the rep. Uses the same SMTP env vars as send-quote.js.
// ---------------------------------------------------------------------------
async function emailRep({ rep, customer, docNo, docId, quoteUrl, panels }) {
  const {
    SMTP_HOST, SMTP_PORT, SMTP_SECURE,
    SMTP_USER, SMTP_PASS, SMTP_FROM_NAME,
  } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    // Email is best-effort — the quote is already created in QW.
    return { sent: false, to: null, reason: 'SMTP not configured' };
  }

  const mapped = REP_EMAIL_MAP[rep];
  const to = mapped || FALLBACK_EMAIL;
  const company = (customer && customer.company) || 'Customer';
  const noStr = docNo || '(pending)';

  const subjectMapped = `Car-O-Liner SW Parts Audit — Quote ${noStr} created for ${company}`;
  const subjectFallback = `Car-O-Liner SW Parts Audit — Quote ${noStr} created — intended for ${rep} — awaiting email lookup`;
  const subject = mapped ? subjectMapped : subjectFallback;

  // Panel summary — brief so the rep can eyeball it in the inbox
  let missingCount = 0, damagedCount = 0, customCount = 0, auditPointsChecked = 0;
  (panels || []).forEach(p => {
    missingCount += (p.missing || []).length;
    damagedCount += (p.damaged || []).length;
    customCount  += (p.custom  || []).length;
    auditPointsChecked += Number(p.auditPointsChecked) || 0;
  });
  const flaggedCount = missingCount + damagedCount + customCount;

  const bodyLines = [
    `A new Parts Audit quote was just created in QuoteWerks Web.`,
    ``,
    `Rep:      ${prettyRep(rep)} (${rep})`,
    `Customer: ${company}${customer && customer.city ? ' — ' + customer.city : ''}${customer && customer.state ? ', ' + customer.state : ''}`,
    `Quote:    ${noStr}`,
    `Panels:   ${(panels || []).length}   Missing: ${missingCount}   Damaged: ${damagedCount}   Custom: ${customCount}`,
    `Audit:    ${auditPointsChecked} audit points checked   ${flaggedCount} items flagged`,
    ``,
    `Open in QuoteWerks Web:`,
    quoteUrl,
    ``,
    `— Car-O-Liner SW Parts Audit app`,
  ];

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 465,
    secure: String(SMTP_SECURE || 'true') === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  await transporter.sendMail({
    from: `"${SMTP_FROM_NAME || 'Car-O-Liner Southwest'}" <${SMTP_USER}>`,
    to,
    subject,
    text: bodyLines.join('\n'),
  });

  return { sent: true, to, mapped: !!mapped };
}

// ---------------------------------------------------------------------------
// Netlify handler
// ---------------------------------------------------------------------------
export const handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ ok: false, error: 'Method Not Allowed' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) }; }

  const { QW_API_KEY, QW_API_BASE } = process.env;
  const base = QW_API_BASE || QW_BASE_DEFAULT;
  if (!QW_API_KEY) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ ok: false, error: 'QW_API_KEY not configured on Netlify' }),
    };
  }

  const action = payload.action;
  try {
    if (action === 'search_customers') {
      const results = await searchCustomers(base, QW_API_KEY, payload.query || '');
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, results }) };
    }

    if (action === 'create_quote') {
      const { rep, customer, panels } = payload;
      const { docId, docNo } = await createQuote(base, QW_API_KEY, { rep, customer, panels });
      const quoteUrl = `https://na.quotewerks.com/#/documents/${docId}`;
      let mail = { sent: false };
      try {
        mail = await emailRep({ rep, customer, docNo, docId, quoteUrl, panels });
      } catch (mailErr) {
        // Don't fail the whole call if email dies — the quote exists.
        mail = { sent: false, error: mailErr.message };
      }
      return {
        statusCode: 200,
        headers: cors,
        body: JSON.stringify({ ok: true, docId, docNo, quoteUrl, mail }),
      };
    }

    return {
      statusCode: 400,
      headers: cors,
      body: JSON.stringify({ ok: false, error: `Unknown action: ${action}` }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ ok: false, error: err.message || 'Unknown error' }),
    };
  }
};

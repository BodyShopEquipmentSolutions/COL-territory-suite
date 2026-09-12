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

// QW SoldTo* column max lengths. QW rejects any value longer than these.
// Column widths per DocumentHeaders schema (NVARCHAR sizes).
const SOLD_TO_MAX = {
  SoldToCompany: 50, SoldToContact: 40,
  SoldToAddress1: 40, SoldToAddress2: 40, SoldToAddress3: 50,
  SoldToCity: 31, SoldToState: 21, SoldToPostalCode: 13, SoldToCountry: 50,
  SoldToPhone: 20, SoldToFax: 20, SoldToEmail: 255,
};
function clip(field, val) {
  if (val == null) return val;
  const s = String(val);
  const max = SOLD_TO_MAX[field];
  return max && s.length > max ? s.slice(0, max) : s;
}

// ---------------------------------------------------------------------------
// Look up a product by ManufacturerPartNumber. Returns { manufacturer, description,
// price, cost, list } or null. Tries the raw SKU first, then a dash-normalized
// variant (CARNA90586 <-> CARNA-90586) because QW's data has both patterns.
// Cache within a single request so repeated parts don't re-hit the API.
// ---------------------------------------------------------------------------
async function lookupProduct(base, apiKey, partNumber, cache, diagErrors) {
  const key = String(partNumber || '').trim();
  if (!key) return null;
  if (cache && cache.has(key)) return cache.get(key);
  const variants = [key];
  // Insert-or-remove dash after a leading letter run (e.g. CARNA90586 -> CARNA-90586)
  const m = key.match(/^([A-Za-z]+)(\d.*)$/);
  if (m) variants.push(`${m[1]}-${m[2]}`);
  if (key.includes('-')) variants.push(key.replace(/-/g, ''));
  let hit = null;
  let lastErr = null;
  for (const val of variants) {
    if (hit) break;
    for (const field of ['ManufacturerPartNumber', 'VendorPartNumber']) {
      const body = {
        filter: [{ name: field, op: 'eq', val }],
        page: { size: 1 },
        fields: { Products_AllProducts_Products: [
          'ManufacturerPartNumber','Manufacturer','Description','Price','Cost','List',
        ] },
      };
      // Retry the search once on transient failure. The QW REST API
      // occasionally 500s or times out; a silent skip leaves $0 prices on the
      // quote and the user thinks the whole system is broken.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await qwFetch(base, apiKey, '/api/v1/qw/tables/Products_AllProducts_Products/search', { method: 'POST', body });
          const rows = Array.isArray(res && res.data) ? res.data : [];
          if (rows.length) { hit = rows[0].attributes || {}; }
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (attempt === 0) await new Promise(r => setTimeout(r, 250));
        }
      }
      if (hit) break;
    }
  }
  if (!hit && diagErrors) {
    diagErrors.push({
      sku: key,
      error: lastErr ? (lastErr.message || String(lastErr)).slice(0, 120) : 'no_match',
    });
  }
  const out = hit ? {
    manufacturer: hit.Manufacturer || '',
    description: hit.Description || '',
    price: Number(hit.Price) || 0,
    cost:  Number(hit.Cost)  || 0,
    list:  Number(hit.List)  || 0,
  } : null;
  if (cache) cache.set(key, out);
  return out;
}

// ---------------------------------------------------------------------------
// Fetch the full CRMCompanies record + PrimaryContact for a customer.id and
// merge it into the customer object the frontend sent, keeping frontend values
// as the authoritative source when both exist.
// ---------------------------------------------------------------------------
async function enrichCustomer(base, apiKey, customer, diag) {
  if (!customer || !customer.id) return customer || null;
  let company = null;
  let lastErr = null;
  // Retry once on transient QW REST failure. Silent-swallow leaves the quote
  // with empty SoldToAddress1/SoldToContact/PostalCode/Country and no signal
  // to the user — the whole point of enrichment.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await qwFetch(base, apiKey,
        `/api/v1/qw/tables/CRMCompanies/${encodeURIComponent(customer.id)}`);
      company = res && res.data && res.data.attributes ? res.data.attributes : null;
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await new Promise(r => setTimeout(r, 250));
    }
  }
  if (!company) {
    if (diag && lastErr) diag.enrichError = (lastErr.message || String(lastErr)).slice(0, 200);
    return customer;
  }
  // Try to also pull the primary contact's name for SoldToContact.
  let contactName = '';
  const contactRecGuid = company.PrimaryContactRecGUID;
  if (contactRecGuid) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await qwFetch(base, apiKey,
          `/api/v1/qw/tables/CRMContacts/${encodeURIComponent(contactRecGuid)}`);
        const a = res && res.data && res.data.attributes ? res.data.attributes : {};
        contactName = a.ContactName ||
          [a.FirstName, a.LastName].filter(Boolean).join(' ') || '';
        break;
      } catch {
        if (attempt === 0) await new Promise(r => setTimeout(r, 250));
      }
    }
  }
  // Merge — frontend value wins if present and non-empty; otherwise use QW record.
  const pick = (frontVal, qwVal) => (frontVal && String(frontVal).trim()) ? frontVal : (qwVal || '');
  return {
    ...customer,
    company: pick(customer.company || customer.customer, company.CompanyName),
    contact: pick(customer.contact || customer.attention, contactName),
    address: pick(customer.address, company.Address1),
    address2: pick(customer.address2, company.Address2),
    city:    pick(customer.city, company.City),
    state:   pick(customer.state, company.State),
    zip:     pick(customer.zip, company.PostalCode),
    country: pick(customer.country, company.Country),
    phone:   pick(customer.phone, company.PhoneMain),
    fax:     pick(customer.fax, company.Fax),
    // SoldToEmail intentionally NOT populated — the send-from-rep flow always
    // sends to the rep, and QW's Deliver dialog would otherwise auto-populate
    // this field with the customer's email, risking accidental customer sends.
  };
}

async function createHeader(base, apiKey, { rep, customer }) {
  // QW's REST API does NOT auto-populate SoldTo fields from a CRM link on POST.
  // Send every field the frontend has — and also stamp SoldToCMCompanyRecID
  // so the quote stays associated with the CRM record for future lookups.
  const attrs = {
    DocType: 'QUOTE',
    DocStatus: 'Open',
    DocDate: nowIso(),
    SalesRep: rep,
    PreparedBy: rep,
    CreatedBy: rep,
  };
  if (customer) {
    const company = customer.company || customer.customer;
    if (company)           attrs.SoldToCompany  = clip('SoldToCompany',  company);
    if (customer.city)     attrs.SoldToCity     = clip('SoldToCity',     customer.city);
    if (customer.state)    attrs.SoldToState    = clip('SoldToState',    customer.state);
    if (customer.phone)    attrs.SoldToPhone    = clip('SoldToPhone',    customer.phone);
    if (customer.fax)      attrs.SoldToFax      = clip('SoldToFax',      customer.fax);
    if (customer.address)  attrs.SoldToAddress1 = clip('SoldToAddress1', customer.address);
    if (customer.address2) attrs.SoldToAddress2 = clip('SoldToAddress2', customer.address2);
    // QW's field is SoldToPostalCode, NOT SoldToZip.
    if (customer.zip)      attrs.SoldToPostalCode = clip('SoldToPostalCode', customer.zip);
    if (customer.country)  attrs.SoldToCountry    = clip('SoldToCountry',    customer.country);
    if (customer.contact || customer.attention)
      attrs.SoldToContact = clip('SoldToContact', customer.contact || customer.attention);
    // SoldToEmail intentionally left blank — see enrichCustomer() note.
    if (customer.id) attrs.SoldToCMCompanyRecID = String(customer.id);
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

  // Diagnostics we return on the response so the caller can see whether
  // enrichment and pricing lookups actually happened.
  const diag = {
    customerIn: customer ? Object.keys(customer).sort() : null,
    enrichAttempted: false,
    enrichHit: false,
    enrichError: null,
    contactHit: false,
    productLookups: 0,
    productHits: 0,
    productMisses: [], // {sku, error?} for each unhit lookup
  };

  // Enrich the customer object with the full CRMCompanies + primary contact record
  // before creating the header, so SoldTo* fields aren't empty.
  let fullCustomer = customer;
  if (customer && customer.id) {
    diag.enrichAttempted = true;
    try {
      const enriched = await enrichCustomer(base, apiKey, customer, diag);
      if (enriched && enriched !== customer) {
        diag.enrichHit = true;
        diag.contactHit = !!(enriched.contact && enriched.contact !== customer.contact);
      }
      fullCustomer = enriched;
    } catch (e) {
      diag.enrichError = e?.message || String(e);
    }
  }
  const header = await createHeader(base, apiKey, { rep, customer: fullCustomer });
  const docId = header.id;

  // Product lookup cache shared across the whole quote.
  const productCache = new Map();

  // Build the FULL line plan up front, then dispatch in parallel.
  const plan = [];
  for (const panel of panels) {
    const bundle = panel.bundle_name || 'Bundle';
    const unit = panel.unit_number || 1;
    const missing = Array.isArray(panel.missing) ? panel.missing : [];
    const damaged = Array.isArray(panel.damaged) ? panel.damaged : [];
    const custom  = Array.isArray(panel.custom)  ? panel.custom  : [];
    if (!missing.length && !damaged.length && !custom.length) continue;

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
    // One line per unique parent SKU. QW's REST API stores whatever fields
    // you send verbatim — it does NOT pull from the product database on POST,
    // so we resolve pricing/manufacturer/description ourselves from
    // Products_AllProducts_Products and stamp them on the line.
    for (const rollup of rollups.values()) {
      const billableQty = rollup.isExpanded ? 1 : (Number(rollup.leaves[0].qty) || 1);
      diag.productLookups += 1;
      const prod = await lookupProduct(base, apiKey, rollup.partNumber, productCache, diag.productMisses);
      if (prod) diag.productHits += 1;
      plan.push({
        LineType: 1,
        Manufacturer: prod?.manufacturer || 'COL',
        ManufacturerPartNumber: rollup.partNumber,
        PartNumber: rollup.partNumber,
        Description: prod?.description || rollup.description,
        QtyBase: billableQty,
        UnitPrice: prod?.price || 0,
        UnitCost:  prod?.cost  || 0,
        UnitList:  prod?.list  || prod?.price || 0,
      });
    }
    for (const it of custom) {
      const pn = it.partNumber || (it.id ? `CAR${it.id}` : '');
      diag.productLookups += 1;
      const prod = await lookupProduct(base, apiKey, pn, productCache, diag.productMisses);
      if (prod) diag.productHits += 1;
      plan.push({
        LineType: 1,
        Manufacturer: prod?.manufacturer || 'COL',
        ManufacturerPartNumber: pn,
        PartNumber: pn,
        Description: prod?.description || it.description || '',
        QtyBase: Number(it.qty) || 1,
        UnitPrice: prod?.price || 0,
        UnitCost:  prod?.cost  || 0,
        UnitList:  prod?.list  || prod?.price || 0,
      });
    }
  }

  // Sequential insert preserves LineNumberActual assignment order in QW.
  // The frontend collapses whole-assembly rollups so this loop stays small.
  for (let i = 0; i < plan.length; i++) {
    await createLine(base, apiKey, docId, { LineNumberActual: i + 1, ...plan[i] });
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
  return { docId, docNo: docNo || null, diag };
}

// ---------------------------------------------------------------------------
// Email the rep. Two paths:
//   1) QW send: log into QW as the rep and drive the internal Deliver → Email
//      → Send flow (via send-from-rep function). Delivers the actual PDF
//      quote FROM the rep's Google mailbox with a permanent record in QW.
//   2) SMTP fallback: notify-only text email through noreply.colsw@gmail.com.
//      No PDF attachment; used only when the QW send path errors.
// ---------------------------------------------------------------------------
async function emailRep({ rep, customer, docNo, docId, quoteUrl, panels }) {
  const mapped = REP_EMAIL_MAP[rep];
  const to = mapped || FALLBACK_EMAIL;
  let qwErr = null;

  // Path 1 — QW send. Preferred: delivers the actual PDF from QW itself.
  if (docId && rep) {
    try {
      // Call our own send-from-rep function. Netlify functions can invoke
      // one another over the public URL; the site's base URL is in URL env.
      const siteUrl = process.env.URL || process.env.DEPLOY_URL || 'https://bodyshopequipment.solutions';
      // send-from-rep is now fire-and-forget on the QW SendEmail step, so it
      // returns in ~5-8s (login + deliver init + PDF gen + composer + 2s
      // dispatch window). Give it 12s of slack. Netlify function total cap
      // is 26s and create-qw-quote may spend some of that on line inserts.
      const resp = await fetch(`${siteUrl}/.netlify/functions/send-from-rep`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          docRecGuid: docId,
          repUsername: rep,
          repEmail: to,
        }),
        signal: AbortSignal.timeout(15000),
      });
      const body = await resp.json().catch(() => ({}));
      if (resp.ok && body.ok) {
        return {
          sent: true,
          to: body.to,
          from: body.from,
          via: 'qw',
          subject: body.subject,
          attachments: body.attachments,
          mapped: !!mapped,
        };
      }
      qwErr = body.error || `http ${resp.status}`;
    } catch (e) {
      qwErr = e?.message || String(e);
    }
  }

  // Path 2 — SMTP fallback (notify-only, no PDF).
  const {
    SMTP_HOST, SMTP_PORT, SMTP_SECURE,
    SMTP_USER, SMTP_PASS, SMTP_FROM_NAME,
  } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    return { sent: false, to: null, reason: 'SMTP not configured', qwError: qwErr };
  }

  const company = (customer && customer.company) || 'Customer';
  const noStr = docNo || '(pending)';

  const subjectMapped = `Car-O-Liner SW Parts Audit — Quote ${noStr} created for ${company}`;
  const subjectFallback = `Car-O-Liner SW Parts Audit — Quote ${noStr} created — intended for ${rep} — awaiting email lookup`;
  const subject = mapped ? subjectMapped : subjectFallback;

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
    `NOTE: This is the SMTP fallback notification. The primary QW-send`,
    `path could not deliver the PDF attachment.`,
    qwErr ? `Reason: ${qwErr}` : ``,
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

  return { sent: true, to, via: 'smtp-fallback', mapped: !!mapped, qwError: qwErr };
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
      const { docId, docNo, diag } = await createQuote(base, QW_API_KEY, { rep, customer, panels });
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
        body: JSON.stringify({ ok: true, docId, docNo, quoteUrl, mail, diag }),
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

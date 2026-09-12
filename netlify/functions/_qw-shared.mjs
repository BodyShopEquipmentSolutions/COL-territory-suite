// _qw-shared.mjs
// Shared helpers for the QuoteWerks flow. Consumed by:
//   * create-qw-quote.js            (foreground, 26s budget)
//   * create-qw-quote-background.js (background, 15min budget)
//
// Filename starts with '_' so Netlify does not deploy it as its own function.
// ESM — package.json has "type": "module".

import nodemailer from 'nodemailer';

export const QW_BASE_DEFAULT = 'https://qwwapi.quotewerks.com';
export const FALLBACK_EMAIL = 'bodyshop.e.s@gmail.com';

// ---------------------------------------------------------------------------
// Thin QW REST helper. Every call injects X-API-Key. Retries 429 with backoff.
// ---------------------------------------------------------------------------
export async function qwFetch(base, apiKey, path, opts = {}) {
  const url = base.replace(/\/+$/, '') + path;
  const headers = {
    'X-API-Key': apiKey,
    'Accept': 'application/json',
    ...(opts.headers || {}),
  };
  if (opts.body != null && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers,
      body: opts.body != null ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* leave data null */ }
    if (res.status === 429 && attempt < MAX_ATTEMPTS) {
      const ra = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(ra) && ra > 0
        ? Math.min(ra * 1000, 8000)
        : Math.min(500 * Math.pow(2, attempt - 1), 4000) + Math.floor(Math.random() * 250);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }
    if (!res.ok) {
      const snippet = text ? text.slice(0, 400) : '';
      const err = new Error(`QW ${opts.method || 'GET'} ${path} -> ${res.status}${snippet ? ': ' + snippet : ''}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }
  throw new Error(`QW ${opts.method || 'GET'} ${path} -> exhausted retries`);
}

// ---------------------------------------------------------------------------
// Rep email lookup — pulls from QW's UserSettings table on every request.
// ---------------------------------------------------------------------------
export async function resolveRepEmail(base, apiKey, repUsername) {
  if (!repUsername) return { email: FALLBACK_EMAIL, source: 'fallback:no-rep' };
  try {
    const body = {
      filter: [
        { name: 'UserName', op: 'eq', val: repUsername },
        { or: [
          { name: 'KeyName', op: 'eq', val: 'EmailAddress' },
          { name: 'KeyName', op: 'eq', val: 'EMailAddress' },
          { name: 'KeyName', op: 'eq', val: 'Email' },
        ]},
      ],
      page: { size: 5 },
      fields: { UserSettings: ['UserName','KeyName','KeyValue'] },
    };
    const data = await qwFetch(base, apiKey, '/api/v1/qw/tables/UserSettings/search', { method: 'POST', body });
    const rows = Array.isArray(data && data.data) ? data.data : [];
    for (const r of rows) {
      const v = (r.attributes && r.attributes.KeyValue) || '';
      if (v && v.includes('@')) return { email: v.trim(), source: 'qw:UserSettings' };
    }
    return { email: FALLBACK_EMAIL, source: 'fallback:no-email-in-qw' };
  } catch (e) {
    return { email: FALLBACK_EMAIL, source: 'fallback:qw-error', error: (e && e.message) || String(e) };
  }
}

export function prettyRep(username) {
  if (!username) return '';
  if (username.startsWith('<') && username.endsWith('>')) return username;
  return username
    .split('.')
    .map(s => s ? s[0].toUpperCase() + s.slice(1) : s)
    .join(' ');
}

// ---------------------------------------------------------------------------
// Product lookup helpers.
// ---------------------------------------------------------------------------
export async function lookupProduct(base, apiKey, partNumber, cache, diagErrors) {
  const key = String(partNumber || '').trim();
  if (!key) return null;
  if (cache && cache.has(key)) return cache.get(key);
  const variants = [key];
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

export async function bulkLookupProducts(base, apiKey, skus, cache, diagErrors) {
  const clean = Array.from(new Set(skus.map(s => String(s || '').trim()).filter(Boolean)));
  if (!clean.length) return;

  const variantsFor = (key) => {
    const out = new Set([key]);
    const m = key.match(/^([A-Za-z]+)(\d.*)$/);
    if (m) out.add(`${m[1]}-${m[2]}`);
    if (key.includes('-')) out.add(key.replace(/-/g, ''));
    return Array.from(out);
  };
  const variantIndex = new Map();
  for (const key of clean) {
    if (cache.has(key)) continue;
    for (const v of variantsFor(key)) {
      if (!variantIndex.has(v)) variantIndex.set(v, []);
      variantIndex.get(v).push(key);
    }
  }
  if (variantIndex.size === 0) return;

  const allVariants = Array.from(variantIndex.keys());
  const CHUNK = 80;
  for (let start = 0; start < allVariants.length; start += CHUNK) {
    const chunk = allVariants.slice(start, start + CHUNK);
    for (const field of ['ManufacturerPartNumber', 'VendorPartNumber']) {
      const needed = chunk.filter(v =>
        variantIndex.get(v).some(orig => !cache.has(orig) || cache.get(orig) == null)
      );
      if (!needed.length) continue;
      const body = {
        filter: [{ name: field, op: 'in', val: needed }],
        page: { size: needed.length + 10 },
        fields: { Products_AllProducts_Products: [
          'ManufacturerPartNumber','VendorPartNumber','Manufacturer','Description','Price','Cost','List',
        ] },
      };
      try {
        const res = await qwFetch(base, apiKey, '/api/v1/qw/tables/Products_AllProducts_Products/search', { method: 'POST', body });
        const rows = Array.isArray(res && res.data) ? res.data : [];
        for (const row of rows) {
          const hit = row.attributes || {};
          const matched = String(hit[field] || '').trim();
          if (!matched) continue;
          const originals = variantIndex.get(matched) || [];
          const productObj = {
            manufacturer: hit.Manufacturer || '',
            description: hit.Description || '',
            price: Number(hit.Price) || 0,
            cost:  Number(hit.Cost)  || 0,
            list:  Number(hit.List)  || 0,
          };
          for (const orig of originals) {
            if (!cache.has(orig) || cache.get(orig) == null) cache.set(orig, productObj);
          }
        }
      } catch (e) {
        if (diagErrors) diagErrors.push({ bulk: field, error: (e.message || String(e)).slice(0, 200) });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Header + line insert.
// ---------------------------------------------------------------------------
export function nowIso() {
  return new Date().toISOString();
}

export const SOLD_TO_MAX = {
  SoldToCompany: 50, SoldToContact: 40,
  SoldToAddress1: 40, SoldToAddress2: 40, SoldToAddress3: 50,
  SoldToCity: 31, SoldToState: 21, SoldToPostalCode: 13, SoldToCountry: 50,
  SoldToPhone: 20, SoldToFax: 20, SoldToEmail: 255,
};
export function clip(field, val) {
  if (val == null) return val;
  const s = String(val);
  const max = SOLD_TO_MAX[field];
  return max && s.length > max ? s.slice(0, max) : s;
}

export async function enrichCustomer(base, apiKey, customer, diag) {
  if (!customer || !customer.id) return customer || null;
  let company = null;
  let lastErr = null;
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
  };
}

export async function createHeader(base, apiKey, { rep, customer }) {
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
    if (customer.zip)      attrs.SoldToPostalCode = clip('SoldToPostalCode', customer.zip);
    if (customer.country)  attrs.SoldToCountry    = clip('SoldToCountry',    customer.country);
    if (customer.contact || customer.attention)
      attrs.SoldToContact = clip('SoldToContact', customer.contact || customer.attention);
    if (customer.id) attrs.SoldToCMCompanyRecID = String(customer.id);
  }
  const body = { data: { type: 'DocumentHeaders', attributes: attrs } };
  const res = await qwFetch(base, apiKey, '/api/v1/qw/tables/DocumentHeaders', { method: 'POST', body });
  const id = res && res.data && res.data.id;
  const docNo = res && res.data && res.data.attributes && res.data.attributes.DocNo;
  if (!id) throw new Error('QW did not return a DocID for the new header');
  return { id, docNo: docNo || null };
}

export async function createLine(base, apiKey, docRecGuid, attrs) {
  const body = {
    data: {
      type: 'DocumentItems',
      attributes: { DocRecGUID: docRecGuid, ...attrs },
    },
  };
  return qwFetch(base, apiKey, '/api/v1/qw/tables/DocumentItems', { method: 'POST', body });
}

export async function fetchHeader(base, apiKey, docId) {
  return qwFetch(base, apiKey, `/api/v1/qw/tables/DocumentHeaders/${encodeURIComponent(docId)}`);
}

// ---------------------------------------------------------------------------
// Build the line plan from panels. Shared rollup logic used by both the
// foreground (small quotes) and background (large quotes) paths.
// ---------------------------------------------------------------------------
export async function buildLinePlan(base, apiKey, panels, diag) {
  const productCache = new Map();

  const allSkus = [];
  for (const panel of (Array.isArray(panels) ? panels : [])) {
    const push = (arr) => (Array.isArray(arr) ? arr : []).forEach(it => {
      const sku = it && (it.parentPartNumber || it.partNumber);
      if (sku) allSkus.push(sku);
      if (it && it.partNumber) allSkus.push(it.partNumber);
    });
    push(panel.missing); push(panel.damaged); push(panel.custom);
  }
  diag.bulkLookupErrors = [];
  await bulkLookupProducts(base, apiKey, allSkus, productCache, diag.bulkLookupErrors);
  diag.bulkPrewarmed = productCache.size;

  const plan = [];
  for (const panel of (panels || [])) {
    const missing = Array.isArray(panel.missing) ? panel.missing : [];
    const damaged = Array.isArray(panel.damaged) ? panel.damaged : [];
    const custom  = Array.isArray(panel.custom)  ? panel.custom  : [];
    if (!missing.length && !damaged.length && !custom.length) continue;

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
        partNumber, description, leaves: [],
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

    const rollupsArr = Array.from(rollups.values());
    const rollupResolved = await Promise.all(rollupsArr.map(async (rollup) => {
      diag.productLookups += 1;
      const prod = await lookupProduct(base, apiKey, rollup.partNumber, productCache, diag.productMisses);
      if (prod) diag.productHits += 1;
      const billableQty = rollup.isExpanded ? 1 : (Number(rollup.leaves[0].qty) || 1);
      return {
        LineType: 1,
        Manufacturer: prod?.manufacturer || 'COL',
        ManufacturerPartNumber: rollup.partNumber,
        PartNumber: rollup.partNumber,
        Description: prod?.description || rollup.description,
        QtyBase: billableQty,
        UnitPrice: prod?.price || 0,
        UnitCost:  prod?.cost  || 0,
        UnitList:  prod?.list  || prod?.price || 0,
      };
    }));
    plan.push(...rollupResolved);

    const customResolved = await Promise.all(custom.map(async (it) => {
      const pn = it.partNumber || (it.id ? `CAR${it.id}` : '');
      diag.productLookups += 1;
      const prod = await lookupProduct(base, apiKey, pn, productCache, diag.productMisses);
      if (prod) diag.productHits += 1;
      return {
        LineType: 1,
        Manufacturer: prod?.manufacturer || 'COL',
        ManufacturerPartNumber: pn,
        PartNumber: pn,
        Description: prod?.description || it.description || '',
        QtyBase: Number(it.qty) || 1,
        UnitPrice: prod?.price || 0,
        UnitCost:  prod?.cost  || 0,
        UnitList:  prod?.list  || prod?.price || 0,
      };
    }));
    plan.push(...customResolved);
  }
  return plan;
}

export async function insertLinesSequential(base, apiKey, docId, plan, diag) {
  const numbered = plan.map((p, i) => ({ LineNumberActual: i + 1, ...p }));
  diag.linesPlanned = numbered.length;
  diag.linesInserted = 0;
  diag.insertErrors = [];
  for (const row of numbered) {
    try {
      await createLine(base, apiKey, docId, row);
      diag.linesInserted += 1;
    } catch (e) {
      diag.insertErrors.push({ line: row.LineNumberActual, sku: row.PartNumber, error: (e.message || String(e)).slice(0, 200) });
    }
  }
}

// ---------------------------------------------------------------------------
// Email the rep. Two paths: QW send (PDF) or SMTP fallback (notify-only).
// ---------------------------------------------------------------------------
export async function emailRep({ rep, customer, docNo, docId, quoteUrl, panels, base, apiKey, siteUrl }) {
  const resolved = await resolveRepEmail(base, apiKey, rep);
  const to = resolved.email;
  const mapped = resolved.source === 'qw:UserSettings';
  let qwErr = null;

  if (docId && rep) {
    try {
      const site = siteUrl || process.env.URL || process.env.DEPLOY_URL || 'https://bodyshopequipment.solutions';
      const resp = await fetch(`${site}/.netlify/functions/send-from-rep`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docRecGuid: docId, repUsername: rep, repEmail: to }),
        signal: AbortSignal.timeout(15000),
      });
      const body = await resp.json().catch(() => ({}));
      if (resp.ok && body.ok) {
        return {
          sent: true, to: body.to, from: body.from, via: 'qw',
          subject: body.subject, attachments: body.attachments,
          mapped: !!mapped, emailSource: resolved.source,
        };
      }
      qwErr = body.error || `http ${resp.status}`;
    } catch (e) {
      qwErr = e?.message || String(e);
    }
  }

  // SMTP fallback
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM_NAME } = process.env;
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
    to, subject, text: bodyLines.join('\n'),
  });
  return { sent: true, to, via: 'smtp-fallback', mapped: !!mapped, qwError: qwErr };
}

// Convenience: how many audited items are in a panels payload (used to
// decide foreground vs background execution path).
export function totalPanelItems(panels) {
  let n = 0;
  for (const p of (Array.isArray(panels) ? panels : [])) {
    n += (Array.isArray(p.missing) ? p.missing.length : 0);
    n += (Array.isArray(p.damaged) ? p.damaged.length : 0);
    n += (Array.isArray(p.custom)  ? p.custom.length  : 0);
  }
  return n;
}

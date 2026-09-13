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
//   (no SMTP env needed — QW is the only email path)
//                (reused from send-quote.js — same shared mailbox)



const QW_BASE_DEFAULT = 'https://qwwapi.quotewerks.com';

// ---------------------------------------------------------------------------
// Rep username -> email map. QW SecurityAccounts has no email column, so this
// is Ryan-editable. Anything not in the map falls through to a shared inbox
// with a subject line noting the intended rep.
// ---------------------------------------------------------------------------
// Live rep email lookup — pulls from QW's UserSettings table on every request
// (row where KeyName='EmailAddress' and UserName matches the rep username).
// This replaces the old hardcoded REP_EMAIL_MAP so the app never falls out of
// sync with QW after adding/removing reps or changing addresses.
const FALLBACK_EMAIL = 'bodyshop.e.s@gmail.com';

async function resolveRepEmail(base, apiKey, repUsername) {
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

async function createHeader(base, apiKey, { rep, customer, shippingAmount }) {
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
  // Shipping/freight lives on the header (drives the Shipping box next to
  // Sales Tax in the PDF layout) — NOT as a line item. Populate both
  // primary and secondary-currency fields QW uses.
  if (Number(shippingAmount) > 0) {
    const amt = Number(shippingAmount);
    attrs.ShippingAmount = amt;
    attrs.AlternateShippingAmount = amt;
    attrs.ShippingCost = amt;
  }
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
    // Mirror SoldTo -> ShipTo so QW's native "Automatic Sales Tax Rates"
    // lookup (which keys off ShipTo address) has something to work with.
    // Reps can edit ShipTo in QW if the ship-to differs from sold-to.
    if (company)           attrs.ShipToCompany  = clip('SoldToCompany',  company);
    if (customer.city)     attrs.ShipToCity     = clip('SoldToCity',     customer.city);
    if (customer.state)    attrs.ShipToState    = clip('SoldToState',    customer.state);
    if (customer.phone)    attrs.ShipToPhone    = clip('SoldToPhone',    customer.phone);
    if (customer.address)  attrs.ShipToAddress1 = clip('SoldToAddress1', customer.address);
    if (customer.address2) attrs.ShipToAddress2 = clip('SoldToAddress2', customer.address2);
    if (customer.zip)      attrs.ShipToPostalCode = clip('SoldToPostalCode', customer.zip);
    if (customer.country)  attrs.ShipToCountry    = clip('SoldToCountry',    customer.country);
    if (customer.contact || customer.attention)
      attrs.ShipToContact = clip('SoldToContact', customer.contact || customer.attention);
    if (customer.id) attrs.ShipToCMCompanyRecID = String(customer.id);
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

async function createQuote(base, apiKey, { rep, customer, panels, addons }) {
  if (!rep) throw new Error('rep is required');
  if (!panels || !panels.length) throw new Error('At least one audit panel is required');
  addons = addons || {};

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
  const header = await createHeader(base, apiKey, {
    rep,
    customer: fullCustomer,
    shippingAmount: Number(addons.freight) || 0,
  });
  const docId = header.id;

  // Product lookup cache shared across the whole quote.
  const productCache = new Map();

  // Build the FULL line plan up front, then dispatch in parallel.
  // Structure:
  //   1) Parts (from panel.order + custom)
  //   2) Logistics Surcharge (single line, no header, 1.5% of CAR* subtotal)
  //   3) "Training and Installation" comment header (or just "Training" or
  //      just "Installation" if only one category is selected)
  //   4) Training and Installation items
  //   5) Shipping / Freight (single line)
  //   6) Sales Tax (single line, rate resolved from customer address)
  const plan = [];
  // Track where panel item lines end so we can compute the equipment subtotal
  // for the discount BEFORE logistics/training/installation/freight/tax.
  let equipmentEndIdx = 0;
  for (const panel of panels) {
    // panels[].order is the new field. Fall back to .missing + .damaged for
    // any old payloads still in flight.
    const orderItems = Array.isArray(panel.order)
      ? panel.order
      : [].concat(
          Array.isArray(panel.missing) ? panel.missing : [],
          Array.isArray(panel.damaged) ? panel.damaged : []
        );
    const custom = Array.isArray(panel.custom) ? panel.custom : [];
    if (!orderItems.length && !custom.length) continue;

    // Per-bundle section header so the printed quote clearly groups items
    // under "BenchRack 5500", "CTR9", etc. Include unit# only when the caller
    // is quoting more than one of the same bundle.
    const bundleName = (panel.bundle_name || '').trim();
    if (bundleName) {
      const sameNameCount = panels.filter(p => (p.bundle_name || '').trim() === bundleName).length;
      const headerText = sameNameCount > 1 && panel.unit_number
        ? `${bundleName} (Unit ${panel.unit_number})`
        : bundleName;
      plan.push({
        LineType: 2, // Comment line — QW renders as a visual divider / section header
        Manufacturer: '',
        ManufacturerPartNumber: '',
        PartNumber: '',
        Description: headerText,
        QtyBase: 0,
        UnitPrice: 0,
        UnitCost: 0,
        UnitList: 0,
      });
    }

    // BOM leaves identify their sellable parent through parentPartNumber.
    // Consolidate every flagged leaf beneath one parent SKU.
    const rollups = new Map();
    orderItems.forEach(it => {
      const partNumber = it.parentPartNumber || it.partNumber || '';
      const description = it.parentDescription || it.description || '';
      const key = `${partNumber}\u0000${description}`;
      if (!rollups.has(key)) rollups.set(key, {
        partNumber,
        description,
        leaves: [],
        // "Expanded" means we itemize sub-parts as comments under the parent SKU.
        // If the user marked the whole assembly to order, we quote the parent
        // as ONE line with no sub-part detail.
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
  equipmentEndIdx = plan.length;

  // ---- Discount (applied to equipment subtotal, BEFORE logistics/training/
  //      installation/freight/tax) ----
  // addons.discount = { type: 'percent' | 'flat', value: number }
  // Percent is expressed as e.g. 5 for 5%, not 0.05.
  const discount = addons && addons.discount;
  if (discount && Number(discount.value) > 0) {
    // Sum only the equipment lines emitted so far — LineType 1 items, excluding
    // the section-header comment lines we just inserted.
    const equipmentSubtotal = plan
      .slice(0, equipmentEndIdx)
      .filter(l => l.LineType === 1)
      .reduce((s, l) => s + (Number(l.UnitPrice)||0) * (Number(l.QtyBase)||0), 0);
    let discountAmount = 0;
    let label = '';
    if (discount.type === 'percent') {
      const pct = Number(discount.value) || 0;
      discountAmount = Math.round(equipmentSubtotal * (pct/100) * 100) / 100;
      label = `Discount (${pct}% of equipment subtotal)`;
    } else {
      discountAmount = Math.round((Number(discount.value) || 0) * 100) / 100;
      // Cap flat discount at equipment subtotal so we never go negative.
      if (discountAmount > equipmentSubtotal) discountAmount = equipmentSubtotal;
      label = 'Discount';
    }
    if (discountAmount > 0) {
      diag.discountBase = equipmentSubtotal;
      diag.discountAmount = discountAmount;
      plan.push({
        LineType: 1,
        Manufacturer: 'COL',
        ManufacturerPartNumber: 'DISCOUNT',
        PartNumber: 'DISCOUNT',
        Description: label,
        QtyBase: 1,
        // Negative unit price so it subtracts from the quote total in QW.
        UnitPrice: -discountAmount,
        UnitCost: 0,
        UnitList: -discountAmount,
      });
    }
  }

  // ---- Add-ons (in EXACT order Ryan wants on the printed quote) ----

  // 1) Logistics Surcharge — 1.5% of every CAR* part currently in the plan.
  //    Compute against the actual resolved UnitPrice × QtyBase so quantities
  //    and QW catalog prices are respected (front-end can't see either).
  if (addons.logistics) {
    const rate = Number(addons.logisticsRate) || 0.015;
    const carSubtotal = plan
      .filter(l => l.LineType === 1 && /^CAR/i.test(l.PartNumber || l.ManufacturerPartNumber || ''))
      .reduce((s, l) => s + (Number(l.UnitPrice)||0) * (Number(l.QtyBase)||0), 0);
    const surchargeAmount = Math.round(carSubtotal * rate * 100) / 100;
    if (surchargeAmount > 0) {
      diag.logisticsBase = carSubtotal;
      diag.logisticsAmount = surchargeAmount;
      plan.push({
        LineType: 1,
        Manufacturer: 'COL',
        ManufacturerPartNumber: 'LOGISTICS',
        PartNumber: 'LOGISTICS',
        Description: `Logistics Surcharge (${(rate*100).toFixed(1)}% of CAR* parts)`,
        QtyBase: 1,
        UnitPrice: surchargeAmount,
        UnitCost: 0,
        UnitList: surchargeAmount,
      });
    }
  }

  // 2) Training / Installation header + items
  const training = Array.isArray(addons.training) ? addons.training.filter(t => t && t.sku) : [];
  const installation = Array.isArray(addons.installation) ? addons.installation.filter(t => t && t.sku) : [];
  if (training.length || installation.length) {
    let headerText;
    if (training.length && installation.length) headerText = 'Installation and Training';
    else if (training.length) headerText = 'Training';
    else headerText = 'Installation';
    plan.push({
      LineType: 2, // Comment line — shows as visual divider in QW
      Manufacturer: '',
      ManufacturerPartNumber: '',
      PartNumber: '',
      Description: headerText,
      QtyBase: 0,
      UnitPrice: 0,
      UnitCost: 0,
      UnitList: 0,
    });
    for (const t of training) {
      plan.push({
        LineType: 1,
        Manufacturer: 'COL',
        ManufacturerPartNumber: t.sku,
        PartNumber: t.sku,
        Description: t.label,
        QtyBase: 1,
        UnitPrice: Number(t.price) || 0,
        UnitCost: 0,
        UnitList: Number(t.price) || 0,
      });
    }
    for (const t of installation) {
      plan.push({
        LineType: 1,
        Manufacturer: 'COL',
        ManufacturerPartNumber: t.sku,
        PartNumber: t.sku,
        Description: t.label,
        QtyBase: 1,
        UnitPrice: Number(t.price) || 0,
        UnitCost: 0,
        UnitList: Number(t.price) || 0,
      });
    }
  }

  // 3) Shipping / Freight — intentionally NOT added as a line item.
  //    It's set on the DocumentHeaders row (ShippingAmount) so the layout's
  //    Shipping box (right next to Sales Tax at the bottom of the quote) fills
  //    itself. See createHeader() where shippingAmount is written to attrs.

  // NOTE: Sales tax is intentionally NOT added as a line item here.
  // QuoteWerks has native tax handling via LocalTax/LocalTaxRate/TotalTax on
  // DocumentHeaders and can auto-lookup by ShipTo address (Real-time Data
  // module, already licensed). Reps click "Lookup Tax Rate" in QW after
  // opening the quote, or QW can pull it automatically from the CRM. Rolling
  // our own would create two sources of truth and conflict with QW's engine.

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
// Email the rep via QW. Logs into QW as the rep and drives the internal
// Deliver → Email → Send flow (via send-from-rep function). Delivers the
// actual PDF quote from the rep's Google mailbox with a permanent record
// in QW. If QW SendEmail fails, we surface the error — no SMTP fallback,
// no cover-up. Ryan wants to see the real failure so QW-side issues get
// noticed instead of masked.
// ---------------------------------------------------------------------------
async function emailRep({ rep, docId, base, apiKey }) {
  const resolved = await resolveRepEmail(base, apiKey, rep);
  const to = resolved.email;
  const mapped = resolved.source === 'qw:UserSettings';

  if (!docId || !rep) {
    return { sent: false, to: null, error: 'missing docId or rep', mapped: !!mapped, emailSource: resolved.source };
  }

  const siteUrl = process.env.URL || process.env.DEPLOY_URL || 'https://bodyshopequipment.solutions';
  // send-from-rep is a BACKGROUND function (file ends in -background.js). Netlify's
  // edge/CDN has a hard 30s inactivity timeout on every HTTPS request, INCLUDING
  // function-to-function calls within the same site. A synchronous invocation of
  // We bypass QW's SendEmail entirely: log into QW, generate the same PDF the
  // Preview button produces (qwPrintMethod: 1), download the bytes via
  // PrintPreviewPdf?id=<uuid>, and send from bodyshop.e.s@gmail.com over Gmail
  // SMTP directly to the rep. This completes in ~8s and returns a real
  // messageId instead of the QW SendEmail 30s+ hang.
  try {
    const resp = await fetch(`${siteUrl}/.netlify/functions/send-quote-via-gmail`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        docRecGuid: docId,
        repUsername: rep,
        repEmail: to,
      }),
      // Full round-trip is normally ~9s; give it room without approaching the
      // 26s Netlify edge cap so we can still return a clean error.
      signal: AbortSignal.timeout(25000),
    });
    const body = await resp.json().catch(() => ({}));
    if (resp.status === 200 && body?.ok) {
      return {
        queued: false,
        sent: true,
        to,
        via: 'gmail-smtp',
        messageId: body.messageId,
        subject: body.subject,
        pdfBytes: body.pdfBytes,
        mapped: !!mapped,
        emailSource: resolved.source,
      };
    }
    return {
      queued: false,
      sent: false,
      to,
      via: 'gmail-smtp',
      error: body.error || `send failed http ${resp.status}`,
      mapped: !!mapped,
      emailSource: resolved.source,
    };
  } catch (e) {
    return {
      queued: false,
      sent: false,
      to,
      via: 'gmail-smtp',
      error: e?.message || String(e),
      mapped: !!mapped,
      emailSource: resolved.source,
    };
  }
}

// ---------------------------------------------------------------------------
// Netlify handler
// ---------------------------------------------------------------------------
export const handler = async (event) => {
  const t0 = Date.now();
  // Short request ID for correlation in logs when tailing this function.
  const reqId = Math.random().toString(36).slice(2, 8);
  const log = (...args) => console.log(`[cqw ${reqId}]`, ...args);

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (event.httpMethod === 'OPTIONS') {
    log('OPTIONS preflight');
    return { statusCode: 204, headers: cors, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    log('reject method', event.httpMethod);
    return { statusCode: 405, headers: cors, body: JSON.stringify({ ok: false, error: 'Method Not Allowed' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (e) {
    log('bad JSON body:', (event.body || '').slice(0, 200));
    return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) };
  }

  const { QW_API_KEY, QW_API_BASE } = process.env;
  const base = QW_API_BASE || QW_BASE_DEFAULT;
  if (!QW_API_KEY) {
    log('missing QW_API_KEY env');
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ ok: false, error: 'QW_API_KEY not configured on Netlify' }),
    };
  }

  const action = payload.action;
  const bodyLen = (event.body || '').length;
  log('action=', action, 'bodyLen=', bodyLen);
  try {
    if (action === 'search_customers') {
      const results = await searchCustomers(base, QW_API_KEY, payload.query || '');
      log('search_customers hits=', results.length, 'ms=', Date.now() - t0);
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, results }) };
    }

    if (action === 'create_quote') {
      const { rep, customer, panels, addons } = payload;
      const panelSummary = Array.isArray(panels)
        ? panels.map(p => ({
            bundle: p?.bundle_name,
            unit: p?.unit_number,
            order: Array.isArray(p?.order) ? p.order.length
                 : (Array.isArray(p?.missing) ? p.missing.length : 0) + (Array.isArray(p?.damaged) ? p.damaged.length : 0),
            custom: Array.isArray(p?.custom) ? p.custom.length : 0,
          }))
        : null;
      const addonSummary = addons ? {
        logistics: !!addons.logistics,
        training: Array.isArray(addons.training) ? addons.training.length : 0,
        installation: Array.isArray(addons.installation) ? addons.installation.length : 0,
        freight: Number(addons.freight) || 0,
        tax: !!addons.tax,
        taxRate: Number(addons.taxRate) || 0,
      } : null;
      log('create_quote in:',
        'rep=', rep,
        'customer.id=', customer && customer.id,
        'customer.company=', customer && (customer.company || customer.customer),
        'panels=', panelSummary,
        'addons=', addonSummary);
      const { docId, docNo, diag } = await createQuote(base, QW_API_KEY, { rep, customer, panels, addons });
      log('createQuote done docId=', docId, 'docNo=', docNo, 'ms=', Date.now() - t0);
      const quoteUrl = `https://na.quotewerks.com/#/documents/${docId}`;
      let mail = { sent: false };
      try {
        log('emailRep begin');
        mail = await emailRep({ rep, docId, base, apiKey: QW_API_KEY });
        log('emailRep done sent=', mail.sent, 'error=', mail.error, 'ms=', Date.now() - t0);
      } catch (mailErr) {
        // Don't fail the whole call if email dies — the quote exists.
        log('emailRep threw:', mailErr && mailErr.message);
        mail = { sent: false, error: mailErr.message };
      }
      log('respond OK total ms=', Date.now() - t0);
      return {
        statusCode: 200,
        headers: cors,
        body: JSON.stringify({ ok: true, docId, docNo, quoteUrl, mail, diag }),
      };
    }

    if (action === 'recent_quotes') {
      // Diagnostic: list N most recent DocumentHeaders. Handy for debugging
      // without needing a QW Web session.
      const size = Math.min(Math.max(Number(payload.size) || 10, 1), 50);
      const body = {
        page: { number: 1, size },
        sort: '-Created',
        fields: { DocumentHeaders: ['DocNo','SoldToCompany','SoldToContact','SoldToCity','SoldToState','EnteredBy','SalesRep','Created','GrandTotal','DocType','DocStatus'] },
      };
      const data = await qwFetch(base, QW_API_KEY, '/api/v1/qw/tables/DocumentHeaders/search', { method: 'POST', body });
      const rows = (data && data.data) || [];
      const results = rows.map(r => ({ id: r.id, ...r.attributes }));
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, results }) };
    }

    if (action === 'resolve_rep_email') {
      const info = await resolveRepEmail(base, QW_API_KEY, payload.rep || '');
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, ...info }) };
    }

    if (action === 'inspect_lines') {
      const docId = payload.docId;
      if (!docId) return { statusCode: 400, headers: cors, body: JSON.stringify({ ok:false, error:'docId required'}) };
      const body = { filter: [{ name: 'DocRecGUID', op: 'eq', val: docId }] };
      const data = await qwFetch(base, QW_API_KEY, '/api/v1/qw/tables/DocumentItems/search?page[size]=200', { method: 'POST', body });
      const rows = (data && data.data) || [];
      const lines = rows.map(r => {
        const a = r.attributes || {};
        return { n: a.LineNumberActual, type: a.LineType, pn: a.PartNumber, desc: a.Description, qty: a.QtyBase, price: a.UnitPrice, RichText: a.RichText, ItemAttributes: a.ItemAttributes };
      }).sort((x,y) => (x.n||0) - (y.n||0));
      // If caller passes ?raw=1, dump the FULL first row's attributes so we
      // can see what QW is actually storing per line.
      const dumpRaw = payload.raw ? (rows[0]?.attributes || {}) : null;
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok:true, count: lines.length, lines, raw: dumpRaw }) };
    }

    if (action === 'test_linetypes') {
      // Insert one line for each LineType 0..9 into the given quote so we can
      // preview and identify which integer maps to Heading/SectionHeader.
      const docId = payload.docId;
      if (!docId) return { statusCode: 400, headers: cors, body: JSON.stringify({ ok:false, error:'docId required'}) };
      const results = [];
      const validLts = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];
      for (const lt of validLts) {
        const attrs = {
          DocID_ref: docId,
          DocRecGUID: docId,
          LineType: lt,
          Description: `--- TEST LineType ${lt} ---`,
          RichText: `LineType ${lt} rich text sample`,
          QtyBase: 0, UnitPrice: 0, UnitCost: 0, UnitList: 0,
          Manufacturer: '', PartNumber: '', ManufacturerPartNumber: '',
        };
        try {
          const body = { data: { type: 'DocumentItems', attributes: attrs } };
          const r = await qwFetch(base, QW_API_KEY, '/api/v1/qw/tables/DocumentItems', { method:'POST', body });
          results.push({ lt, ok:true, id: r?.data?.id, n: r?.data?.attributes?.LineNumberActual });
        } catch (e) {
          results.push({ lt, ok:false, error: e.message });
        }
      }
      return { statusCode:200, headers:cors, body: JSON.stringify({ ok:true, docId, results }) };
    }

    if (action === 'inspect_header') {
      // Diagnostic: dump every attribute on a DocumentHeaders row so we can
      // verify what QW is storing after a create.
      const docId = payload.docId;
      if (!docId) return { statusCode: 400, headers: cors, body: JSON.stringify({ ok:false, error:'docId required'}) };
      const data = await qwFetch(base, QW_API_KEY, `/api/v1/qw/tables/DocumentHeaders/${encodeURIComponent(docId)}`);
      const attrs = data && data.data && data.data.attributes || {};
      const shipTo = {}, soldTo = {}, tax = {}, freight = {}, totals = {};
      for (const [k,v] of Object.entries(attrs)) {
        if (k.startsWith('ShipTo')) shipTo[k] = v;
        else if (k.startsWith('SoldTo')) soldTo[k] = v;
        else if (/tax/i.test(k) || k === 'TaxZone' || k === 'TaxSystem') tax[k] = v;
        else if (/ship|freight|carrier|track/i.test(k)) freight[k] = v;
        else if (/total|grand|subtotal|discount|price/i.test(k)) totals[k] = v;
      }
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok:true, docNo: attrs.DocNo, shipTo, soldTo, tax, freight, totals }) };
    }

    log('unknown action:', action);
    return {
      statusCode: 400,
      headers: cors,
      body: JSON.stringify({ ok: false, error: `Unknown action: ${action}` }),
    };
  } catch (err) {
    // Log the full stack so we can see where it blew up, not just the message.
    log('FATAL after', Date.now() - t0, 'ms:', err && err.message);
    log('stack:', err && err.stack);
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ ok: false, error: err.message || 'Unknown error' }),
    };
  }
};

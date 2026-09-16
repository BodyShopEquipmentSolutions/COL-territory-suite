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

// QW's Real-time Data tax lookup keys off the FULL state name, not the
// 2-letter postal abbreviation. Empirically: quotes saved with 'Texas' get
// auto-tax at 0.0825, quotes saved with 'TX' get zero. Expand 2-letter
// codes before writing to QW; leave anything else (full names, non-US,
// blank) untouched.
const US_STATE_NAMES = {
  AL:'Alabama', AK:'Alaska', AZ:'Arizona', AR:'Arkansas', CA:'California',
  CO:'Colorado', CT:'Connecticut', DE:'Delaware', FL:'Florida', GA:'Georgia',
  HI:'Hawaii', ID:'Idaho', IL:'Illinois', IN:'Indiana', IA:'Iowa',
  KS:'Kansas', KY:'Kentucky', LA:'Louisiana', ME:'Maine', MD:'Maryland',
  MA:'Massachusetts', MI:'Michigan', MN:'Minnesota', MS:'Mississippi',
  MO:'Missouri', MT:'Montana', NE:'Nebraska', NV:'Nevada', NH:'New Hampshire',
  NJ:'New Jersey', NM:'New Mexico', NY:'New York', NC:'North Carolina',
  ND:'North Dakota', OH:'Ohio', OK:'Oklahoma', OR:'Oregon', PA:'Pennsylvania',
  RI:'Rhode Island', SC:'South Carolina', SD:'South Dakota', TN:'Tennessee',
  TX:'Texas', UT:'Utah', VT:'Vermont', VA:'Virginia', WA:'Washington',
  WV:'West Virginia', WI:'Wisconsin', WY:'Wyoming', DC:'District of Columbia',
};
function expandStateName(val) {
  if (val == null) return val;
  const s = String(val).trim();
  if (s.length !== 2) return s;
  const upper = s.toUpperCase();
  return US_STATE_NAMES[upper] || s;
}

// State → typical combined sales-tax rate (state + average local).
// Applied to SubTotal when the customer isn't tax-exempt. Sources:
// TX Comptroller (metros 8.25%), Tax Foundation state+avg-local tables,
// each state's revenue dept publication. Kept intentionally conservative
// — rural areas may be lower; reps can adjust in QW before finalizing.
// A rate of null means "do not apply tax" (state has no sales tax).
const COMBINED_TAX_RATE = {
  AL: 0.0925, AK: null,   AZ: 0.084,  AR: 0.0946, CA: 0.0872,
  CO: 0.0777, CT: 0.0635, DE: null,   FL: 0.07,   GA: 0.0738,
  HI: 0.045,  ID: 0.0603, IL: 0.0885, IN: 0.07,   IA: 0.0694,
  KS: 0.0872, KY: 0.06,   LA: 0.0956, ME: 0.055,  MD: 0.06,
  MA: 0.0625, MI: 0.06,   MN: 0.0812, MS: 0.0707, MO: 0.0838,
  MT: null,   NE: 0.0695, NV: 0.0824, NH: null,   NJ: 0.0663,
  NM: 0.0779, NY: 0.0853, NC: 0.0699, ND: 0.0704, OH: 0.0725,
  OK: 0.0899, OR: null,   PA: 0.0634, RI: 0.07,   SC: 0.0744,
  SD: 0.0611, TN: 0.0955, TX: 0.0825, UT: 0.0725, VT: 0.0636,
  VA: 0.0577, WA: 0.0938, WV: 0.0557, WI: 0.0543, WY: 0.0536,
  DC: 0.06,
};
function lookupTaxRate(stateVal) {
  if (!stateVal) return null;
  const s = String(stateVal).trim();
  if (!s) return null;
  // Accept full name OR 2-letter code
  const upperShort = s.length === 2 ? s.toUpperCase() : null;
  const codeFromName = Object.entries(US_STATE_NAMES).find(
    ([, name]) => name.toLowerCase() === s.toLowerCase()
  );
  const code = upperShort || (codeFromName ? codeFromName[0] : null);
  if (!code) return null;
  const rate = COMBINED_TAX_RATE[code];
  return (rate == null) ? null : Number(rate);
}
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
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
  // SalesRep / PreparedBy / CreatedBy MUST be a QW username - QW REST
  // validates them against SecurityAccounts and rejects any string that
  // isn't a known user (422 'not a user in SecurityAccounts'). The rep's
  // display name is pulled from UserSettings.FullName by QW Web when it
  // renders the quote, so populating FullName in Preferences is the right
  // place to fix rendered rep names.
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
    if (customer.state)    attrs.SoldToState    = clip('SoldToState',    expandStateName(customer.state));
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
    if (customer.state)    attrs.ShipToState    = clip('SoldToState',    expandStateName(customer.state));
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

  // Tax is applied after lines exist (below) so we can multiply against
  // QW's computed SubTotal. See the tax block near the end of this function.

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
    //
    // QW LineType is a BITMASK: valid values are 1,2,4,8,16,32,64,128,256,512.
    // Empirical mapping (from a test quote where we inserted one row per value):
    //   1   = Product/Service       — full row with columns
    //   2   = Comment               — italic gray description only
    //   4   = SubTotal              — bold with right-aligned money
    //   8   = RunningSubTotal       — bold with right-aligned money
    //   16  = GroupHeader
    //   32  = SectionHeader         — bold banner (matches band 822 alongside Heading)
    //   64  = Heading               — bold banner (matches band 822)
    //   128 = PercentCharge
    //   256 = PercentDiscount
    //   512 = Summary
    //
    // Bundle headers use SectionHeader (32) so the patched layout band 822 fires
    // with our navy/bold/rich-text styling.
    const bundleName = (panel.bundle_name || '').trim();
    const bundleStartIdx = plan.length;
    if (bundleName) {
      const sameNameCount = panels.filter(p => (p.bundle_name || '').trim() === bundleName).length;
      const headerText = sameNameCount > 1 && panel.unit_number
        ? `${bundleName} (Unit ${panel.unit_number})`
        : bundleName;
      plan.push({
        LineType: 2, // Comment — plain italic gray bundle header (user preference)
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

    // Per-bundle SubTotal + Comment spacer after the last line of this bundle.
    // We compute the running sum of Product/Service rows added in this bundle
    // and emit a SubTotal (LineType 4) row so band 1113 (SubTotal / RunningSubTotal)
    // fires, then a blank Comment (LineType 2) row so the next bundle header has
    // breathing room above it.
    const bundleProductRows = plan.slice(bundleStartIdx).filter(l => l.LineType === 1);
    if (bundleProductRows.length) {
      const bundleSubtotal = bundleProductRows.reduce(
        (s, l) => s + (Number(l.UnitPrice) || 0) * (Number(l.QtyBase) || 0),
        0,
      );
      plan.push({
        LineType: 4, // SubTotal
        Manufacturer: '', ManufacturerPartNumber: '', PartNumber: '',
        Description: 'Subtotal',
        QtyBase: 0,
        UnitPrice: bundleSubtotal,
        ExtendedPrice: bundleSubtotal,
        UnitCost: 0, UnitList: 0,
      });
      plan.push({
        LineType: 2, // Comment spacer
        Manufacturer: '', ManufacturerPartNumber: '', PartNumber: '',
        Description: ' ',
        QtyBase: 0, UnitPrice: 0, UnitCost: 0, UnitList: 0,
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

  // Sales tax is written to the DocumentHeaders row (LocalTax/LocalTaxRate/
  // TotalTax) after lines exist so we can multiply against QW's computed
  // SubTotal. QW's built-in Real-time Data lookup does NOT fire on REST-
  // API-created quotes (only from the QW desktop client), so we do it here.
  // Reps can still click "Lookup Tax Rate" in QW later to refresh.

  // Sequential insert preserves LineNumberActual assignment order in QW.
  // The frontend collapses whole-assembly rollups so this loop stays small.
  for (let i = 0; i < plan.length; i++) {
    await createLine(base, apiKey, docId, { LineNumberActual: i + 1, ...plan[i] });
  }

  // Re-fetch header to pick up the DocNo AND the QW-computed SubTotal (which
  // we need to compute tax against). Combined into one call to avoid two
  // round-trips.
  let docNo = header.docNo;
  let subTotal = 0;
  try {
    const refreshed = await fetchHeader(base, apiKey, docId);
    const attrs = refreshed && refreshed.data && refreshed.data.attributes || {};
    if (!docNo) docNo = attrs.DocNo || null;
    subTotal = Number(attrs.SubTotal) || 0;
  } catch (e) {
    // Non-fatal for docNo. For tax it means we won't compute — diag will show why.
    diag.headerRefreshError = e?.message || String(e);
  }

  // Apply tax: either force-zero (exempt) or compute from ship-to state.
  const taxPatch = {};
  if (addons.taxExempt) {
    diag.taxExempt = true;
    Object.assign(taxPatch, {
      LocalTax: 0, LocalTaxRate: 0,
      GSTTax: 0, GSTTaxRate: 0, GSTTaxExempt: true,
      TotalTax: 0,
      AlternateLocalTax: 0, AlternateGSTTax: 0, AlternateTotalTax: 0,
      ShipToTaxCode: 'EXEMPT',
    });
  } else if (subTotal > 0) {
    const rate = lookupTaxRate(fullCustomer && fullCustomer.state);
    diag.taxRateResolved = rate;
    diag.taxSubTotal = subTotal;
    if (rate != null && rate > 0) {
      const localTax = round2(subTotal * rate);
      Object.assign(taxPatch, {
        LocalTax: localTax, LocalTaxRate: rate,
        TotalTax: localTax,
        AlternateLocalTax: localTax, AlternateTotalTax: localTax,
        GSTTaxExempt: false,
      });
      diag.taxAmount = localTax;
    }
  }
  if (Object.keys(taxPatch).length > 0) {
    try {
      await qwFetch(base, apiKey,
        `/api/v1/qw/tables/DocumentHeaders/${encodeURIComponent(docId)}`,
        { method: 'PATCH', body: { data: { type: 'DocumentHeaders', id: docId, attributes: taxPatch }}});
    } catch (e) {
      diag.taxPatchError = e?.message || String(e);
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
  // send-quote-via-gmail is a BACKGROUND function (file ends in -background.js).
  // Netlify accepts the POST, returns 202 in <1s, and runs the QW-login →
  // GeneratePrintPdf → download → SMTP-send flow off the request path (up to
  // 15 minutes). This eliminates the 25-30s edge timeout that was causing the
  // "operation was aborted" error on the success screen — the quote is created,
  // the email is queued, and the tech gets the PDF within about a minute.
  try {
    const resp = await fetch(`${siteUrl}/.netlify/functions/send-quote-via-gmail-background`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        docRecGuid: docId,
        repUsername: rep,
        repEmail: to,
      }),
      // Background functions ack in well under a second; keep a small timeout
      // so a totally stalled edge doesn't hang the parent request.
      signal: AbortSignal.timeout(8000),
    });
    // Background functions respond 202 Accepted with no body. Anything in the
    // 2xx range means Netlify queued the invocation — that's success from our
    // side; the actual send happens off-path.
    if (resp.status >= 200 && resp.status < 300) {
      return {
        queued: true,
        sent: false,
        to,
        via: 'gmail-smtp-background',
        mapped: !!mapped,
        emailSource: resolved.source,
      };
    }
    // Non-2xx from the edge means the background function itself couldn't be
    // queued (misdeploy, bad path, throttling). Surface the raw status.
    return {
      queued: false,
      sent: false,
      to,
      via: 'gmail-smtp-background',
      error: `queue failed http ${resp.status}`,
      mapped: !!mapped,
      emailSource: resolved.source,
    };
  } catch (e) {
    return {
      queued: false,
      sent: false,
      to,
      via: 'gmail-smtp-background',
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
        taxExempt: !!addons.taxExempt,
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

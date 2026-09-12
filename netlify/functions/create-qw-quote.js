// netlify/functions/create-qw-quote.js
//
// FOREGROUND (26s ceiling) endpoint. Handles four actions:
//
//   search_customers   -> CRMCompanies search proxy
//   recent_quotes      -> diagnostic: latest DocumentHeaders
//   resolve_rep_email  -> diagnostic: UserSettings.EmailAddress lookup
//   create_quote       -> creates the QW header + returns DocNo immediately.
//                         If the payload is small (<= FOREGROUND_ITEM_LIMIT),
//                         line inserts + email happen inline (same behavior
//                         as before). If it's larger, we fire the background
//                         function `create-qw-quote-background` to insert
//                         lines + email PDF, and return
//                         { ok:true, docId, docNo, backgrounded:true }
//                         immediately so the mobile UI never hangs.
//
// Env: QW_API_KEY, QW_API_BASE, SMTP_* (see _qw-shared.mjs).

import {
  QW_BASE_DEFAULT,
  qwFetch,
  resolveRepEmail,
  enrichCustomer,
  createHeader,
  fetchHeader,
  buildLinePlan,
  insertLinesSequential,
  emailRep,
  totalPanelItems,
} from './_qw-shared.mjs';

// Items above this count are pushed to the background function. Well below
// what fits in 26s with sequential inserts (~500ms/line), and low enough to
// keep the foreground path snappy on flaky mobile connections.
const FOREGROUND_ITEM_LIMIT = 18;

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
// Foreground quote path (small payloads only).
// ---------------------------------------------------------------------------
async function createQuoteForeground(base, apiKey, { rep, customer, panels, siteUrl }) {
  const diag = {
    customerIn: customer ? Object.keys(customer).sort() : null,
    enrichAttempted: false,
    enrichHit: false,
    enrichError: null,
    contactHit: false,
    productLookups: 0,
    productHits: 0,
    productMisses: [],
  };

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

  const plan = await buildLinePlan(base, apiKey, panels, diag);
  await insertLinesSequential(base, apiKey, docId, plan, diag);

  let docNo = header.docNo;
  if (!docNo) {
    try {
      const refreshed = await fetchHeader(base, apiKey, docId);
      docNo = refreshed?.data?.attributes?.DocNo || null;
    } catch { /* non-fatal */ }
  }

  const quoteUrl = `https://na.quotewerks.com/#/documents/${docId}`;

  // Always dispatch the QW SendEmail to the background function. QW's
  // SendEmail RPC takes 20-30s to actually process the send — too long for
  // a 26s foreground budget, and if we don't hold the connection open the
  // send gets silently dropped. The background function has 15 minutes to
  // wait on the response.
  const site = siteUrl || process.env.URL || process.env.DEPLOY_URL || 'https://colswsalesandserviceapp.netlify.app';
  const emailPayload = {
    emailOnly: true,
    docId, docNo, rep, customer: fullCustomer, panels,
  };
  let mail = { sent: false, backgrounded: true, note: 'PDF email dispatched to background function' };
  try {
    const resp = await fetch(`${site}/.netlify/functions/create-qw-quote-background`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(emailPayload),
      signal: AbortSignal.timeout(8000),
    });
    mail.bgQueued = (resp.status === 202 || resp.ok);
    if (!mail.bgQueued) mail.backgroundStatus = resp.status;
  } catch (e) {
    mail.backgroundError = (e?.message || String(e)).slice(0, 200);
  }

  return { docId, docNo, quoteUrl, mail, diag };
}

// ---------------------------------------------------------------------------
// Background quote path (large payloads). Create header up front so we can
// return DocNo synchronously, then fire the background function to do the
// slow part.
// ---------------------------------------------------------------------------
async function createQuoteBackground(base, apiKey, { rep, customer, panels, siteUrl }) {
  const diag = {
    customerIn: customer ? Object.keys(customer).sort() : null,
    itemCount: totalPanelItems(panels),
    enrichAttempted: false,
    enrichHit: false,
    enrichError: null,
    contactHit: false,
  };

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

  let docNo = header.docNo;
  if (!docNo) {
    try {
      const refreshed = await fetchHeader(base, apiKey, docId);
      docNo = refreshed?.data?.attributes?.DocNo || null;
    } catch { /* non-fatal */ }
  }
  const quoteUrl = `https://na.quotewerks.com/#/documents/${docId}`;

  // Fire the background function — do NOT await its response.
  // Netlify -background functions return 202 immediately; the actual work
  // continues up to 15 minutes with logs in the function log stream.
  const site = siteUrl || process.env.URL || process.env.DEPLOY_URL || 'https://colswsalesandserviceapp.netlify.app';
  const bgUrl = `${site}/.netlify/functions/create-qw-quote-background`;
  const bgPayload = { docId, docNo, rep, customer: fullCustomer, panels };
  // Short-timeout fetch, but we don't care about the response body. If Netlify
  // ACKs the 202 (which happens within ~200ms), we know the background job
  // was queued. We still don't wait for it to finish.
  let bgQueued = false;
  try {
    const resp = await fetch(bgUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bgPayload),
      signal: AbortSignal.timeout(8000),
    });
    // 202 Accepted is the normal success return code for background functions.
    bgQueued = resp.status === 202 || resp.ok;
    if (!bgQueued) {
      // Non-202 means Netlify didn't queue it. Include diagnostic info.
      diag.backgroundStatus = resp.status;
    }
  } catch (e) {
    diag.backgroundError = (e?.message || String(e)).slice(0, 200);
  }

  return {
    docId,
    docNo,
    quoteUrl,
    backgrounded: true,
    bgQueued,
    // itemCount tells the frontend roughly how long to expect ("~1 min for 74 items")
    itemCount: diag.itemCount,
    mail: { sent: false, backgrounded: true, note: 'Line insert + PDF email happening in background' },
    diag,
  };
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
  const siteUrl = process.env.URL || process.env.DEPLOY_URL;
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
      if (!rep) throw new Error('rep is required');
      if (!panels || !panels.length) throw new Error('At least one audit panel is required');

      const itemCount = totalPanelItems(panels);
      // Force can be used to override the auto-decision from a test client:
      //   payload.forceBackground === true  -> always background
      //   payload.forceForeground === true  -> always foreground
      const useBackground = payload.forceBackground === true
        ? true
        : payload.forceForeground === true
          ? false
          : itemCount > FOREGROUND_ITEM_LIMIT;

      const result = useBackground
        ? await createQuoteBackground(base, QW_API_KEY, { rep, customer, panels, siteUrl })
        : await createQuoteForeground(base, QW_API_KEY, { rep, customer, panels, siteUrl });

      return {
        statusCode: 200,
        headers: cors,
        body: JSON.stringify({ ok: true, ...result }),
      };
    }

    if (action === 'recent_quotes') {
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

    // Small status probe used by the mobile UI after a background quote to
    // check whether all lines have landed and email has fired. Cheap: 2 QW
    // reads at most.
    if (action === 'quote_status') {
      const docId = payload.docId;
      if (!docId) throw new Error('docId is required');
      // 1) Header GrandTotal — non-zero means lines have priced up.
      let header = null;
      try {
        const h = await qwFetch(base, QW_API_KEY, `/api/v1/qw/tables/DocumentHeaders/${encodeURIComponent(docId)}`);
        header = h?.data?.attributes || null;
      } catch { /* non-fatal */ }
      // 2) DocumentItems count for this doc.
      let itemCount = 0;
      try {
        const it = await qwFetch(base, QW_API_KEY, '/api/v1/qw/tables/DocumentItems/search', {
          method: 'POST',
          body: {
            filter: [{ name: 'DocRecGUID', op: 'eq', val: docId }],
            page: { number: 1, size: 1 },
            fields: { DocumentItems: ['LineNumberActual'] },
          },
        });
        itemCount = it?.meta?.total ?? (Array.isArray(it?.data) ? it.data.length : 0);
      } catch { /* non-fatal */ }
      return {
        statusCode: 200,
        headers: cors,
        body: JSON.stringify({
          ok: true,
          docId,
          docNo: header?.DocNo || null,
          grandTotal: header?.GrandTotal || 0,
          itemCount,
        }),
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

// netlify/functions/send-from-rep.js
// ESM (package.json has "type": "module").
//
// Logs into QuoteWerks Web as the acting rep and drives the internal
// Deliver -> Email -> Send flow so the PDF-attached email leaves QW itself
// (record kept in QW) with FROM = rep and TO = rep.
//
// POST body:
//   {
//     "docRecGuid": "60F838D69E074661816514CF50ADDC9F",  // required
//     "repUsername": "ryan.harthcock",                    // required
//     "repEmail":    "bodyshop.e.s@gmail.com",            // optional; overrides map
//     "toOverride":  ["someone@example.com"]              // optional; else = [repEmail]
//   }
//
// Netlify environment variables:
//   QW_TENANT                     e.g. "caroliner002"
//   QW_HOST                       defaults to "na.quotewerks.com"
//   QW_USERNAME_<username>        the QW login username (usually matches repUsername)
//   QW_PASSWORD_<username>        the QW login password (marked Secret in Netlify UI)
//                                 <username> is repUsername with '.' and '-' replaced by '_'
//
// Rep email map fallback lives in create-qw-quote.js REP_EMAIL_MAP; this function
// takes repEmail directly to avoid duplicating that map.

console.log('[sfr] MODULE LOAD send-from-rep-background.js', new Date().toISOString());

// Background function console.log is not captured on this Netlify site.
// beacon() posts to proof-sink-v1 (a sync function whose logs ARE captured)
// so we can trace execution and errors.
async function beacon(reqId, msg) {
  const siteUrl = process.env.URL || 'https://bodyshopequipment.solutions';
  try {
    await fetch(`${siteUrl}/.netlify/functions/proof-sink-v1?src=sfr&reqId=${reqId}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: `[sfr ${reqId}] ${msg}`,
    });
  } catch (_) {
    // best-effort
  }
}

const QW_HOST = process.env.QW_HOST || 'na.quotewerks.com';
const QW_TENANT = process.env.QW_TENANT || 'caroliner002';
// QW rotates the /rXXX/ path on their server upgrades. Default is the current one
// as of 2026-09; override via QW_RELEASE_PATH env var when it rotates.
const QW_RELEASE_PATH_DEFAULT = process.env.QW_RELEASE_PATH || '/r26b3b/';

// ---------------------------------------------------------------------------
// tiny cookie jar
// ---------------------------------------------------------------------------
function makeCookieJar() {
  const jar = new Map(); // name -> value
  return {
    ingest(setCookieHeader) {
      // fetch's Set-Cookie is combined; split cautiously on ", " boundaries
      // that are followed by a cookie-name= pattern.
      if (!setCookieHeader) return;
      const raw = Array.isArray(setCookieHeader) ? setCookieHeader : String(setCookieHeader).split(/,(?=\s*[A-Za-z0-9_\-.]+=)/);
      for (const cookieStr of raw) {
        const first = cookieStr.split(';')[0].trim();
        const eq = first.indexOf('=');
        if (eq < 1) continue;
        const name = first.slice(0, eq).trim();
        const value = first.slice(eq + 1).trim();
        if (!value || value === 'null' || value === '') {
          jar.delete(name);
        } else {
          jar.set(name, value);
        }
      }
    },
    header() {
      const parts = [];
      for (const [k, v] of jar) parts.push(`${k}=${v}`);
      return parts.join('; ');
    },
    get(name) { return jar.get(name); },
  };
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------
async function extractSetCookie(response) {
  // Node's fetch (undici) exposes Set-Cookie via getSetCookie() when available,
  // otherwise the header is combined.
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie();
  }
  const raw = response.headers.get('set-cookie');
  return raw ? [raw] : [];
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { __rawBody: text };
  }
}

// ---------------------------------------------------------------------------
// QW driver
// ---------------------------------------------------------------------------
async function loginQw({ tenant, username, password }) {
  const jar = makeCookieJar();
  const url = `https://${QW_HOST}/login/login/login`;
  const body = JSON.stringify({
    tenantAccountNumber: tenant,
    username,
    password,
    twoFactorCode: '',
    rememberMe: true,
    returnUrl: '/ReleaseRouting/',
  });
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      accept: 'application/json, text/plain, */*',
      origin: `https://${QW_HOST}`,
      referer: `https://${QW_HOST}/login/`,
    },
    body,
    redirect: 'manual',
  });
  const raw = await extractSetCookie(resp);
  raw.forEach((c) => jar.ingest(c));
  const json = await readJson(resp).catch(() => null);
  if (!resp.ok) {
    throw new Error(`login http ${resp.status} ${resp.statusText}`);
  }
  if (json && json.success === false) {
    throw new Error(`login rejected: ${json.errorMessage || json.msg || 'errorNumber ' + json.errorNumber}`);
  }
  if (!jar.get('AspireIdentity.Auth') && !jar.get('.ASPXAUTH')) {
    throw new Error('login succeeded but no auth cookie returned');
  }
  return jar;
}

async function discoverReleasePath(jar) {
  // QW's discovery pages stall waiting for a browser to run JS, so from a
  // headless function we can't rely on them. Instead: probe a cheap API call
  // at the last-known release path. If it 200s we're good; if it 404s the
  // release rotated and we need a human to update QW_RELEASE_PATH.
  const probe = await fetch(`https://${QW_HOST}${QW_RELEASE_PATH_DEFAULT}api/configurations/getSystemConfigurations`, {
    headers: {
      cookie: jar.header(),
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(30000),
  }).catch((e) => ({ __err: e }));
  if (!probe || probe.__err) {
    throw new Error(`release-path probe failed: ${probe && probe.__err ? probe.__err.message : 'no response'}`);
  }
  if (probe.status === 200) return QW_RELEASE_PATH_DEFAULT;
  if (probe.status === 401 || probe.status === 403) return QW_RELEASE_PATH_DEFAULT; // auth issue, not path issue
  throw new Error(`release path ${QW_RELEASE_PATH_DEFAULT} returned ${probe.status}; set QW_RELEASE_PATH env var to current /rXXX/`);
}

async function qwPost(jar, releasePath, apiPath, payload, fetchTimeoutMs = 60000) {
  const url = `https://${QW_HOST}${releasePath}${apiPath}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      cookie: jar.header(),
      'content-type': 'application/json;charset=UTF-8',
      accept: 'application/json, text/plain, */*',
      origin: `https://${QW_HOST}`,
      referer: `https://${QW_HOST}${releasePath}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(fetchTimeoutMs),
  });
  const raw = await extractSetCookie(resp);
  raw.forEach((c) => jar.ingest(c));
  const json = await readJson(resp);
  if (!resp.ok) {
    throw new Error(`${apiPath} http ${resp.status}: ${JSON.stringify(json)?.slice(0, 300)}`);
  }
  return json;
}

// Diagnostic: run through login → deliver → SetLayout → GeneratePrintPdf →
// GetEmailComposerInitData and return the raw attachment objects (all keys) plus
// the raw GeneratePrintPdf response so we can see what fields QW gives us for
// downloading the PDF ourselves.
export async function dumpComposerAttachments({ docRecGuid, repUsername }) {
  const envKey = (repUsername || 'ryan.harthcock').replace(/[.\-]/g, '_');
  const qwUsername = process.env[`QW_USERNAME_${envKey}`] || process.env.QW_USERNAME_ryan_harthcock || process.env.QW_USERNAME;
  const qwPassword = process.env[`QW_PASSWORD_${envKey}`] || process.env.QW_PASSWORD_ryan_harthcock || process.env.QW_PASSWORD;
  if (!qwUsername || !qwPassword) throw new Error('No QW credentials available');
  const jar = await loginQw({ tenant: QW_TENANT, username: qwUsername, password: qwPassword });
  const releasePath = await discoverReleasePath(jar);
  const deliverInit = await qwPost(jar, releasePath, 'api/DocumentDeliver/GetDocumentDeliverInitData', { docRecGuid, isAdministrationMode: false });
  const layouts = deliverInit?.newLayouts || [];
  const primary = layouts.find(l => l.isSelectedPrimary) || layouts.find(l => l.layoutName === 'COL Quote Layout 2 - WIP') || layouts[0];
  if (!primary) throw new Error('no layout');
  await qwPost(jar, releasePath, 'api/DocumentDeliver/SetLayoutSelection', {
    layoutIdentifier: primary.file, layoutIsSelected: true, isPrimaryLayout: true,
    layoutType: primary.layoutType, layoutDisplayText: primary.layoutName, fileType: primary.fileType,
  });
  const pdfResp = await qwPost(jar, releasePath, 'api/DocumentDeliver/GeneratePrintPdf', {
    coverPageMessage: '', qwPrintMethod: 5, createPOforEachVendor: null, makePDFReadOnly: null,
  });
  const composer = await qwPost(jar, releasePath, 'api/Email/GetEmailComposerInitData', {
    emailContext: 'EmailQuote', docRecGuid, coverPageMessage: '', templateGuid: '',
    createPOforEachVendor: false, linkedResources: [],
    primaryLayoutFilterModel: 'QUOTE', poRecGuid: '', layoutOverride: '', poSetDefaultLayout: false,
  });
  const email = composer?.emailInitData?.[0]?.email;
  return {
    releasePath,
    layoutName: primary.layoutName,
    pdfResp,
    emailFromComposer: {
      from: email?.from, to: email?.to, subject: email?.subject,
      bodyLen: (email?.body || '').length,
      attachments: email?.attachments || [],
    },
  };
}

export async function sendQwEmailAsRep({ docRecGuid, repUsername, repEmail, toOverride, fromOverride, fromDisplayName }) {
  // Per-step timing so a stall in one QW call is diagnosable from the response.
  const timings = [];
  const step = async (name, fn, timeoutMs = 20000) => {
    const t0 = Date.now();
    try {
      const result = await Promise.race([
        fn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${name} timeout after ${timeoutMs/1000}s`)), timeoutMs)),
      ]);
      timings.push({ step: name, ms: Date.now() - t0, ok: true });
      return result;
    } catch (e) {
      timings.push({ step: name, ms: Date.now() - t0, ok: false, error: e?.message || String(e) });
      const err = new Error(`step '${name}' failed: ${e?.message || e}`);
      err.timings = timings;
      throw err;
    }
  };

  if (!docRecGuid) throw new Error('docRecGuid required');
  if (!repUsername) throw new Error('repUsername required');

  // QW Web is single-tenant — any authenticated rep can pick another user's
  // address in the composer's From dropdown, so we don't need every rep's
  // credentials to send "as" them. Prefer the requested rep's creds if present;
  // otherwise fall back to a shared account (QW_USERNAME/QW_PASSWORD) and set
  // email.from to the requested rep's address later.
  const envKey = repUsername.replace(/[.\-]/g, '_');
  const qwUsername = process.env[`QW_USERNAME_${envKey}`]
    || process.env.QW_USERNAME_ryan_harthcock
    || process.env.QW_USERNAME;
  const qwPassword = process.env[`QW_PASSWORD_${envKey}`]
    || process.env.QW_PASSWORD_ryan_harthcock
    || process.env.QW_PASSWORD;
  if (!qwUsername || !qwPassword) {
    throw new Error(`No QW credentials available (checked QW_USERNAME_${envKey}, QW_USERNAME_ryan_harthcock, QW_USERNAME)`);
  }

  const jar = await step('login', () => loginQw({ tenant: QW_TENANT, username: qwUsername, password: qwPassword }));
  const releasePath = await step('discoverReleasePath', () => discoverReleasePath(jar));

  const deliverInit = await step('GetDocumentDeliverInitData', () => qwPost(jar, releasePath, 'api/DocumentDeliver/GetDocumentDeliverInitData', {
    docRecGuid,
    isAdministrationMode: false,
  }));

  // Find the primary layout. First try the isSelectedPrimary flag (set when a
  // user has clicked it as primary in the UI at some point). If none is
  // flagged in this session (fresh API login sometimes returns all false),
  // fall back to matching by layout name — COL Quote Layout 2 - WIP is what
  // the team is currently sending. Extend the fallback list as more layouts
  // get approved. Env var QW_PRIMARY_LAYOUT_NAME overrides the default.
  const layouts = deliverInit?.newLayouts || [];
  const FALLBACK_LAYOUT_NAMES = [
    process.env.QW_PRIMARY_LAYOUT_NAME,
    'COL Quote Layout 2 - WIP',
    'COL Quote Layout 1',
  ].filter(Boolean);
  let primaryLayout = layouts.find((l) => l.isSelectedPrimary) || null;
  let primarySource = 'isSelectedPrimary';
  if (!primaryLayout) {
    for (const name of FALLBACK_LAYOUT_NAMES) {
      const found = layouts.find((l) => l.layoutName === name);
      if (found) { primaryLayout = found; primarySource = `fallback-name:${name}`; break; }
    }
  }
  if (!primaryLayout) {
    throw new Error(`No primary layout found. Available: ${layouts.map((l) => l.layoutName).join(', ')}`);
  }

  // Tell the server-side session which layout is primary. Without this call,
  // GeneratePrintPdf produces no PDF and GetEmailComposerInitData returns
  // an empty attachments array (this is exactly what QW's UI does when the
  // user clicks Email in the Deliver dialog).
  await step('SetLayoutSelection', () => qwPost(jar, releasePath, 'api/DocumentDeliver/SetLayoutSelection', {
    layoutIdentifier: primaryLayout.file,
    layoutIsSelected: true,
    isPrimaryLayout: true,
    layoutType: primaryLayout.layoutType,
    layoutDisplayText: primaryLayout.layoutName,
    fileType: primaryLayout.fileType,
  }));

  // Now render the PDF. qwPrintMethod=5 is Email. force=true bypasses any
  // stale-print-pdf-id cache from an earlier call on this session.
  const pdfResp = await step('GeneratePrintPdf', () => qwPost(jar, releasePath, 'api/DocumentDeliver/GeneratePrintPdf', {
    coverPageMessage: '',
    qwPrintMethod: 5,
    createPOforEachVendor: null,
    makePDFReadOnly: null,
  }));

  const composer = await step('GetEmailComposerInitData', () => qwPost(jar, releasePath, 'api/Email/GetEmailComposerInitData', {
    emailContext: 'EmailQuote',
    docRecGuid,
    coverPageMessage: '',
    templateGuid: '',
    createPOforEachVendor: false,
    linkedResources: [],
    primaryLayoutFilterModel: 'QUOTE',
    poRecGuid: '',
    layoutOverride: '',
    poSetDefaultLayout: false,
  }));

  const email = composer?.emailInitData?.[0]?.email;
  if (!email) {
    const err = new Error(`GetEmailComposerInitData returned no email object: ${JSON.stringify(composer)?.slice(0, 300)}`);
    err.timings = timings;
    throw err;
  }

  const targetTo = Array.isArray(toOverride) && toOverride.length
    ? toOverride
    : [repEmail || qwUsername];
  email.to = targetTo;
  email.cc = [];
  email.bcc = [];

  // Override the From address so the quote is delivered under the requested
  // rep's identity, even when we authenticated as a different user. Also stamp
  // fromDisplayName when supplied so the header renders nicely (e.g. "Jeff
  // Horsman <jhorsman@car-o-linersw.com>").
  if (typeof fromOverride === 'string' && fromOverride.trim()) {
    email.from = fromOverride.trim();
  }
  if (typeof fromDisplayName === 'string' && fromDisplayName.trim()) {
    email.fromDisplayName = fromDisplayName.trim();
  }

  // SendEmail bundles PDF + hands off to Google SMTP inside QW's process.
  // For large multi-panel quotes (9+ items with pricing rollups) QW SendEmail
  // can easily exceed 60s. We're in a background function (15-min ceiling),
  // so give SendEmail a generous 300s and pass the timeout down to the actual
  // fetch so aborts cancel the underlying socket instead of orphaning it.
  const SEND_TIMEOUT_MS = 300000;
  const sendResp = await step('SendEmail', () => qwPost(jar, releasePath, 'api/Email/SendEmail', {
    email,
    emailContext: 'EmailQuote',
    docRecGuid,
  }, SEND_TIMEOUT_MS), SEND_TIMEOUT_MS);

  // QuoteWerks returns HTTP 200 with success:false when SMTP/OAuth actually
  // failed — treat that as a real error so we don't tell users "queued" for
  // an email that never left QW.
  if (sendResp && sendResp.success === false) {
    const err = new Error(`QW SendEmail rejected: ${sendResp.errorMessage || 'no error message'}`);
    err.timings = timings;
    err.sendResponse = sendResp;
    throw err;
  }

  return {
    ok: true,
    releasePath,
    to: targetTo,
    from: email.from,
    subject: email.subject,
    attachments: (email.attachments || []).map((a) => a.name),
    layoutSelected: { name: primaryLayout.layoutName, file: primaryLayout.file, source: primarySource },
    pdfDiag: {
      pdfListCount: Array.isArray(pdfResp?.pdfList) ? pdfResp.pdfList.length : null,
      firstPdfId: pdfResp?.pdfList?.[0]?.printPdfId || null,
      firstPdfName: pdfResp?.pdfList?.[0]?.printPdfFileName || null,
    },
    composerDiag: {
      hasAttachments: Array.isArray(email.attachments) ? email.attachments.length : null,
      attachmentKeys: Array.isArray(email.attachments) && email.attachments[0] ? Object.keys(email.attachments[0]).sort() : null,
      bodyLen: (email.body || '').length,
      bodyPreview: (email.body || '').slice(0, 120),
      subject: email.subject,
    },
    sendResponse: sendResp,
    timings,
  };
}

// ---------------------------------------------------------------------------
// Netlify handler
// ---------------------------------------------------------------------------
function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    },
    body: JSON.stringify(body),
  };
}

export const handler = async (event, context) => {
  const t0 = Date.now();
  const reqId = Math.random().toString(36).slice(2, 8);
  const logMsgs = [];
  const log = (...args) => {
    const msg = args.map(a => typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()).join(' ');
    console.log(`[sfr ${reqId}]`, msg);
    logMsgs.push(`${(Date.now()-t0)}ms ${msg}`);
  };
  const finish = async (result) => {
    // Flush all captured logs to proof-sink-v1 (sync fn whose logs ARE visible)
    // Beacon in chunks so long messages aren't truncated by log line limits.
    const full = `EXIT total=${Date.now()-t0}ms | ${logMsgs.join(' | ')}`;
    const CHUNK = 3000;
    for (let i = 0; i < full.length; i += CHUNK) {
      await beacon(reqId, `part${Math.floor(i/CHUNK)}/${Math.ceil(full.length/CHUNK)}: ${full.slice(i, i+CHUNK)}`);
    }
    return result;
  };

  // BACKGROUND FUNCTION: Netlify returns 202 to the caller immediately and
  // runs this handler asynchronously (no HTTP response is sent back to the
  // caller). Return value is ignored.
  await beacon(reqId, `ENTER method=${event?.httpMethod} bodyLen=${(event?.body || '').length}`);
  log('ENTER method=', event?.httpMethod, 'bodyLen=', (event?.body || '').length);

  if (event.httpMethod === 'OPTIONS') return respond(200, { ok: true });
  if (event.httpMethod !== 'POST') {
    log('reject method', event.httpMethod);
    return respond(405, { error: 'method not allowed' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    log('bad JSON body:', (event.body || '').slice(0, 200));
    return respond(400, { error: 'invalid JSON body' });
  }

  log('begin docRecGuid=', payload.docRecGuid, 'rep=', payload.repUsername, 'to=', payload.repEmail);
  try {
    const result = await sendQwEmailAsRep(payload);
    log('done ok total ms=', Date.now() - t0, 'timings=', JSON.stringify(result.timings));
    log('sendResponse=', JSON.stringify(result.sendResponse));
    log('to=', JSON.stringify(result.to), 'from=', JSON.stringify(result.from), 'subj=', JSON.stringify(result.subject));
    return await finish(respond(200, result));
  } catch (e) {
    log('FATAL after', Date.now() - t0, 'ms:', e && e.message);
    log('timings:', JSON.stringify(e && e.timings));
    log('stack:', (e && e.stack || '').slice(0, 1500));
    return await finish(respond(500, {
      error: e?.message || String(e),
      timings: e?.timings,
    }));
  }
};

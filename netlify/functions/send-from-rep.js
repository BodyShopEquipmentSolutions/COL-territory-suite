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

const QW_HOST = process.env.QW_HOST || 'na.quotewerks.com';
const QW_TENANT = process.env.QW_TENANT || 'caroliner002';

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
  // ReleaseRouting stalls waiting for a browser to run JS; instead scan the
  // login-redirect landing page (or the app root) for the current /rXXX/ path.
  const candidates = ['/', '/ReleaseRouting/'];
  for (const path of candidates) {
    const resp = await fetch(`https://${QW_HOST}${path}`, {
      headers: {
        cookie: jar.header(),
        accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    }).catch((e) => ({ __err: e }));
    if (resp.__err) continue;
    const raw = await extractSetCookie(resp);
    raw.forEach((c) => jar.ingest(c));
    // 3xx redirect?
    const loc = resp.headers.get('location') || '';
    let m = loc.match(/(\/r[a-z0-9]+\/)/i);
    if (m) return m[1];
    // Body scan (may 200 with meta-refresh or JS href)
    try {
      const body = await resp.text();
      m = body.match(/(\/r[a-z0-9]+\/)/i);
      if (m) return m[1];
    } catch { /* ignore */ }
  }
  throw new Error('could not discover /rXXXX/ release path');
}

async function qwPost(jar, releasePath, apiPath, payload) {
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
  });
  const raw = await extractSetCookie(resp);
  raw.forEach((c) => jar.ingest(c));
  const json = await readJson(resp);
  if (!resp.ok) {
    throw new Error(`${apiPath} http ${resp.status}: ${JSON.stringify(json)?.slice(0, 300)}`);
  }
  return json;
}

async function sendQwEmailAsRep({ docRecGuid, repUsername, repEmail, toOverride }) {
  if (!docRecGuid) throw new Error('docRecGuid required');
  if (!repUsername) throw new Error('repUsername required');

  const envKey = repUsername.replace(/[.\-]/g, '_');
  const qwUsername = process.env[`QW_USERNAME_${envKey}`];
  const qwPassword = process.env[`QW_PASSWORD_${envKey}`];
  if (!qwUsername || !qwPassword) {
    throw new Error(`QW credentials not configured for rep '${repUsername}' (expected QW_USERNAME_${envKey} / QW_PASSWORD_${envKey})`);
  }

  const jar = await loginQw({ tenant: QW_TENANT, username: qwUsername, password: qwPassword });
  const releasePath = await discoverReleasePath(jar);

  // Warm the deliver flow (matches what the UI does on Deliver -> Email).
  await qwPost(jar, releasePath, 'api/DocumentDeliver/GetDocumentDeliverInitData', {
    docRecGuid,
    isAdministrationMode: false,
  });

  // Grab the initial email composer state. FROM already = SalesRep because
  // the rep is logged in. TO is populated from the document.
  const composer = await qwPost(jar, releasePath, 'api/Email/GetEmailComposerInitData', {
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
  });

  const email = composer?.emailInitData?.[0]?.email;
  if (!email) {
    throw new Error(`GetEmailComposerInitData returned no email object: ${JSON.stringify(composer)?.slice(0, 300)}`);
  }

  // Rewrite the TO field: rep-to-rep unless the caller passes toOverride.
  const targetTo = Array.isArray(toOverride) && toOverride.length
    ? toOverride
    : [repEmail || qwUsername];
  email.to = targetTo;
  email.cc = [];
  email.bcc = [];

  // Fire SendEmail. This is the same endpoint the Send button uses.
  const sendResp = await qwPost(jar, releasePath, 'api/Email/SendEmail', {
    email,
    emailContext: 'EmailQuote',
    docRecGuid,
  });

  return {
    ok: true,
    releasePath,
    to: targetTo,
    from: email.from,
    subject: email.subject,
    attachments: (email.attachments || []).map((a) => a.name),
    sendResponse: sendResp,
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

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return respond(200, { ok: true });
  if (event.httpMethod !== 'POST') return respond(405, { error: 'method not allowed' });

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return respond(400, { error: 'invalid JSON body' });
  }

  try {
    const result = await sendQwEmailAsRep(payload);
    return respond(200, result);
  } catch (e) {
    return respond(500, {
      error: e?.message || String(e),
    });
  }
};

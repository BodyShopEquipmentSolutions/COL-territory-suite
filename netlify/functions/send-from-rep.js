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
    signal: AbortSignal.timeout(10000),
  }).catch((e) => ({ __err: e }));
  if (!probe || probe.__err) {
    throw new Error(`release-path probe failed: ${probe && probe.__err ? probe.__err.message : 'no response'}`);
  }
  if (probe.status === 200) return QW_RELEASE_PATH_DEFAULT;
  if (probe.status === 401 || probe.status === 403) return QW_RELEASE_PATH_DEFAULT; // auth issue, not path issue
  throw new Error(`release path ${QW_RELEASE_PATH_DEFAULT} returned ${probe.status}; set QW_RELEASE_PATH env var to current /rXXX/`);
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
  // Per-step timing so a stall in one QW call is diagnosable from the response.
  const timings = [];
  const step = async (name, fn) => {
    const t0 = Date.now();
    try {
      const result = await Promise.race([
        fn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${name} timeout after 20s`)), 20000)),
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

  const envKey = repUsername.replace(/[.\-]/g, '_');
  const qwUsername = process.env[`QW_USERNAME_${envKey}`];
  const qwPassword = process.env[`QW_PASSWORD_${envKey}`];
  if (!qwUsername || !qwPassword) {
    throw new Error(`QW credentials not configured for rep '${repUsername}' (expected QW_USERNAME_${envKey} / QW_PASSWORD_${envKey})`);
  }

  const jar = await step('login', () => loginQw({ tenant: QW_TENANT, username: qwUsername, password: qwPassword }));
  const releasePath = await step('discoverReleasePath', () => discoverReleasePath(jar));

  await step('GetDocumentDeliverInitData', () => qwPost(jar, releasePath, 'api/DocumentDeliver/GetDocumentDeliverInitData', {
    docRecGuid,
    isAdministrationMode: false,
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

  const sendResp = await step('SendEmail', () => qwPost(jar, releasePath, 'api/Email/SendEmail', {
    email,
    emailContext: 'EmailQuote',
    docRecGuid,
  }));

  return {
    ok: true,
    releasePath,
    to: targetTo,
    from: email.from,
    subject: email.subject,
    attachments: (email.attachments || []).map((a) => a.name),
    // Diagnostic snapshot: fields the composer actually returned so we can
    // tell whether it built the PDF and populated body/attachments.
    composerDiag: {
      hasAttachments: Array.isArray(email.attachments) ? email.attachments.length : null,
      attachmentKeys: Array.isArray(email.attachments) && email.attachments[0] ? Object.keys(email.attachments[0]).sort() : null,
      bodyLen: (email.body || '').length,
      bodyPreview: (email.body || '').slice(0, 120),
      isHtml: email.isHtml,
      subject: email.subject,
      from: email.from,
      emailKeys: Object.keys(email).sort(),
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
      timings: e?.timings,
    });
  }
};

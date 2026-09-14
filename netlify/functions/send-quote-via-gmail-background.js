// send-quote-via-gmail.js
// -----------------------------------------------------------------------------
// SYNC replacement for QW's slow SendEmail step. The flow:
//
//   1. Log into QW  (na.quotewerks.com/login/login/login)
//   2. GetDocumentDeliverInitData(docRecGuid)
//   3. SetLayoutSelection  (picks "COL Quote Layout 2 - WIP" by default)
//   4. GeneratePrintPdf    (qwPrintMethod: 1 = Preview \u2014 same button Ryan sees)
//        \u2192 returns a real printPdfId (not the 00000000... dummy)
//   5. GET PrintPreviewPdf?id=<printPdfId>&inline=true  \u2192 raw PDF bytes
//   6. GetDocumentHeaders row (SoldTo / DocNo / DocDate / TotalPrice)
//   7. Send via Gmail SMTP (nodemailer) FROM bodyshop.e.s@gmail.com
//      TO the rep's own email (per Ryan's rule: "always goes back to the rep"),
//      with the PDF attached and a body matching the QW email template.
//
// Returns within ~10s (well under Netlify's 30s edge cap) because we skip
// QW's SendEmail entirely.
// -----------------------------------------------------------------------------

import nodemailer from 'nodemailer';

const QW_HOST = process.env.QW_HOST || 'na.quotewerks.com';
const QW_TENANT = process.env.QW_TENANT || 'caroliner002';

const cors = () => ({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
});

// --- tiny cookie jar -----------------------------------------------
function makeCookieJar() {
  const store = new Map();
  return {
    ingest(setCookieLine) {
      const first = String(setCookieLine).split(';', 1)[0];
      const eq = first.indexOf('=');
      if (eq > 0) store.set(first.slice(0, eq).trim(), first.slice(eq + 1));
    },
    header() {
      return Array.from(store.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    },
    get(name) { return store.get(name); },
  };
}
async function extractSetCookie(resp) {
  if (typeof resp.headers.getSetCookie === 'function') return resp.headers.getSetCookie();
  const out = [];
  for (const [k, v] of resp.headers) if (k.toLowerCase() === 'set-cookie') out.push(v);
  return out;
}

async function loginQw({ username, password }) {
  const jar = makeCookieJar();
  const url = `https://${QW_HOST}/login/login/login`;
  const body = JSON.stringify({
    tenantAccountNumber: QW_TENANT,
    username, password,
    twoFactorCode: '', rememberMe: true, returnUrl: '/ReleaseRouting/',
  });
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      accept: 'application/json, text/plain, */*',
      origin: `https://${QW_HOST}`,
      referer: `https://${QW_HOST}/login/`,
    },
    body, redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  });
  (await extractSetCookie(resp)).forEach(c => jar.ingest(c));
  if (!resp.ok) throw new Error(`login http ${resp.status}`);
  if (!jar.get('AspireIdentity.Auth') && !jar.get('.ASPXAUTH')) {
    throw new Error('login succeeded but no auth cookie');
  }
  return jar;
}

async function qwPost(jar, releasePath, path, body) {
  const url = `https://${QW_HOST}${releasePath}${path}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      cookie: jar.header(),
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json;charset=UTF-8',
      origin: `https://${QW_HOST}`,
      referer: `https://${QW_HOST}${releasePath}`,
    },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(20000),
  });
  const txt = await resp.text();
  if (!resp.ok) throw new Error(`${path} http ${resp.status}: ${txt.slice(0, 300)}`);
  try { return JSON.parse(txt); } catch { return { __rawBody: txt }; }
}

async function qwGetBytes(jar, releasePath, path) {
  const url = `https://${QW_HOST}${releasePath}${path}`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      cookie: jar.header(),
      accept: 'application/pdf, */*',
      origin: `https://${QW_HOST}`,
      referer: `https://${QW_HOST}${releasePath}`,
    },
    signal: AbortSignal.timeout(30000),
  });
  const buf = await resp.arrayBuffer();
  const bytes = Buffer.from(buf);
  if (!resp.ok) throw new Error(`${path} http ${resp.status}: ${bytes.slice(0, 200).toString()}`);
  const head = bytes.slice(0, 5).toString();
  if (head !== '%PDF-') throw new Error(`expected PDF, got: ${head}`);
  return bytes;
}

// --- fetch the DocumentHeaders row for To/Subject substitutions ---
async function fetchHeader(jar, releasePath, docRecGuid) {
  const search = await qwPost(jar, releasePath, 'api/v1/qw/tables/DocumentHeaders/search?page[size]=1', {
    filter: [{ name: 'DocRecGUID', op: 'eq', val: docRecGuid }],
  }).catch(() => null);
  return search?.data?.[0]?.attributes || null;
}

// --- pull the composer's suggested subject/body so email matches QW exactly --
async function fetchComposerEmail(jar, releasePath, docRecGuid) {
  const composer = await qwPost(jar, releasePath, 'api/Email/GetEmailComposerInitData', {
    emailContext: 'EmailQuote', docRecGuid, coverPageMessage: '', templateGuid: '',
    createPOforEachVendor: false, linkedResources: [],
    primaryLayoutFilterModel: 'QUOTE', poRecGuid: '', layoutOverride: '', poSetDefaultLayout: false,
  }).catch(() => null);
  return composer?.emailInitData?.[0]?.email || null;
}

// --- main handler --------------------------------------------------
export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors(), body: 'POST only' };

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: 'bad json' }) }; }

  const { docRecGuid, repUsername, repEmail } = payload;
  if (!docRecGuid || !repEmail) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: 'docRecGuid + repEmail required' }) };
  }

  // Resolve QW credentials for the rep (env-var-per-rep pattern from send-from-rep-background)
  const envKey = (repUsername || 'ryan.harthcock').replace(/[.\-]/g, '_');
  const qwUsername =
    process.env[`QW_USERNAME_${envKey}`] || process.env.QW_USERNAME_ryan_harthcock || process.env.QW_USERNAME;
  const qwPassword =
    process.env[`QW_PASSWORD_${envKey}`] || process.env.QW_PASSWORD_ryan_harthcock || process.env.QW_PASSWORD;
  if (!qwUsername || !qwPassword) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: `no QW creds for ${envKey}` }) };
  }

  // Resolve Gmail SMTP creds  (single env var: "user:app-password")
  const raw = process.env.GMAIL_SMTP_CREDS || '';
  const sep = raw.indexOf(':');
  if (sep < 0) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: 'GMAIL_SMTP_CREDS not set in "user:pass" form' }) };
  }
  const smtpUser = raw.slice(0, sep).trim();
  const smtpPass = raw.slice(sep + 1).trim();

  const timings = [];
  const step = async (name, fn) => {
    const t0 = Date.now();
    try { const v = await fn(); timings.push({ name, ms: Date.now() - t0 }); return v; }
    catch (e) { timings.push({ name, ms: Date.now() - t0, error: e.message }); throw e; }
  };

  try {
    const jar = await step('login', () => loginQw({ username: qwUsername, password: qwPassword }));
    const releasePath = '/r26b3b/'; // known release; skip discovery to save ~2s

    const deliverInit = await step('deliverInit',
      () => qwPost(jar, releasePath, 'api/DocumentDeliver/GetDocumentDeliverInitData',
                   { docRecGuid, isAdministrationMode: false }));
    const layouts = deliverInit?.newLayouts || [];
    // Prefer the newest patched layout. If Ryan imports another iteration, add it
    // to the top of this list.
    const preferred = [
      'COL Quote Layout New',
      'COL Quote Layout 2 - WIP',
    ];
    let primary = null;
    for (const name of preferred) {
      primary = layouts.find(l => l.layoutName === name);
      if (primary) break;
    }
    if (!primary) primary = layouts.find(l => l.isSelectedPrimary) || layouts[0];
    if (!primary) throw new Error('no layouts available');

    await step('setLayout', () => qwPost(jar, releasePath, 'api/DocumentDeliver/SetLayoutSelection', {
      layoutIdentifier: primary.file, layoutIsSelected: true, isPrimaryLayout: true,
      layoutType: primary.layoutType, layoutDisplayText: primary.layoutName, fileType: primary.fileType,
    }));

    // Preview method (1) produces a real printPdfId. SaveAsPdf (5) gives zeros.
    const pdfResp = await step('generatePdf',
      () => qwPost(jar, releasePath, 'api/DocumentDeliver/GeneratePrintPdf',
                   { coverPageMessage: '', qwPrintMethod: 1,
                     createPOforEachVendor: null, makePDFReadOnly: null }));
    const printPdfId = pdfResp?.pdfList?.[0]?.printPdfId;
    const pdfFileName = pdfResp?.pdfList?.[0]?.printPdfFileName || `Quote_${docRecGuid.slice(0,8)}.pdf`;
    if (!printPdfId || printPdfId === '00000000-0000-0000-0000-000000000000') {
      throw new Error(`GeneratePrintPdf returned no real id: ${JSON.stringify(pdfResp)}`);
    }

    const pdfBytes = await step('downloadPdf',
      () => qwGetBytes(jar, releasePath, `PrintPreviewPdf?id=${encodeURIComponent(printPdfId)}&inline=false`));

    // Pull DocNo / customer / total from the header for a nicer subject
    const header = await step('fetchHeader', () => fetchHeader(jar, releasePath, docRecGuid));
    const composerEmail = await step('fetchComposer', () => fetchComposerEmail(jar, releasePath, docRecGuid));

    const docNo = header?.DocNo || pdfFileName.replace(/\.pdf$/i, '');
    const soldToCompany = header?.SoldToCompany || '';
    const soldToContact = [header?.SoldToFirstName, header?.SoldToLastName].filter(Boolean).join(' ').trim();
    const total = header?.TotalPrice != null
      ? Number(header.TotalPrice).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
      : '';

    // QW composer subject is literally "<#AAAQ1069>" — that's a template placeholder,
    // not a real subject. Always synthesize a clean subject line.
    const subject = `Quote ${docNo}${soldToCompany ? ' — ' + soldToCompany : ''}`;
    const bodyHtml = composerEmail?.body
      ? composerEmail.body
      : `<p>Quote ${docNo} is attached${soldToCompany ? ' for ' + soldToCompany : ''}${total ? ' (' + total + ')' : ''}.</p>`;
    const bodyText = bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    // Send via Gmail SMTP
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true,
      auth: { user: smtpUser, pass: smtpPass },
    });

    const info = await step('smtpSend', () => transporter.sendMail({
      from: `Body Shop Equipment Solutions <${smtpUser}>`,
      to: repEmail,
      replyTo: repEmail,
      subject,
      text: bodyText,
      html: bodyHtml,
      attachments: [{ filename: `${docNo}.pdf`, content: pdfBytes, contentType: 'application/pdf' }],
    }));

    return {
      statusCode: 200,
      headers: { ...cors(), 'content-type': 'application/json' },
      body: JSON.stringify({
        ok: true, docNo, printPdfId,
        pdfBytes: pdfBytes.length,
        layoutUsed: primary?.layoutName,
        layoutsAvailable: layouts.map(l => l.layoutName),
        to: repEmail,
        subject,
        messageId: info.messageId,
        accepted: info.accepted, rejected: info.rejected,
        timings,
      }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { ...cors(), 'content-type': 'application/json' },
      body: JSON.stringify({ ok: false, error: String(e.message || e), timings }),
    };
  }
};

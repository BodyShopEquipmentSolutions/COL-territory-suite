// Probe QW for layout-management endpoints.
import { Buffer } from 'node:buffer';

const QW_HOST = process.env.QW_HOST || 'na.quotewerks.com';
const QW_RELEASE = process.env.QW_RELEASE_PATH || '/r26b3b/';
const QW_TENANT = process.env.QW_TENANT || 'caroliner002';
const QW_USER = process.env.QW_USERNAME_ryan_harthcock;
const QW_PASS = process.env.QW_PASSWORD_ryan_harthcock;

async function login() {
  const r = await fetch(`https://${QW_HOST}/login/login/login`, {
    method:'POST',
    headers:{'content-type':'application/json'},
    body: JSON.stringify({
      tenantAccountNumber: QW_TENANT, username: QW_USER, password: QW_PASS,
      twoFactorCode:'', rememberMe:true, returnUrl:'/ReleaseRouting/',
    }),
    redirect:'manual',
  });
  const cookies = (r.headers.getSetCookie?.() || (r.headers.raw ? r.headers.raw()['set-cookie'] : []) || []).map(c => c.split(';')[0]).join('; ');
  return cookies;
}

async function tryPath(cookies, method, path, body) {
  try {
    const r = await fetch(`https://${QW_HOST}${QW_RELEASE}${path}`, {
      method,
      headers: {
        cookie: cookies,
        ...(body ? {'content-type':'application/json'} : {}),
        accept: '*/*',
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const text = await r.text();
    return { status: r.status, ctype: r.headers.get('content-type'), len: text.length, sample: text.slice(0, 400) };
  } catch (e) {
    return { error: e.message };
  }
}

export const handler = async (event) => {
  const cookies = await login();
  const paths = [
    // Common QW endpoints
    ['GET', 'api/Layouts'],
    ['GET', 'api/Layout'],
    ['GET', 'api/PrintLayouts'],
    ['GET', 'api/PrintLayout'],
    ['GET', 'api/LayoutManager/List'],
    ['GET', 'api/LayoutDesigner/List'],
    ['GET', 'api/DocumentDeliver/GetLayouts'],
    ['POST', 'api/DocumentDeliver/GetLayouts', {docType:'QUOTE'}],
    // Design/edit endpoints
    ['GET', 'api/LayoutDesigner/Get?name=COL Quote Layout 2 - WIP'],
    ['GET', 'api/Layout/Download?name=COL Quote Layout 2 - WIP'],
    ['GET', `Design/PrintLayout?name=${encodeURIComponent('COL Quote Layout 2 - WIP')}`],
    ['GET', 'Design/PrintLayout'],
    ['GET', 'Layouts'],
  ];
  const results = {};
  for (const [m, p, b] of paths) {
    results[`${m} ${p}`] = await tryPath(cookies, m, p, b);
  }
  return {
    statusCode: 200,
    headers: {'content-type':'application/json'},
    body: JSON.stringify(results, null, 2),
  };
};

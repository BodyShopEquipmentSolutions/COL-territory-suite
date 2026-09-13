// Diagnostic: log into QW, fetch the main app index and every referenced JS
// bundle, and grep them for any API paths that look like PDF/attachment
// downloads. Returns the matching lines so we can pick the real endpoint.
import { execSync } from 'child_process';

const QW_HOST = process.env.QW_HOST || 'na.quotewerks.com';
const QW_TENANT = process.env.QW_TENANT || 'caroliner002';

const cors = () => ({
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Methods':'POST,OPTIONS',
  'Access-Control-Allow-Headers':'content-type',
});

async function login(){
  const u = process.env.QW_USERNAME_ryan_harthcock;
  const p = process.env.QW_PASSWORD_ryan_harthcock;
  const r = await fetch(`https://${QW_HOST}/login/login/login`, {
    method:'POST',
    headers:{ 'content-type':'application/json;charset=UTF-8',
              accept:'application/json,text/plain,*/*',
              origin:`https://${QW_HOST}`, referer:`https://${QW_HOST}/login/` },
    body: JSON.stringify({
      tenantAccountNumber: QW_TENANT, username:u, password:p,
      twoFactorCode:'', rememberMe:true, returnUrl:'/ReleaseRouting/',
    }),
    redirect:'manual',
  });
  const raw = [];
  if (typeof r.headers.getSetCookie === 'function') raw.push(...r.headers.getSetCookie());
  else for (const [k,v] of r.headers) if (k.toLowerCase()==='set-cookie') raw.push(v);
  const jar = {};
  for (const line of raw) {
    const m = /^([^=]+)=([^;]*)/.exec(line);
    if (m) jar[m[1].trim()] = m[2];
  }
  const cookie = Object.entries(jar).map(([k,v])=>`${k}=${v}`).join('; ');
  return cookie;
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode:200, headers:cors(), body:'' };
  try {
    const cookie = await login();
    // Fetch the main app index
    const idxResp = await fetch(`https://${QW_HOST}/r26b3b/`, { headers:{ cookie } });
    const idx = await idxResp.text();
    const scriptSrcs = Array.from(idx.matchAll(/src="([^"]+\.js[^"]*)"/g)).map(m=>m[1]);
    // Also grab a couple of likely index locations
    const bundles = [];
    for (const s of scriptSrcs) {
      const url = s.startsWith('http') ? s : (s.startsWith('/') ? `https://${QW_HOST}${s}` : `https://${QW_HOST}/r26b3b/${s}`);
      try {
        const b = await fetch(url, { headers:{ cookie } });
        const txt = await b.text();
        bundles.push({ url, len: txt.length });
        // Grep the text for lines that look like attachment/pdf-download URLs
        const re = /['"`]([\w/.\-]*(attachment|Attachment|Pdf|PDF|Download|download)[\w/.\-]*)['"`]/g;
        const matches = new Set();
        let m; while ((m = re.exec(txt))) matches.add(m[1]);
        bundles[bundles.length-1].matches = Array.from(matches).slice(0,80);
      } catch (e) {
        bundles.push({ url, error: e.message });
      }
    }
    return { statusCode:200, headers:{...cors(),'content-type':'application/json'},
             body: JSON.stringify({ ok:true, scriptCount: scriptSrcs.length, bundles }, null, 2) };
  } catch (e) {
    return { statusCode:500, headers:cors(), body: JSON.stringify({ error: String(e), stack: e.stack }) };
  }
};

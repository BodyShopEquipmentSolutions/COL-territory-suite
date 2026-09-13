// Scan QW's JS bundles for layout-designer routes.
const QW_HOST = process.env.QW_HOST || 'na.quotewerks.com';
const QW_RELEASE = process.env.QW_RELEASE_PATH || '/r26b3b/';
const QW_TENANT = process.env.QW_TENANT || 'caroliner002';
const QW_USER = process.env.QW_USERNAME_ryan_harthcock;
const QW_PASS = process.env.QW_PASSWORD_ryan_harthcock;

async function login() {
  const r = await fetch(`https://${QW_HOST}/login/login/login`, {
    method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({tenantAccountNumber:QW_TENANT,username:QW_USER,password:QW_PASS,twoFactorCode:'',rememberMe:true,returnUrl:'/ReleaseRouting/'}),
    redirect:'manual',
  });
  return (r.headers.getSetCookie?.() || []).map(c=>c.split(';')[0]).join('; ');
}

export const handler = async () => {
  const cookies = await login();
  // Fetch the app shell to enumerate JS bundles
  const shell = await fetch(`https://${QW_HOST}${QW_RELEASE}`, { headers:{cookie:cookies} });
  const html = await shell.text();
  const scriptSrcs = [...html.matchAll(/<script[^>]+src="([^"]+\.js[^"]*)"/g)].map(m=>m[1]);
  // Also grep the HTML itself for layout/design references
  const inHtml = [...new Set([...html.matchAll(/[A-Za-z]*[Ll]ayout[A-Za-z]*/g)].map(m=>m[0]))];
  const inHtmlDesign = [...new Set([...html.matchAll(/[A-Za-z]*[Dd]esign[A-Za-z]*/g)].map(m=>m[0]))];

  const layoutHits = {};
  for (const src of scriptSrcs) {
    const url = src.startsWith('http') ? src : `https://${QW_HOST}${src.startsWith('/')?'':QW_RELEASE}${src}`;
    try {
      const r = await fetch(url, { headers:{cookie:cookies} });
      const js = await r.text();
      // Match endpoint-looking strings mentioning Layout, Design, Editor, .rtm
      const paths = [...new Set([
        ...js.matchAll(/["'`](\/?[A-Za-z0-9_\/\-]*(Layout|Design|Editor|Report|Rtm)[A-Za-z0-9_\/\-]*)["'`]/g),
      ].map(m=>m[1]))].filter(p=>p.length<120);
      if (paths.length) layoutHits[src] = paths.slice(0, 40);
    } catch (e) {
      layoutHits[src] = ['ERR:'+e.message];
    }
  }
  return {
    statusCode:200,
    headers:{'content-type':'application/json'},
    body: JSON.stringify({shellScriptCount:scriptSrcs.length, inHtml, inHtmlDesign, layoutHits}, null, 2),
  };
};

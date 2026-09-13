// Diagnostic: log into QW, generate preview PDF for a doc, return the PDF bytes.
import * as cookie from 'cookie';

const QW_HOST = process.env.QW_HOST || 'na.quotewerks.com';
const QW_RELEASE = process.env.QW_RELEASE_PATH || '/r26b3b/';
const QW_TENANT = process.env.QW_TENANT || 'caroliner002';
const QW_USER = process.env.QW_USERNAME_ryan_harthcock;
const QW_PASS = process.env.QW_PASSWORD_ryan_harthcock;

async function login() {
  const r = await fetch(`https://${QW_HOST}/login/login/login`, {
    method:'POST',
    headers:{'content-type':'application/json'},
    body: JSON.stringify({tenantAccountNumber:QW_TENANT, username:QW_USER, password:QW_PASS, twoFactorCode:'', rememberMe:true, returnUrl:'/ReleaseRouting/'}),
    redirect:'manual',
  });
  return (r.headers.getSetCookie?.() || []).map(c=>c.split(';')[0]).join('; ');
}

async function qwPost(cookies, path, body) {
  const r = await fetch(`https://${QW_HOST}${QW_RELEASE}${path}`, {
    method:'POST',
    headers:{cookie:cookies,'content-type':'application/json',accept:'*/*'},
    body: JSON.stringify(body),
  });
  const t = await r.text();
  return JSON.parse(t);
}

export const handler = async (event) => {
  const docId = event.queryStringParameters?.docId;
  if (!docId) return {statusCode:400,body:'docId required'};

  const cookies = await login();

  const init = await qwPost(cookies, 'api/DocumentDeliver/GetDocumentDeliverInitData', {
    documentDeliverContextData: {
      documentDeliverType: 3, quotingProcessSubType: 3, contextType: 3,
      contextGuid: docId, cmGuid: '',
      primaryLayoutFilterModel: 'QUOTE', poRecGuid: '', layoutOverride: '', poSetDefaultLayout: false,
    },
  });

  const primary = init?.newLayouts?.find(l => l.layoutName === 'COL Quote Layout 2 - WIP')
               || init?.newLayouts?.find(l => l.isSelectedPrimary)
               || init?.newLayouts?.[0];

  await qwPost(cookies, 'api/DocumentDeliver/SetLayoutSelection', {
    layoutIdentifier: primary.file, layoutIsSelected: true, isPrimaryLayout: true,
    layoutType: primary.layoutType, layoutDisplayText: primary.layoutName, fileType: primary.fileType,
  });

  const gen = await qwPost(cookies, 'api/DocumentDeliver/GeneratePrintPdf', {qwPrintMethod: 1});
  const pdfId = gen.printPdfId;

  const pdfR = await fetch(`https://${QW_HOST}${QW_RELEASE}PrintPreviewPdf?id=${pdfId}&inline=false`, {
    headers:{cookie:cookies},
  });
  const buf = Buffer.from(await pdfR.arrayBuffer());

  return {
    statusCode:200,
    headers:{'content-type':'application/pdf'},
    body: buf.toString('base64'),
    isBase64Encoded: true,
  };
};

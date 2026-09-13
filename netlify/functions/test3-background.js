// Netlify Functions v2 API: uses `export default` with (Request, Context).
console.log('[test3-bg] MODULE LOAD at', new Date().toISOString());

export default async (req, context) => {
  console.log('[test3-bg] HANDLER CALLED method=', req.method, 'ct=', req.headers.get('content-type'));
  try {
    const text = await req.text();
    console.log('[test3-bg] body:', text.slice(0, 200));
  } catch(e) { console.log('[test3-bg] body read err:', e.message); }
  await new Promise(r => setTimeout(r, 2000));
  console.log('[test3-bg] HANDLER DONE');
  return new Response('ok');
};

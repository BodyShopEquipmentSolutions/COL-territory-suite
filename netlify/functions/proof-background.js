export default async (req) => {
  // Ping external service — if this shows up, we know function ran
  const stamp = new Date().toISOString();
  const pingUrl = `https://httpbin.org/anything/proof-bg-${stamp}?src=netlify-background`;
  try {
    const r = await fetch(pingUrl, { method: 'POST', body: 'from-background' });
    console.log('[proof-bg] pinged httpbin, status=', r.status);
  } catch(e) {
    console.log('[proof-bg] ping failed:', e.message);
  }
  return new Response('ok');
};

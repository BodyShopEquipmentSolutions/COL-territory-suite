// Background function that pings our OWN sync function so its execution shows
// up in logs (we've confirmed sync-function logging works). If the sync fn
// receives a ping, we know this background function actually ran.
export default async (req, context) => {
  const stamp = new Date().toISOString();
  const body = await req.text().catch(() => '');
  const siteUrl = process.env.URL || 'https://bodyshopequipment.solutions';
  try {
    const r = await fetch(`${siteUrl}/.netlify/functions/proof-sink?ts=${encodeURIComponent(stamp)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'proof-background', ts: stamp, requestBody: body }),
    });
    console.log('[proof-bg] ping proof-sink status=', r.status);
  } catch(e) {
    console.log('[proof-bg] ping failed:', e.message);
  }
  return new Response('ok');
};

// Sync function whose sole purpose is to receive pings from background functions
// and log them, so we can prove that background functions ran (background
// function logs on this site are unreliable, but sync logs are visible).
export default async (req) => {
  const url = new URL(req.url);
  const ts = url.searchParams.get('ts') || 'no-ts';
  const body = await req.text().catch(() => '');
  console.log('[proof-sink] RECEIVED ping ts=', ts, 'bodyLen=', body.length);
  console.log('[proof-sink] body:', body.slice(0, 400));
  return new Response(JSON.stringify({ ok: true, receivedAt: new Date().toISOString(), ts }), {
    headers: { 'content-type': 'application/json' },
  });
};

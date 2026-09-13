// Netlify Functions v1 API: exports.handler pattern
export const handler = async (event) => {
  console.log('[proof-sink-v1] RECEIVED method=', event.httpMethod, 'qs=', JSON.stringify(event.queryStringParameters));
  // Log body in chunks so long messages aren't truncated by log-line limits
  const body = event.body || '';
  const CHUNK = 500;
  for (let i = 0; i < body.length; i += CHUNK) {
    console.log(`[proof-sink-v1] body[${i}]:`, body.slice(i, i + CHUNK));
  }
  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, at: new Date().toISOString() }),
    headers: { 'content-type': 'application/json' },
  };
};

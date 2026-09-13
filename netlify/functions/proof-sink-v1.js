// Netlify Functions v1 API: exports.handler pattern
export const handler = async (event) => {
  console.log('[proof-sink-v1] RECEIVED method=', event.httpMethod, 'qs=', JSON.stringify(event.queryStringParameters));
  console.log('[proof-sink-v1] body:', (event.body || '').slice(0, 200));
  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, at: new Date().toISOString() }),
    headers: { 'content-type': 'application/json' },
  };
};

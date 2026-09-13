// Sync diagnostic endpoint: runs the same QW email flow as
// send-from-rep-background but SYNCHRONOUSLY so the caller sees the
// full result (or the error + step timings) directly. Useful for
// debugging why a queued send didn't land.
//
// POST body: { docRecGuid, repUsername, repEmail }

import { sendQwEmailAsRep } from './send-from-rep-background.js';

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors(), body: JSON.stringify({ error: 'POST only' }) };
  }
  let payload = {};
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: 'bad json' }) }; }

  const t0 = Date.now();
  try {
    const r = await sendQwEmailAsRep(payload);
    return {
      statusCode: 200,
      headers: cors(),
      body: JSON.stringify({ ok: true, totalMs: Date.now() - t0, ...r }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: cors(),
      body: JSON.stringify({
        ok: false,
        totalMs: Date.now() - t0,
        error: e?.message || String(e),
        timings: e?.timings,
        sendResponse: e?.sendResponse,
      }),
    };
  }
};

function cors() {
  return {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}

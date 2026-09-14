// detect-parts-in-photo.js
// Rep takes a photo of a shop wall / rack / assembly. This function forwards
// the image plus a compact catalog of candidate parts (from the current audit
// panel) to a vision LLM via Perplexity's API, and returns the list of part
// numbers the model detects.
//
// Request: POST JSON
//   {
//     "photoDataUrl": "data:image/jpeg;base64,...",
//     "candidates": [ { "partNumber": "CTR9", "description": "..." }, ... ],
//     "hint": "Optional context, e.g. 'work-space wall behind the frame rack'"
//   }
//
// Response:
//   { ok: true, detected: [ { partNumber, confidence, reasoning } ], cost_usd, model }

const PPLX_URL = 'https://api.perplexity.ai/v1/responses';
const MODEL = 'anthropic/claude-haiku-4-5';

export default async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const photoDataUrl = body.photoDataUrl;
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  const hint = (body.hint || '').toString().slice(0, 300);

  if (!photoDataUrl || !photoDataUrl.startsWith('data:image/')) {
    return json({ ok: false, error: 'photoDataUrl missing or not a data URL' }, 400);
  }
  if (candidates.length === 0) {
    return json({ ok: false, error: 'candidates list is empty' }, 400);
  }
  // Guard against absurdly large catalogs blowing the token budget
  const capped = candidates.slice(0, 200).map(c => ({
    partNumber: String(c.partNumber || '').slice(0, 40),
    description: String(c.description || '').slice(0, 200),
  }));

  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return json({ ok: false, error: 'PERPLEXITY_API_KEY not configured on server' }, 500);

  const catalogText = capped
    .map(c => `- ${c.partNumber}: ${c.description}`)
    .join('\n');

  const systemInstructions = `You are a Car-O-Liner collision-equipment auditor. You will be given ONE photo taken by a body-shop sales rep during a shop walkthrough, plus a list of candidate parts that could be in the photo.

Your job:
1. Identify which of the candidate parts you can SEE in the photo.
2. Only report a part if you are reasonably confident it matches. Do NOT guess based on plausibility - only report what you actually see.
3. Match by shape, function, labeling, and description. A "clamp", "puller", "adapter", "cable", etc. is only that if it visually matches.
4. Return STRICT JSON only - no markdown, no prose - matching this schema:
   { "detected": [ { "partNumber": "...", "confidence": "high|medium|low", "reasoning": "one-sentence why" } ] }
5. If nothing in the photo matches, return { "detected": [] }.

Candidate parts (part number : description):
${catalogText}${hint ? `\n\nRep context: ${hint}` : ''}`;

  const payload = {
    model: MODEL,
    max_output_tokens: 1500,
    temperature: 0,
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: systemInstructions },
          { type: 'input_image', image_url: photoDataUrl },
        ],
      },
    ],
  };

  let resp;
  try {
    resp = await fetch(PPLX_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return json({ ok: false, error: 'network error to Perplexity: ' + err.message }, 502);
  }

  const raw = await resp.text();
  if (!resp.ok) {
    return json({ ok: false, error: `Perplexity API ${resp.status}`, detail: raw.slice(0, 800) }, 502);
  }

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return json({ ok: false, error: 'invalid JSON from Perplexity', detail: raw.slice(0, 800) }, 502); }

  const text = parsed?.output?.[0]?.content?.[0]?.text || '';
  const cost = parsed?.usage?.cost?.total_cost ?? null;

  // Model may wrap JSON in ```json fences or add trailing prose - extract it.
  const detected = extractDetected(text);

  return json({
    ok: true,
    detected,
    cost_usd: cost,
    model: MODEL,
    input_tokens: parsed?.usage?.input_tokens ?? null,
    output_tokens: parsed?.usage?.output_tokens ?? null,
  });
};

function extractDetected(text) {
  if (!text) return [];
  // Try direct parse first
  let obj = tryParse(text);
  if (!obj) {
    // Look for the first {...} block
    const m = text.match(/\{[\s\S]*\}/);
    if (m) obj = tryParse(m[0]);
  }
  if (!obj || !Array.isArray(obj.detected)) return [];
  return obj.detected
    .filter(d => d && d.partNumber)
    .map(d => ({
      partNumber: String(d.partNumber).trim(),
      confidence: String(d.confidence || 'medium').toLowerCase(),
      reasoning: String(d.reasoning || '').slice(0, 400),
    }));
}
function tryParse(s) { try { return JSON.parse(s); } catch { return null; } }

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const config = { path: '/.netlify/functions/detect-parts-in-photo' };

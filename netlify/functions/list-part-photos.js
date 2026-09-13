// list-part-photos.js
// Returns a map of { partNumber -> url } for every custom photo stored in the
// 'part-photos' blob store. Called on audit tool load to overlay custom
// photos onto the bundle catalog.

import { getStore } from '@netlify/blobs';

export default async () => {
  const store = getStore({ name: 'part-photos' });
  const { blobs } = await store.list();

  // Each blob key is like "CAR35784-01.jpg". Metadata carries the original
  // partNumber (which may contain '/' etc that got sanitized in the key), so
  // prefer that when available.
  const out = {};
  await Promise.all(
    (blobs || []).map(async (b) => {
      const meta = await store.getMetadata(b.key).catch(() => null);
      const partNumber = meta?.metadata?.partNumber || stripExt(b.key);
      // Newest wins if there are collisions (uploaded twice for same PN)
      const uploadedAt = meta?.metadata?.uploadedAt || '';
      const cur = out[partNumber];
      if (!cur || uploadedAt > cur.uploadedAt) {
        out[partNumber] = {
          key: b.key,
          url: `/.netlify/functions/get-part-photo?key=${encodeURIComponent(b.key)}`,
          uploadedAt,
        };
      }
    })
  );

  // Simplify to { partNumber -> url } for the frontend
  const simple = {};
  for (const [pn, v] of Object.entries(out)) simple[pn] = v.url;

  return new Response(JSON.stringify({ ok: true, photos: simple, count: Object.keys(simple).length }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-cache',
    },
  });
};

function stripExt(k) {
  return k.replace(/\.[^.]+$/, '');
}

export const config = { path: '/.netlify/functions/list-part-photos' };

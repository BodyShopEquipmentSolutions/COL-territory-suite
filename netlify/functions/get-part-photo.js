// get-part-photo.js
// Serves an image stored in Netlify Blobs. Query: ?key=<blob-key>
// Returns 404 if not found. Cached at the edge for 1 hour to keep the audit
// tool responsive across page reloads.

import { getStore } from '@netlify/blobs';

export default async (req) => {
  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  if (!key) return new Response('missing key', { status: 400 });

  const store = getStore({ name: 'part-photos' });
  const meta = await store.getMetadata(key).catch(() => null);
  if (!meta) return new Response('not found', { status: 404 });

  const body = await store.get(key, { type: 'stream' });
  if (!body) return new Response('not found', { status: 404 });

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': meta.metadata?.contentType || 'image/jpeg',
      'cache-control': 'public, max-age=3600, s-maxage=3600',
      'access-control-allow-origin': '*',
    },
  });
};

export const config = { path: '/.netlify/functions/get-part-photo' };

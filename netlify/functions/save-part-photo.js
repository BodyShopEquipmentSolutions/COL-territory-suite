// save-part-photo.js
// Accepts a multipart form upload from the audit tool's on-site photo capture.
// Stores the image in Netlify Blobs keyed by part number and returns the
// public URL to display and persist in the app.
//
// Request: POST multipart/form-data with fields:
//   partNumber - string (e.g. "CAR35784-01")
//   file       - the image (JPEG/PNG/WebP, up to ~5MB)
//
// Response: { ok, partNumber, url, size, contentType }

import { getStore } from '@netlify/blobs';
import formidable from 'formidable';
import fs from 'node:fs/promises';

export default async (req, context) => {
  if (req.method !== 'POST') {
    return json({ ok: false, error: 'POST only' }, 405);
  }

  // formidable expects a Node IncomingMessage. On Netlify Edge/Functions v2 the
  // Request is a WHATWG Request; convert to a buffer then hand to formidable
  // via a shim, OR parse the multipart manually. Simpler: parse manually with
  // a small helper since we only have 2 fields.
  const ct = req.headers.get('content-type') || '';
  if (!ct.startsWith('multipart/form-data')) {
    return json({ ok: false, error: 'expected multipart/form-data' }, 400);
  }
  const boundary = ct.match(/boundary=(.+)$/i)?.[1];
  if (!boundary) return json({ ok: false, error: 'missing boundary' }, 400);

  const buf = Buffer.from(await req.arrayBuffer());
  const parts = parseMultipart(buf, boundary);
  const partNumber = parts.find(p => p.name === 'partNumber')?.value?.toString().trim();
  const file = parts.find(p => p.name === 'file' && p.filename);
  if (!partNumber) return json({ ok: false, error: 'missing partNumber' }, 400);
  if (!file) return json({ ok: false, error: 'missing file' }, 400);
  if (file.data.length > 6 * 1024 * 1024) {
    return json({ ok: false, error: 'file too large (max ~6MB)' }, 413);
  }

  // Normalize part number to safe blob key
  const key = partNumber.replace(/[^A-Za-z0-9._-]/g, '_');
  const ext = extForContentType(file.contentType) || extFromName(file.filename) || 'jpg';
  const blobKey = `${key}.${ext}`;

  const store = getStore({ name: 'part-photos', consistency: 'strong' });
  await store.set(blobKey, file.data, {
    metadata: {
      partNumber,
      contentType: file.contentType || 'image/jpeg',
      uploadedAt: new Date().toISOString(),
      originalName: file.filename || '',
    },
  });

  const url = `/.netlify/functions/get-part-photo?key=${encodeURIComponent(blobKey)}`;
  return json({
    ok: true,
    partNumber,
    key: blobKey,
    url,
    size: file.data.length,
    contentType: file.contentType || 'image/jpeg',
  });
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function extForContentType(ct) {
  if (!ct) return null;
  ct = ct.toLowerCase();
  if (ct.includes('jpeg')) return 'jpg';
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('heic')) return 'heic';
  return null;
}
function extFromName(name) {
  if (!name) return null;
  const m = name.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : null;
}

// --- Minimal multipart/form-data parser ---
// Handles the two-field case (partNumber + file). No streaming; the entire
// body is already a Buffer.
function parseMultipart(buf, boundary) {
  const delim = Buffer.from(`--${boundary}`);
  const parts = [];
  let idx = 0;
  while (idx < buf.length) {
    const start = buf.indexOf(delim, idx);
    if (start < 0) break;
    const partStart = start + delim.length;
    // Terminating boundary?
    if (buf[partStart] === 0x2d && buf[partStart + 1] === 0x2d) break;
    // Skip CRLF after boundary
    let cursor = partStart;
    if (buf[cursor] === 0x0d && buf[cursor + 1] === 0x0a) cursor += 2;
    // Header block ends at CRLFCRLF
    const headerEnd = buf.indexOf(Buffer.from('\r\n\r\n'), cursor);
    if (headerEnd < 0) break;
    const headerBlock = buf.slice(cursor, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;
    const nextDelim = buf.indexOf(delim, bodyStart);
    if (nextDelim < 0) break;
    // Body excludes the trailing CRLF that precedes the next boundary
    const bodyEnd = nextDelim - 2;
    const body = buf.slice(bodyStart, bodyEnd);

    const headers = {};
    headerBlock.split('\r\n').forEach(line => {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).toLowerCase().trim()] = line.slice(i + 1).trim();
    });
    const cd = headers['content-disposition'] || '';
    const nameMatch = cd.match(/\bname="([^"]*)"/);
    const filenameMatch = cd.match(/\bfilename="([^"]*)"/);
    const contentType = headers['content-type'] || null;
    if (filenameMatch) {
      parts.push({
        name: nameMatch?.[1] || '',
        filename: filenameMatch[1],
        contentType,
        data: body,
      });
    } else {
      parts.push({
        name: nameMatch?.[1] || '',
        value: body.toString('utf8'),
      });
    }
    idx = nextDelim;
  }
  return parts;
}

export const config = { path: '/.netlify/functions/save-part-photo' };

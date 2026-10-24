// Blob storage for uploads (attachments, avatars, branding), keyed by the
// filenames stored in the DB. Avatars live under an 'avatars/' prefix.
//
// - Disk (Docker): files under UPLOADS_DIR, same layout as before.
// - R2 (Cloudflare Workers): the Worker entry calls useR2(env.UPLOADS);
//   keys map 1:1 onto object names.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { trackPending } = require('../db/pool');

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';

let bucket = null;

function useR2(r2Bucket) {
  bucket = r2Bucket || null;
}

function backend() {
  return bucket ? 'r2' : 'disk';
}

// Keys come from DB rows we wrote ourselves, but never let one escape
// the uploads root.
function diskPath(key) {
  const p = path.resolve(UPLOADS_DIR, key);
  if (p !== path.resolve(UPLOADS_DIR) && !p.startsWith(path.resolve(UPLOADS_DIR) + path.sep)) {
    throw new Error(`invalid storage key: ${key}`);
  }
  return p;
}

async function put(key, bytes, { contentType } = {}) {
  if (bucket) {
    await bucket.put(key, bytes, contentType ? { httpMetadata: { contentType } } : undefined);
    return;
  }
  const p = diskPath(key);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, bytes);
}

// Returns a Buffer, or null when the object doesn't exist.
async function get(key) {
  if (bucket) {
    const obj = await bucket.get(key);
    return obj ? Buffer.from(await obj.arrayBuffer()) : null;
  }
  try {
    return await fsp.readFile(diskPath(key));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function exists(key) {
  if (bucket) return (await bucket.head(key)) !== null;
  return fs.existsSync(diskPath(key));
}

// Best-effort delete; a missing object isn't an error. Callers usually
// don't await it, so register it with the Worker request scope to keep it
// from being cancelled once the response is out.
function remove(key) {
  return trackPending((async () => {
    try {
      if (bucket) await bucket.delete(key);
      else await fsp.unlink(diskPath(key));
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`storage remove ${key}:`, err.message);
    }
  })());
}

// Send an object as the response body. Returns false (and sends nothing)
// when it doesn't exist, so callers can pick their own 404. Headers the
// caller already set (Content-Type, Content-Disposition, Cache-Control)
// are kept.
async function send(res, key) {
  if (!bucket) {
    const p = diskPath(key);
    if (!fs.existsSync(p)) return false;
    // No callback: stream errors go to next(err), as before.
    res.sendFile(p);
    return true;
  }
  const obj = await bucket.get(key);
  if (!obj) return false;
  if (!res.get('Content-Type') && obj.httpMetadata?.contentType) res.type(obj.httpMetadata.contentType);
  res.set('Content-Length', String(obj.size));
  res.end(Buffer.from(await obj.arrayBuffer()));
  return true;
}

module.exports = { useR2, backend, put, get, exists, remove, send, UPLOADS_DIR };

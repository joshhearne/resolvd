const { randomUUID } = require('crypto');
const { pool } = require('../db/pool');
const storage = require('./storage');

const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

// Storage key for an avatar filename (stored bare in users.profile_picture_filename).
function avatarKey(filename) {
  return `avatars/${filename}`;
}

async function saveAvatarBytes(userId, buffer, mimetype) {
  const ext = MIME_EXT[mimetype] || '.jpg';
  const filename = `avatar-${userId}-${randomUUID()}${ext}`;
  await storage.put(avatarKey(filename), buffer, { contentType: mimetype });

  const old = await pool.query('SELECT profile_picture_filename FROM users WHERE id = $1', [userId]);
  if (old.rows[0]?.profile_picture_filename) {
    storage.remove(avatarKey(old.rows[0].profile_picture_filename));
  }
  await pool.query('UPDATE users SET profile_picture_filename = $1 WHERE id = $2', [filename, userId]);
  return filename;
}

async function clearAvatar(userId) {
  const r = await pool.query('SELECT profile_picture_filename FROM users WHERE id = $1', [userId]);
  if (r.rows[0]?.profile_picture_filename) {
    storage.remove(avatarKey(r.rows[0].profile_picture_filename));
  }
  await pool.query('UPDATE users SET profile_picture_filename = NULL WHERE id = $1', [userId]);
}

async function fetchAndSaveAvatarFromUrl(userId, url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const mimetype = res.headers.get('content-type') || 'image/jpeg';
    if (!mimetype.startsWith('image/')) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > 5 * 1024 * 1024) return null;
    return await saveAvatarBytes(userId, buffer, mimetype.split(';')[0].trim());
  } catch {
    return null;
  }
}

async function saveAvatarFromBytes(userId, bytes, mimetype) {
  if (!bytes || !mimetype || !mimetype.startsWith('image/')) return null;
  if (bytes.length > 5 * 1024 * 1024) return null;
  return await saveAvatarBytes(userId, bytes, mimetype);
}

module.exports = {
  avatarKey,
  saveAvatarBytes,
  clearAvatar,
  fetchAndSaveAvatarFromUrl,
  saveAvatarFromBytes,
};

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const fetch = require('node-fetch');
const { pool } = require('../db/pool');

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';
const AVATAR_DIR = path.join(UPLOADS_DIR, 'avatars');

if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });

const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

function avatarPath(filename) {
  return path.join(AVATAR_DIR, filename);
}

async function saveAvatarBytes(userId, buffer, mimetype) {
  const ext = MIME_EXT[mimetype] || '.jpg';
  const filename = `avatar-${userId}-${randomUUID()}${ext}`;
  fs.writeFileSync(avatarPath(filename), buffer);

  const old = await pool.query('SELECT profile_picture_filename FROM users WHERE id = $1', [userId]);
  if (old.rows[0]?.profile_picture_filename) {
    fs.unlink(avatarPath(old.rows[0].profile_picture_filename), () => {});
  }
  await pool.query('UPDATE users SET profile_picture_filename = $1 WHERE id = $2', [filename, userId]);
  return filename;
}

async function clearAvatar(userId) {
  const r = await pool.query('SELECT profile_picture_filename FROM users WHERE id = $1', [userId]);
  if (r.rows[0]?.profile_picture_filename) {
    fs.unlink(avatarPath(r.rows[0].profile_picture_filename), () => {});
  }
  await pool.query('UPDATE users SET profile_picture_filename = NULL WHERE id = $1', [userId]);
}

async function fetchAndSaveAvatarFromUrl(userId, url) {
  try {
    const res = await fetch(url, { timeout: 8000 });
    if (!res.ok) return null;
    const mimetype = res.headers.get('content-type') || 'image/jpeg';
    if (!mimetype.startsWith('image/')) return null;
    const buffer = await res.buffer();
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
  AVATAR_DIR,
  avatarPath,
  saveAvatarBytes,
  clearAvatar,
  fetchAndSaveAvatarFromUrl,
  saveAvatarFromBytes,
};

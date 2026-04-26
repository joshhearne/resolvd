// Envelope encryption helpers. Each call produces a self-contained BYTEA
// blob carrying everything needed to decrypt: version, KEK id, wrapped DEK,
// IV, auth tag, and ciphertext. Stored in `*_enc` shadow columns alongside
// the plaintext columns during Phase 1 (read/write paths still use plaintext).
//
// Blob format v1:
//   u8  version          (=1)
//   u8  kek_id_len
//   .   kek_id_bytes     (utf8)
//   u16 wrapped_dek_len  (big-endian)
//   .   wrapped_dek_bytes
//   12B data_iv
//   16B data_tag
//   .   ciphertext
//
// AAD for the data layer binds the ciphertext to a logical context string
// like `tickets.description:42`, preventing a blob from being copied between
// rows or columns and still authenticating.

const crypto = require('crypto');
const kms = require('./kms');

const VERSION = 1;
const DATA_ALGO = 'aes-256-gcm';
const DATA_IV_LEN = 12;
const DATA_TAG_LEN = 16;

async function encrypt(plaintext, ctx, opts = {}) {
  if (plaintext == null) return null;
  const buf = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  const provider = kms.getProvider(opts.kmsProvider);
  const kekId = opts.kekId || provider.activeKekId;

  const dek = kms.generateDek();
  const wrapped = await provider.wrap(dek, kekId);

  const iv = crypto.randomBytes(DATA_IV_LEN);
  const cipher = crypto.createCipheriv(DATA_ALGO, dek, iv);
  cipher.setAAD(Buffer.from(ctx, 'utf8'));
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Best-effort wipe of the in-memory DEK. Node Buffers are not guaranteed
  // to be zeroed, but this discourages reuse.
  dek.fill(0);

  const kekIdBytes = Buffer.from(kekId, 'utf8');
  if (kekIdBytes.length > 255) throw new Error('kek_id too long');
  if (wrapped.length > 0xffff) throw new Error('wrapped DEK too long');

  return Buffer.concat([
    Buffer.from([VERSION]),
    Buffer.from([kekIdBytes.length]), kekIdBytes,
    Buffer.from([(wrapped.length >> 8) & 0xff, wrapped.length & 0xff]), wrapped,
    iv, tag, ct,
  ]);
}

async function decrypt(blob, ctx, opts = {}) {
  if (blob == null) return null;
  if (!Buffer.isBuffer(blob)) throw new Error('decrypt: blob must be Buffer');
  let off = 0;
  const version = blob[off++];
  if (version !== VERSION) throw new Error(`Unsupported crypto blob version: ${version}`);
  const kekIdLen = blob[off++];
  const kekId = blob.subarray(off, off + kekIdLen).toString('utf8'); off += kekIdLen;
  const wrappedLen = (blob[off++] << 8) | blob[off++];
  const wrapped = blob.subarray(off, off + wrappedLen); off += wrappedLen;
  const iv = blob.subarray(off, off + DATA_IV_LEN); off += DATA_IV_LEN;
  const tag = blob.subarray(off, off + DATA_TAG_LEN); off += DATA_TAG_LEN;
  const ct = blob.subarray(off);

  const provider = kms.getProvider(opts.kmsProvider);
  const dek = await provider.unwrap(wrapped, kekId);
  try {
    const decipher = crypto.createDecipheriv(DATA_ALGO, dek, iv);
    decipher.setAAD(Buffer.from(ctx, 'utf8'));
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return opts.raw ? pt : pt.toString('utf8');
  } finally {
    dek.fill(0);
  }
}

// Read the active encryption mode without holding a long-lived cache;
// settings flip rarely and the row is one lookup.
async function getMode(client) {
  const r = await client.query('SELECT mode FROM encryption_settings WHERE id = 1');
  return r.rows[0]?.mode || 'off';
}

module.exports = { encrypt, decrypt, getMode };

// Blind index: server-side word-level HMAC index over encrypted text fields,
// so equality / prefix-of-token search keeps working when the underlying
// columns are ciphertext.
//
// Trade-offs:
// - Index leaks token *presence* and approximate token *count* per row to
//   anyone with DB read. Acceptable for "Standard" mode (server already
//   holds the KEK). Vault mode should disable this index or HMAC under a
//   key the server cannot access.
// - Tokens shorter than MIN_TOKEN_LEN are skipped to limit dictionary leak.
// - Token hashes are truncated to 12 bytes hex (24 chars). Collision risk
//   is negligible for an index used as a candidate filter (we still
//   post-filter the decrypted plaintext for the actual match).

const crypto = require('crypto');

const MIN_TOKEN_LEN = 3;
const HASH_BYTES = 12;
const HKDF_INFO = Buffer.from('resolvd:blind-index:v1', 'utf8');

let cachedKey = null;

function getBlindKey() {
  if (cachedKey) return cachedKey;
  const raw = process.env.RESOLVD_MASTER_KEY;
  if (!raw) throw new Error('RESOLVD_MASTER_KEY not set');
  const ikm = Buffer.from(raw, 'base64');
  const salt = Buffer.alloc(32, 0);
  cachedKey = crypto.hkdfSync('sha256', ikm, salt, HKDF_INFO, 32);
  // hkdfSync returns ArrayBuffer in some Node versions; coerce.
  cachedKey = Buffer.from(cachedKey);
  return cachedKey;
}

function tokenize(text) {
  if (text == null) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(t => t.length >= MIN_TOKEN_LEN);
}

function hashToken(token) {
  const h = crypto.createHmac('sha256', getBlindKey());
  h.update(token, 'utf8');
  return h.digest('hex').slice(0, HASH_BYTES * 2);
}

function buildIndex(text) {
  const tokens = tokenize(text);
  if (tokens.length === 0) return [];
  // De-duplicate so rows with repeated words don't carry redundant entries.
  return [...new Set(tokens.map(hashToken))];
}

function hashQuery(query) {
  return tokenize(query).map(hashToken);
}

module.exports = { buildIndex, hashQuery, tokenize, MIN_TOKEN_LEN };

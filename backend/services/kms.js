// KMS abstraction. Wraps and unwraps per-row data encryption keys (DEKs).
// Phase 1: local provider only. AWS KMS / Vault adapters drop in later
// behind the same wrap/unwrap interface.
//
// Wire format produced by wrap() / consumed by unwrap():
//   [1 byte iv_len][iv][1 byte tag_len][tag][ciphertext]
//
// AAD binds the wrapped DEK to the KEK id so a blob carrying the wrong
// kek_id cannot be authenticated.

const crypto = require('crypto');

const WRAP_ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

function loadLocalMasterKey() {
  const raw = process.env.RESOLVD_MASTER_KEY;
  if (!raw) {
    throw new Error(
      'RESOLVD_MASTER_KEY not set. Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    );
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== KEY_LEN) {
    throw new Error(`RESOLVD_MASTER_KEY must decode to ${KEY_LEN} bytes (got ${buf.length})`);
  }
  return buf;
}

// Non-throwing check: returns true when RESOLVD_MASTER_KEY is set and
// decodes to a valid 32-byte key. Used by feature gates (e.g., AI Assist)
// that must stay disabled until the operator has provisioned the key.
function isAvailable() {
  const raw = process.env.RESOLVD_MASTER_KEY;
  if (!raw) return false;
  try {
    return Buffer.from(raw, 'base64').length === KEY_LEN;
  } catch {
    return false;
  }
}

// Generate a fresh master key suitable for RESOLVD_MASTER_KEY (base64 of
// 32 random bytes). Pure helper — does not persist or activate the key.
function generateMasterKeyBase64() {
  return crypto.randomBytes(KEY_LEN).toString('base64');
}

const localProvider = {
  id: 'local',
  // Stable identifier for the active KEK. Local provider supports
  // exactly one KEK per process; rotation will introduce v2/v3.
  activeKekId: 'local:v1',

  async wrap(dek, kekId) {
    if (!Buffer.isBuffer(dek) || dek.length !== KEY_LEN) {
      throw new Error('wrap: dek must be a 32-byte Buffer');
    }
    const key = loadLocalMasterKey();
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(WRAP_ALGO, key, iv);
    cipher.setAAD(Buffer.from(kekId, 'utf8'));
    const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([
      Buffer.from([iv.length]), iv,
      Buffer.from([tag.length]), tag,
      ct,
    ]);
  },

  async unwrap(wrapped, kekId) {
    if (!Buffer.isBuffer(wrapped)) throw new Error('unwrap: wrapped must be Buffer');
    let off = 0;
    const ivLen = wrapped[off++]; const iv = wrapped.subarray(off, off + ivLen); off += ivLen;
    const tagLen = wrapped[off++]; const tag = wrapped.subarray(off, off + tagLen); off += tagLen;
    const ct = wrapped.subarray(off);
    const key = loadLocalMasterKey();
    const decipher = crypto.createDecipheriv(WRAP_ALGO, key, iv);
    decipher.setAAD(Buffer.from(kekId, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  },
};

const providers = { local: localProvider };

function getProvider(name) {
  const p = providers[name || 'local'];
  if (!p) throw new Error(`Unknown KMS provider: ${name}`);
  return p;
}

function generateDek() {
  return crypto.randomBytes(KEY_LEN);
}

module.exports = { getProvider, generateDek, KEY_LEN, isAvailable, generateMasterKeyBase64 };

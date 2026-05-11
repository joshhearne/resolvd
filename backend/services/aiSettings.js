// AI Settings — singleton service for org-level AI config.
//
// Resolves the rewrite config in a layered fashion:
//   1. Org settings disabled        → reject 403
//   2. Org locked                   → use org config (ignore user)
//   3. Org has config + user empty  → use org config (default)
//   4. allow_user_byok + user has   → use user config (BYOK)
//   5. Otherwise                    → use org config
//
// The encryption envelope wrapper for org_api_key_enc shares the
// `users.ai_api_key` ctx — both are user-scoped secrets.

const { pool } = require('../db/pool');
const { encrypt, decrypt } = require('./crypto');
const kms = require('./kms');

const DEFAULTS = Object.freeze({
  enabled: true,
  org_provider: null,
  org_endpoint: null,
  org_model: null,
  org_locked: false,
  allow_user_byok: true,
  project_context_enabled: true,
  disclosure_audience: 'self_and_admin',
  has_org_key: false,
  kms_available: false,
});

let _cache = null;
let _cacheAt = 0;

function invalidateCache() {
  _cache = null;
  _cacheAt = 0;
}

// Loads the singleton row + decrypts org key. Cached for 30s — admin
// changes invalidate via the patch handler.
async function getSettings({ withKey = false } = {}) {
  const now = Date.now();
  if (_cache && now - _cacheAt < 30 * 1000) {
    return withKey ? { ..._cache, _orgApiKey: _cache._orgApiKey ?? null } : { ..._cache, _orgApiKey: null };
  }
  const kmsAvailable = kms.isAvailable();
  const r = await pool.query(`SELECT * FROM ai_settings WHERE id = 1`);
  const row = r.rows[0] || {};
  let orgKey = null;
  if (kmsAvailable && row.org_api_key_enc) {
    try {
      orgKey = (await decrypt(row.org_api_key_enc, 'ai_settings.org_api_key')).toString('utf8');
    } catch (err) {
      console.error('aiSettings: org key decrypt failed:', err.message);
    }
  }
  // Master switch: without RESOLVD_MASTER_KEY the AI feature stays
  // disabled regardless of the stored row — API keys cannot be encrypted
  // or decrypted, so every rewrite would fail.
  const adminEnabled = row.enabled !== false;
  const out = {
    enabled: kmsAvailable && adminEnabled,
    admin_enabled: adminEnabled,
    org_provider: row.org_provider || null,
    org_endpoint: row.org_endpoint || null,
    org_model: row.org_model || null,
    org_locked: row.org_locked === true,
    allow_user_byok: row.allow_user_byok !== false,
    project_context_enabled: row.project_context_enabled !== false,
    disclosure_audience: row.disclosure_audience || 'self_and_admin',
    has_org_key: !!row.org_api_key_enc,
    kms_available: kmsAvailable,
    _orgApiKey: orgKey,
  };
  _cache = out;
  _cacheAt = now;
  return withKey ? out : { ...out, _orgApiKey: null };
}

async function patchSettings(partial) {
  const allowed = [
    'enabled', 'org_provider', 'org_endpoint', 'org_model',
    'org_locked', 'allow_user_byok', 'project_context_enabled',
    'disclosure_audience',
  ];
  const updates = {};
  for (const k of allowed) {
    if (partial[k] === undefined) continue;
    updates[k] = partial[k];
  }
  // Validate enums + types
  if (updates.disclosure_audience !== undefined &&
      !['self_and_admin', 'admin_only', 'all_users'].includes(updates.disclosure_audience)) {
    throw httpError(400, 'invalid disclosure_audience');
  }
  for (const k of ['enabled', 'org_locked', 'allow_user_byok', 'project_context_enabled']) {
    if (updates[k] !== undefined) updates[k] = !!updates[k];
  }
  for (const k of ['org_provider', 'org_endpoint', 'org_model']) {
    if (updates[k] !== undefined) {
      const v = updates[k];
      updates[k] = v ? String(v).trim() || null : null;
    }
  }
  // Ensure singleton row exists
  await pool.query(`INSERT INTO ai_settings (id) VALUES (1) ON CONFLICT DO NOTHING`);
  if (Object.keys(updates).length === 0) return getSettings();
  const cols = Object.keys(updates);
  const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
  await pool.query(
    `UPDATE ai_settings SET ${sets}, updated_at = NOW() WHERE id = 1`,
    cols.map(c => updates[c])
  );
  invalidateCache();
  return getSettings();
}

async function setOrgApiKey(plaintext) {
  await pool.query(`INSERT INTO ai_settings (id) VALUES (1) ON CONFLICT DO NOTHING`);
  if (plaintext == null || plaintext === '') {
    await pool.query(`UPDATE ai_settings SET org_api_key_enc = NULL, updated_at = NOW() WHERE id = 1`);
    invalidateCache();
    return;
  }
  if (!kms.isAvailable()) {
    throw httpError(400, 'RESOLVD_MASTER_KEY not configured — generate one in Admin → AI Assist → Integration, add it to .env, and restart the backend before saving an API key.');
  }
  const enc = await encrypt(Buffer.from(String(plaintext), 'utf8'), 'ai_settings.org_api_key');
  await pool.query(`UPDATE ai_settings SET org_api_key_enc = $1, updated_at = NOW() WHERE id = 1`, [enc]);
  invalidateCache();
}

// Resolve which config (org vs user) the rewrite should use. Pass the
// already-loaded user config; this returns the effective set + a flag
// indicating which source produced it (so audit + logging knows).
function resolveEffectiveConfig({ orgSettings, userCfg }) {
  if (!orgSettings.kms_available) {
    return { allowed: false, reason: 'kms_unavailable' };
  }
  if (!orgSettings.enabled) {
    return { allowed: false, reason: 'org_disabled' };
  }

  const userHasConfig = !!(userCfg && userCfg.provider && userCfg.api_key);
  const orgHasConfig = !!(orgSettings.org_provider && orgSettings._orgApiKey);

  // Locked → must use org. If org has no config, refuse.
  if (orgSettings.org_locked) {
    if (!orgHasConfig) return { allowed: false, reason: 'org_locked_unconfigured' };
    return {
      allowed: true,
      source: 'org',
      provider: orgSettings.org_provider,
      endpoint: orgSettings.org_endpoint,
      model: orgSettings.org_model,
      api_key: orgSettings._orgApiKey,
    };
  }

  // BYOK allowed + user has personal config → use it.
  if (orgSettings.allow_user_byok && userHasConfig) {
    return {
      allowed: true,
      source: 'user',
      provider: userCfg.provider,
      endpoint: userCfg.endpoint,
      model: userCfg.model,
      api_key: userCfg.api_key,
    };
  }

  // Fall back to org config when present.
  if (orgHasConfig) {
    return {
      allowed: true,
      source: 'org',
      provider: orgSettings.org_provider,
      endpoint: orgSettings.org_endpoint,
      model: orgSettings.org_model,
      api_key: orgSettings._orgApiKey,
    };
  }

  return { allowed: false, reason: userHasConfig ? 'byok_disabled' : 'unconfigured' };
}

function httpError(status, msg) {
  const e = new Error(msg);
  e.httpStatus = status;
  return e;
}

module.exports = {
  DEFAULTS,
  getSettings,
  patchSettings,
  setOrgApiKey,
  resolveEffectiveConfig,
  invalidateCache,
};

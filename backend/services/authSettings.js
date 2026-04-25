const { pool } = require('../db/pool');

let _cache = null;
let _cacheAt = 0;
const TTL_MS = 30 * 1000;

async function getAuthSettings() {
  if (_cache && Date.now() - _cacheAt < TTL_MS) return _cache;
  const result = await pool.query('SELECT * FROM auth_settings WHERE id = 1');
  _cache = result.rows[0] || null;
  _cacheAt = Date.now();
  return _cache;
}

function invalidateAuthSettings() {
  _cache = null;
  _cacheAt = 0;
}

async function updateAuthSettings(patch) {
  const allowed = [
    'entra_enabled', 'entra_allow_personal',
    'google_enabled', 'google_workspace_domain', 'google_allow_consumer',
    'local_enabled', 'mfa_required_roles',
    'email_backend', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_password',
    'smtp_secure', 'smtp_from', 'google_mail_from', 'invite_ttl_hours',
  ];
  const sets = [];
  const vals = [];
  let i = 1;
  for (const k of allowed) {
    if (k in patch) {
      sets.push(`${k} = $${i++}`);
      vals.push(patch[k]);
    }
  }
  if (!sets.length) return getAuthSettings();
  sets.push(`updated_at = NOW()`);
  await pool.query(`UPDATE auth_settings SET ${sets.join(', ')} WHERE id = 1`, vals);
  invalidateAuthSettings();
  return getAuthSettings();
}

module.exports = { getAuthSettings, updateAuthSettings, invalidateAuthSettings };

const { pool } = require('../db/pool');
const { getAuthSettings } = require('../services/authSettings');

async function isBootstrap() {
  const r = await pool.query('SELECT COUNT(*) as cnt FROM users');
  return parseInt(r.rows[0].cnt, 10) === 0;
}

// Look up user by provider-specific id, then by email. Used to link SSO logins
// to invited rows that were created with email only.
async function findUser({ providerKey, providerValue, email }) {
  if (providerKey && providerValue) {
    const r = await pool.query(`SELECT * FROM users WHERE ${providerKey} = $1`, [providerValue]);
    if (r.rows[0]) return r.rows[0];
  }
  if (email) {
    const r = await pool.query(`SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`, [email]);
    if (r.rows[0]) return r.rows[0];
  }
  return null;
}

async function upsertProviderUser({ provider, providerKey, providerValue, email, displayName, upn }) {
  const existing = await findUser({ providerKey, providerValue, email });

  if (existing) {
    if (existing.status === 'disabled') {
      const err = new Error('Account is disabled');
      err.code = 'ACCOUNT_DISABLED';
      throw err;
    }
    const sets = [];
    const vals = [];
    let i = 1;
    sets.push(`display_name = $${i++}`); vals.push(displayName || existing.display_name || '');
    sets.push(`email = $${i++}`); vals.push(email || existing.email || '');
    sets.push(`upn = $${i++}`); vals.push(upn || existing.upn || '');
    sets.push(`last_login = NOW()`);
    sets.push(`last_login_provider = $${i++}`); vals.push(provider);
    sets.push(`status = CASE WHEN status = 'invited' THEN 'active' ELSE status END`);
    if (providerKey && !existing[providerKey]) {
      sets.push(`${providerKey} = $${i++}`); vals.push(providerValue);
    }
    // Set auth_provider only if user has no provider yet (e.g. invited row)
    if (!existing.auth_provider || existing.status === 'invited') {
      sets.push(`auth_provider = $${i++}`); vals.push(provider);
    }
    vals.push(existing.id);
    const r = await pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      vals
    );
    return r.rows[0];
  }

  const isFirstUser = await isBootstrap();
  const role = isFirstUser ? 'Admin' : 'Viewer';
  const cols = ['display_name', 'email', 'upn', 'role', 'auth_provider', 'status', 'last_login', 'last_login_provider'];
  const vals = [displayName || '', email || '', upn || '', role, provider, 'active', provider];
  // last_login uses NOW() (not a placeholder)
  let placeholders = ['$1', '$2', '$3', '$4', '$5', '$6', 'NOW()', '$7'];
  if (providerKey) {
    cols.push(providerKey);
    vals.push(providerValue);
    placeholders.push(`$${vals.length}`);
  }
  const r = await pool.query(
    `INSERT INTO users (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
    vals
  );
  return r.rows[0];
}

function buildSessionUser(user) {
  return {
    id: user.id,
    entraOid: user.entra_oid || null,
    googleSub: user.google_sub || null,
    displayName: user.display_name,
    email: user.email,
    upn: user.upn,
    role: user.role,
    authProvider: user.auth_provider,
    mfaEnabled: !!user.mfa_enabled,
    status: user.status,
    defaultProjectId: user.default_project_id || null,
    profilePictureUrl: user.profile_picture_filename ? `/api/users/${user.id}/avatar` : null,
  };
}

async function mfaRequired(user) {
  if (user.mfa_enabled) return true;
  const settings = await getAuthSettings();
  const required = (settings?.mfa_required_roles || '').split(',').map(s => s.trim()).filter(Boolean);
  return required.includes(user.role);
}

function loginUser(req, user, { pendingMfa = false } = {}) {
  return new Promise((resolve, reject) => {
    if (pendingMfa) {
      req.session.pendingMfaUserId = user.id;
      req.session.user = null;
    } else {
      req.session.user = buildSessionUser(user);
      req.session.pendingMfaUserId = null;
    }
    req.session.save(err => err ? reject(err) : resolve());
  });
}

module.exports = { upsertProviderUser, findUser, buildSessionUser, mfaRequired, loginUser, isBootstrap };

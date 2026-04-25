const argon2 = require('argon2');
const { pool } = require('../../db/pool');
const { getAuthSettings } = require('../../services/authSettings');

const MAX_FAILED = 8;
const LOCK_MINUTES = 15;

async function isEnabled() {
  const s = await getAuthSettings();
  return !!s?.local_enabled;
}

async function hashPassword(plain) {
  return argon2.hash(plain, { type: argon2.argon2id });
}

async function verifyPassword(hash, plain) {
  if (!hash) return false;
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

function validatePassword(plain) {
  if (typeof plain !== 'string') return 'Password required';
  if (plain.length < 12) return 'Password must be at least 12 characters';
  if (!/[a-z]/.test(plain) || !/[A-Z]/.test(plain) || !/[0-9]/.test(plain)) {
    return 'Password must include uppercase, lowercase, and a digit';
  }
  return null;
}

async function authenticate({ email, password }) {
  if (!email || !password) {
    const err = new Error('Email and password required');
    err.code = 'INVALID_CREDENTIALS';
    throw err;
  }
  const r = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]);
  const user = r.rows[0];

  // Always run a hash to avoid user-enumeration timing leak
  if (!user) {
    await argon2.hash('dummy-password-for-timing', { type: argon2.argon2id }).catch(() => {});
    const err = new Error('Invalid credentials');
    err.code = 'INVALID_CREDENTIALS';
    throw err;
  }

  if (user.status === 'disabled') {
    const err = new Error('Account is disabled');
    err.code = 'ACCOUNT_DISABLED';
    throw err;
  }
  if (user.status === 'invited') {
    const err = new Error('Account invite has not been accepted yet');
    err.code = 'ACCOUNT_INVITED';
    throw err;
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const err = new Error('Account temporarily locked due to failed login attempts');
    err.code = 'ACCOUNT_LOCKED';
    throw err;
  }
  if (user.auth_provider !== 'local' || !user.password_hash) {
    const err = new Error(`This account uses ${user.auth_provider} sign-in`);
    err.code = 'WRONG_PROVIDER';
    err.provider = user.auth_provider;
    throw err;
  }

  const ok = await verifyPassword(user.password_hash, password);
  if (!ok) {
    const newCount = (user.failed_login_count || 0) + 1;
    const lockUntil = newCount >= MAX_FAILED
      ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000)
      : null;
    await pool.query(
      'UPDATE users SET failed_login_count = $1, locked_until = $2 WHERE id = $3',
      [newCount, lockUntil, user.id]
    );
    const err = new Error('Invalid credentials');
    err.code = 'INVALID_CREDENTIALS';
    throw err;
  }

  await pool.query(
    `UPDATE users SET failed_login_count = 0, locked_until = NULL,
       last_login = NOW(), last_login_provider = 'local' WHERE id = $1`,
    [user.id]
  );
  return user;
}

module.exports = { isEnabled, hashPassword, verifyPassword, validatePassword, authenticate };

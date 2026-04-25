const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const crypto = require('crypto');
const argon2 = require('argon2');
const { pool } = require('../db/pool');

authenticator.options = { window: 1 };

function generateSecret() {
  return authenticator.generateSecret();
}

async function buildOtpAuth({ secret, accountName, issuer }) {
  const otpauth = authenticator.keyuri(accountName, issuer || 'IssueTracker', secret);
  const qrDataUrl = await QRCode.toDataURL(otpauth);
  return { otpauth, qrDataUrl };
}

function verifyToken(secret, token) {
  if (!secret || !token) return false;
  return authenticator.verify({ token: String(token).replace(/\s+/g, ''), secret });
}

async function generateRecoveryCodes(userId, count = 10) {
  // Replace any existing recovery codes
  await pool.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
  const plainCodes = [];
  for (let i = 0; i < count; i++) {
    const code = crypto.randomBytes(5).toString('hex'); // 10-char hex
    plainCodes.push(code);
    const hash = await argon2.hash(code, { type: argon2.argon2id });
    await pool.query('INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)', [userId, hash]);
  }
  return plainCodes;
}

async function consumeRecoveryCode(userId, code) {
  if (!code) return false;
  const r = await pool.query(
    'SELECT id, code_hash FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL',
    [userId]
  );
  for (const row of r.rows) {
    if (await argon2.verify(row.code_hash, code).catch(() => false)) {
      await pool.query('UPDATE mfa_recovery_codes SET used_at = NOW() WHERE id = $1', [row.id]);
      return true;
    }
  }
  return false;
}

module.exports = {
  generateSecret,
  buildOtpAuth,
  verifyToken,
  generateRecoveryCodes,
  consumeRecoveryCode,
};

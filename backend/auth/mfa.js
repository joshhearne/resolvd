const otplib = require('otplib');
const QRCode = require('qrcode');
const crypto = require('crypto');
const argon2 = require('argon2');
const { pool } = require('../db/pool');

// Accept the previous/next 30s step to absorb clock drift.
const EPOCH_TOLERANCE_SECONDS = 30;
// otplib v12 issued 10-byte secrets; v13 rejects anything under 16 bytes by
// default. Relax the floor so existing enrollments keep verifying. New
// secrets still use v13's 20-byte default.
const GUARDRAILS = otplib.createGuardrails({ MIN_SECRET_BYTES: 10 });

function generateSecret() {
  return otplib.generateSecret();
}

async function buildOtpAuth({ secret, accountName, issuer }) {
  const otpauth = otplib.generateURI({ issuer: issuer || 'IssueTracker', label: accountName, secret });
  const qrDataUrl = await QRCode.toDataURL(otpauth);
  return { otpauth, qrDataUrl };
}

function verifyToken(secret, token) {
  if (!secret || !token) return false;
  try {
    return otplib.verifySync({
      token: String(token).replace(/\s+/g, ''),
      secret,
      epochTolerance: EPOCH_TOLERANCE_SECONDS,
      guardrails: GUARDRAILS,
    }).valid;
  } catch {
    // v13 throws on malformed tokens/secrets; treat as a failed check.
    return false;
  }
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

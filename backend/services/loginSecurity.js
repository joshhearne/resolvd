// Login security helpers: attempt audit + IP-based blocking + bot
// detection signals (honeypot + form dwell time).
//
// The express-rate-limit on /auth/local/login covers the noisy ceiling
// (20 attempts / 15 min from one IP). This module layers per-email
// lockout (already in auth/providers/local.js) plus persistent IP
// blocklisting based on the attempt log: an IP with 20+ failures in
// the last 24h gets refused with 429 regardless of rate-limit window
// reset. Stops slow-rotating credential-stuffing across the rate-limit
// window without auto-unblocking just because the window expired.

const { pool } = require('../db/pool');

// Thresholds — tune in env if needed
const IP_BLOCK_FAILURES = 20;          // 20 fails in 24h → block
const IP_BLOCK_WINDOW_MS = 24 * 60 * 60 * 1000;
const IP_BLOCK_TTL_MS   = 60 * 60 * 1000;  // refuse for 1h after threshold
const MIN_FORM_DWELL_MS = 800;             // sub-800ms submit is bot-suspicious
const MAX_AGE_FORM_DWELL_MS = 60 * 60 * 1000; // discard absurdly old timers

// Pull client IP honoring proxy hops (Express trust proxy enabled at top
// of server.js). Falls back to socket address.
function getClientIp(req) {
  return (
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.ip ||
    req.connection?.remoteAddress ||
    null
  );
}

function getUserAgent(req) {
  const ua = req.headers['user-agent'] || '';
  return ua.slice(0, 500);
}

// Returns true when the request looks like a bot (honeypot filled, or
// submitted faster than a human could read the form). Either flag is
// enough to refuse without recording a normal login_attempt row — but
// we DO log it (with the appropriate flag) so admins see the pattern.
function botSignals(body) {
  const honeypot = String(body?.website || body?.url_field || body?.hp || '').trim();
  let dwell = Number(body?.form_dwell_ms);
  if (!Number.isFinite(dwell) || dwell < 0 || dwell > MAX_AGE_FORM_DWELL_MS) {
    dwell = null;
  }
  const isBot =
    honeypot.length > 0 ||
    (dwell !== null && dwell < MIN_FORM_DWELL_MS);
  return { isBot, honeypot, dwell };
}

async function recordAttempt({ email, ip, userAgent, success, reason, honeypotFilled = false, formDwellMs = null }) {
  try {
    await pool.query(
      `INSERT INTO login_attempts
         (email_attempted, ip, user_agent, success, reason, honeypot_filled, form_dwell_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [email ? String(email).toLowerCase().slice(0, 320) : null,
       ip || null, userAgent || null, !!success, reason || null,
       !!honeypotFilled, formDwellMs]
    );
  } catch (err) {
    console.error('loginSecurity.recordAttempt failed:', err.message);
  }
}

// Returns { blocked: bool, reason?, retry_after_seconds? }. Caller can
// short-circuit with 429 before invoking authenticate().
async function checkIpBlocked(ip) {
  if (!ip) return { blocked: false };
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS fails, MAX(attempted_at) AS last
         FROM login_attempts
        WHERE ip = $1
          AND success = FALSE
          AND attempted_at > NOW() - ($2 || ' ms')::interval`,
      [ip, IP_BLOCK_WINDOW_MS]
    );
    const fails = r.rows[0]?.fails || 0;
    if (fails < IP_BLOCK_FAILURES) return { blocked: false, fails };
    // Threshold crossed — has the cooldown TTL since the most recent
    // failure expired?
    const last = r.rows[0]?.last ? new Date(r.rows[0].last).getTime() : 0;
    const elapsed = Date.now() - last;
    if (elapsed > IP_BLOCK_TTL_MS) return { blocked: false, fails };
    return {
      blocked: true,
      reason: 'too_many_ip_failures',
      retry_after_seconds: Math.max(1, Math.ceil((IP_BLOCK_TTL_MS - elapsed) / 1000)),
      fails,
    };
  } catch (err) {
    console.error('loginSecurity.checkIpBlocked failed:', err.message);
    return { blocked: false };
  }
}

// Admin-facing summary: recent attempts grouped by IP + email. Used
// for the future Admin → Security → Login attempts view.
async function recentAttempts({ limit = 100, sinceMinutes = 60 * 24 } = {}) {
  const r = await pool.query(
    `SELECT id, email_attempted, ip, user_agent, success, reason,
            honeypot_filled, form_dwell_ms, attempted_at
       FROM login_attempts
      WHERE attempted_at > NOW() - ($1 || ' minutes')::interval
      ORDER BY attempted_at DESC
      LIMIT $2`,
    [sinceMinutes, limit]
  );
  return r.rows;
}

module.exports = {
  getClientIp,
  getUserAgent,
  botSignals,
  recordAttempt,
  checkIpBlocked,
  recentAttempts,
  IP_BLOCK_FAILURES,
  IP_BLOCK_WINDOW_MS,
  IP_BLOCK_TTL_MS,
  MIN_FORM_DWELL_MS,
};

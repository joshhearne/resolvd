// Admin security endpoints. Exposes login_attempts forensics so the
// admin can see who's trying to brute-force without going to the DB.

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const loginSecurity = require('../services/loginSecurity');

const router = express.Router();

router.use(requireAuth, requireRole('Admin'));

// GET /api/security/login-attempts?since=1440&limit=200
router.get('/login-attempts', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const sinceMinutes = Math.min(Number(req.query.since) || (60 * 24), 60 * 24 * 30);
    const rows = await loginSecurity.recentAttempts({ limit, sinceMinutes });
    res.json({ attempts: rows, limit, since_minutes: sinceMinutes });
  } catch (err) {
    console.error('security login-attempts:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/security/login-attempts/summary?since=1440 — aggregate per IP + per email
router.get('/login-attempts/summary', async (req, res) => {
  const sinceMinutes = Math.min(Number(req.query.since) || (60 * 24), 60 * 24 * 30);
  try {
    const { pool } = require('../db/pool');
    const byIp = await pool.query(
      `SELECT ip, COUNT(*)::int AS attempts,
              SUM(CASE WHEN success THEN 1 ELSE 0 END)::int AS successes,
              SUM(CASE WHEN NOT success THEN 1 ELSE 0 END)::int AS failures,
              SUM(CASE WHEN honeypot_filled THEN 1 ELSE 0 END)::int AS honeypot_hits,
              MAX(attempted_at) AS last_seen
         FROM login_attempts
        WHERE attempted_at > NOW() - ($1 || ' minutes')::interval
          AND ip IS NOT NULL
        GROUP BY ip
        ORDER BY failures DESC, attempts DESC
        LIMIT 50`,
      [sinceMinutes]
    );
    const byEmail = await pool.query(
      `SELECT email_attempted AS email, COUNT(*)::int AS attempts,
              SUM(CASE WHEN success THEN 1 ELSE 0 END)::int AS successes,
              SUM(CASE WHEN NOT success THEN 1 ELSE 0 END)::int AS failures,
              MAX(attempted_at) AS last_seen
         FROM login_attempts
        WHERE attempted_at > NOW() - ($1 || ' minutes')::interval
          AND email_attempted IS NOT NULL
        GROUP BY email_attempted
        ORDER BY failures DESC, attempts DESC
        LIMIT 50`,
      [sinceMinutes]
    );
    res.json({ since_minutes: sinceMinutes, by_ip: byIp.rows, by_email: byEmail.rows });
  } catch (err) {
    console.error('security login-attempts summary:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

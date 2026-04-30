const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { pool } = require('../db/pool');
const { getPublicKey, isConfigured } = require('../services/pushNotifications');

const router = express.Router();

// GET /api/push/vapid-public-key — frontend needs this to call subscribe()
router.get('/vapid-public-key', (req, res) => {
  const key = getPublicKey();
  if (!key || !isConfigured()) return res.status(503).json({ error: 'Push not configured' });
  res.json({ key });
});

// POST /api/push/subscribe — body: { endpoint, keys: { p256dh, auth } }
// Upsert by endpoint so re-subscribing the same browser doesn't dupe.
router.post('/subscribe', requireAuth, async (req, res) => {
  try {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }
    const ua = req.get('user-agent') || null;
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (endpoint) DO UPDATE SET
           user_id = EXCLUDED.user_id,
           p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth,
           user_agent = EXCLUDED.user_agent`,
      [req.session.user.id, endpoint, keys.p256dh, keys.auth, ua]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('push subscribe error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/push/subscribe — body: { endpoint }
router.delete('/subscribe', requireAuth, async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
    await pool.query(
      `DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`,
      [req.session.user.id, endpoint]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('push unsubscribe error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

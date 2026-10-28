// Automatic updates. Admins pick a channel and an update hour here; the
// host updater (deploy/resolvd-update.sh, a systemd timer on the Docker
// host) polls the policy, does the update itself, and reports back. The
// app never touches Docker: the worst a compromised app can do through
// these endpoints is switch between the two official channels.
//
// Admin endpoints use the session. Host endpoints (/policy, /report)
// authenticate with RESOLVD_UPDATER_TOKEN, shared with the host via .env.

const crypto = require('crypto');
const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const CHANNELS = ['production', 'development', 'manual'];
const EVENT_STATUSES = ['updated', 'rolled_back', 'failed'];
const REPORT_STATUSES = ['up_to_date', 'waiting', 'manual', ...EVENT_STATUSES];

function tokenMatches(provided, expected) {
  const a = crypto.createHash('sha256').update(String(provided)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireUpdaterToken(req, res, next) {
  const expected = process.env.RESOLVD_UPDATER_TOKEN;
  if (!expected) {
    return res.status(503).json({ error: 'Updater not configured (RESOLVD_UPDATER_TOKEN unset)' });
  }
  const m = /^Bearer\s+(.+)$/.exec(req.get('Authorization') || '');
  if (!m || !tokenMatches(m[1], expected)) {
    return res.status(401).json({ error: 'Invalid updater token' });
  }
  next();
}

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

async function loadSettings() {
  const r = await pool.query('SELECT * FROM update_settings WHERE id = 1');
  return r.rows[0];
}

// GET /api/system-updates: policy, last host report, recent update history.
router.get('/', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const [settings, events] = await Promise.all([
      loadSettings(),
      pool.query('SELECT at, status, channel, from_version, to_version, message FROM update_events ORDER BY at DESC LIMIT 10'),
    ]);
    res.json({
      channel: settings.channel,
      update_hour: settings.update_hour,
      update_requested_at: settings.update_requested_at,
      host_last_seen_at: settings.host_last_seen_at,
      last_report: settings.last_report,
      updater_configured: !!process.env.RESOLVD_UPDATER_TOKEN,
      running: {
        version: process.env.APP_VERSION || 'dev',
        commit: process.env.APP_COMMIT || 'unknown',
        built_at: process.env.BUILT_AT || null,
      },
      events: events.rows,
    });
  } catch (err) {
    console.error('system-updates get error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PUT /api/system-updates { channel?, update_hour? }
router.put('/', requireAuth, requireRole('Admin'), async (req, res) => {
  const { channel, update_hour } = req.body;
  if (channel !== undefined && !CHANNELS.includes(channel)) {
    return res.status(400).json({ error: `channel must be one of ${CHANNELS.join(', ')}` });
  }
  if (update_hour !== undefined && !(Number.isInteger(update_hour) && update_hour >= 0 && update_hour <= 23)) {
    return res.status(400).json({ error: 'update_hour must be an integer 0-23' });
  }
  try {
    const r = await pool.query(
      `UPDATE update_settings
          SET channel = COALESCE($1, channel),
              update_hour = COALESCE($2, update_hour),
              -- A pending "update now" belongs to the channel it was asked on.
              update_requested_at = CASE WHEN $1 IS NOT NULL AND $1 <> channel THEN NULL ELSE update_requested_at END,
              updated_at = NOW()
        WHERE id = 1
        RETURNING channel, update_hour, update_requested_at`,
      [channel ?? null, update_hour ?? null],
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error('system-updates put error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/system-updates/update-now: the host picks this up on its next
// poll (every few minutes) instead of waiting for the update hour.
router.post('/update-now', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const settings = await loadSettings();
    if (settings.channel === 'manual') {
      return res.status(409).json({ error: 'Manual updates: run the update commands on the server instead.' });
    }
    const r = await pool.query(
      'UPDATE update_settings SET update_requested_at = NOW() WHERE id = 1 RETURNING update_requested_at',
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error('system-updates update-now error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/system-updates/policy (host). Plain key=value lines so the host
// script can read it without jq.
router.get('/policy', requireUpdaterToken, async (req, res) => {
  try {
    const s = await loadSettings();
    res.type('text/plain').send(
      `channel=${s.channel}\nupdate_hour=${s.update_hour}\nupdate_now=${s.update_requested_at ? 1 : 0}\n`,
    );
  } catch (err) {
    console.error('system-updates policy error:', err);
    res.status(500).type('text/plain').send('error=database\n');
  }
});

// POST /api/system-updates/report (host, form-encoded). Every run reports;
// updates, rollbacks and failures also land in update_events.
router.post('/report', requireUpdaterToken, async (req, res) => {
  const b = req.body;
  if (!REPORT_STATUSES.includes(b.status)) {
    return res.status(400).json({ error: `status must be one of ${REPORT_STATUSES.join(', ')}` });
  }
  const report = {
    status: b.status,
    message: clip(b.message, 2000),
    channel: clip(b.channel, 20),
    current_version: clip(b.current_version, 100),
    current_commit: clip(b.current_commit, 64),
    available_version: clip(b.available_version, 100),
    host_time: clip(b.host_time, 40),
    host_tz: clip(b.host_tz, 64),
  };
  try {
    await pool.query(
      `UPDATE update_settings
          SET last_report = $1, host_last_seen_at = NOW(),
              update_requested_at = CASE WHEN $2 THEN NULL ELSE update_requested_at END
        WHERE id = 1`,
      [report, b.handled_request === '1'],
    );
    if (EVENT_STATUSES.includes(b.status)) {
      await pool.query(
        `INSERT INTO update_events (status, channel, from_version, to_version, message)
         VALUES ($1, $2, $3, $4, $5)`,
        [b.status, report.channel, clip(b.previous_version, 100), clip(b.target_version, 100), report.message],
      );
      await pool.query(
        'DELETE FROM update_events WHERE id NOT IN (SELECT id FROM update_events ORDER BY at DESC LIMIT 100)',
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('system-updates report error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

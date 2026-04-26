const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getAuthSettings, updateAuthSettings } = require('../services/authSettings');
const { sendMail } = require('../services/email');

const router = express.Router();

const VALID_BACKENDS = ['graph', 'gmail', 'smtp'];
const VALID_ROLES = ['Admin', 'Manager', 'Submitter', 'Viewer'];

function sanitize(settings) {
  if (!settings) return null;
  // Never return raw smtp_password to the client; emit a flag instead
  const { smtp_password, ...rest } = settings;
  return { ...rest, smtp_password_set: !!smtp_password };
}

router.get('/', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const s = await getAuthSettings();
    res.json(sanitize(s));
  } catch (err) {
    console.error('auth settings get error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

router.patch('/', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const patch = {};
    const allowed = [
      'entra_enabled', 'entra_allow_personal',
      'google_enabled', 'google_workspace_domain', 'google_allow_consumer',
      'local_enabled', 'mfa_required_roles',
      'email_backend', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_password',
      'smtp_secure', 'smtp_from', 'google_mail_from', 'invite_ttl_hours',
      'email_blocklist',
      'muted_digest_enabled', 'muted_digest_local_hour',
      'muted_digest_local_minute', 'muted_digest_timezone',
    ];
    for (const k of allowed) {
      if (k in req.body) patch[k] = req.body[k];
    }
    if (patch.email_backend && !VALID_BACKENDS.includes(patch.email_backend)) {
      return res.status(400).json({ error: 'Invalid email_backend' });
    }
    if (patch.mfa_required_roles) {
      const parts = patch.mfa_required_roles.split(',').map(s => s.trim()).filter(Boolean);
      for (const p of parts) {
        if (!VALID_ROLES.includes(p)) return res.status(400).json({ error: `Invalid role: ${p}` });
      }
      patch.mfa_required_roles = parts.join(',');
    }
    if (patch.smtp_password === '') delete patch.smtp_password; // empty string = no change
    if (typeof patch.smtp_port === 'string') patch.smtp_port = parseInt(patch.smtp_port, 10);
    if (patch.muted_digest_local_hour !== undefined) {
      const h = parseInt(patch.muted_digest_local_hour, 10);
      if (!Number.isFinite(h) || h < 0 || h > 23) return res.status(400).json({ error: 'muted_digest_local_hour must be 0..23' });
      patch.muted_digest_local_hour = h;
    }
    if (patch.muted_digest_local_minute !== undefined) {
      const m = parseInt(patch.muted_digest_local_minute, 10);
      if (!Number.isFinite(m) || m < 0 || m > 59) return res.status(400).json({ error: 'muted_digest_local_minute must be 0..59' });
      patch.muted_digest_local_minute = m;
    }
    if (patch.muted_digest_timezone !== undefined) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: patch.muted_digest_timezone }); }
      catch { return res.status(400).json({ error: 'Invalid IANA timezone' }); }
    }
    const s = await updateAuthSettings(patch);
    res.json(sanitize(s));
  } catch (err) {
    console.error('auth settings patch error:', err);
    res.status(500).json({ error: 'Update failed' });
  }
});

// POST /api/auth-settings/muted-digest/run-now — admin manual trigger
router.post('/muted-digest/run-now', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const { runDigest } = require('../services/mutedDigest');
    const r = await runDigest();
    res.json({ ok: true, ...r });
  } catch (err) {
    console.error('muted digest run-now error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/test-email', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const { to } = req.body || {};
    if (!to) return res.status(400).json({ error: 'to required' });
    await sendMail({
      to,
      subject: 'Test email from issue tracker',
      html: '<p>If you received this, your mail backend is configured correctly.</p>',
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('test email error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

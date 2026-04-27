// Admin routes for managing OAuth-backed (and legacy SMTP) outbound
// email accounts. The OAuth start endpoint stores a CSRF state in the
// session; the callback validates and exchanges the code, then upserts
// an email_backend_accounts row.

const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { buildWritePatch } = require('../services/fields');
const eb = require('../services/emailBackends');
const { sendMailViaAccount } = require('../services/email');

const router = express.Router();

// GET /api/email-backends — admin list (no secrets exposed)
router.get('/', requireAuth, requireRole('Admin'), async (req, res) => {
  try { res.json(await eb.listAccounts()); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Database error' }); }
});

// POST /api/email-backends/oauth/start  body: { provider }
router.post('/oauth/start', requireAuth, requireRole('Admin'), async (req, res) => {
  const provider = req.body?.provider;
  if (!['graph_user', 'gmail_user'].includes(provider)) {
    return res.status(400).json({ error: 'provider must be graph_user or gmail_user' });
  }
  if (provider === 'graph_user' && !process.env.AZURE_CLIENT_ID) {
    return res.status(503).json({ error: 'AZURE_CLIENT_ID not configured' });
  }
  if (provider === 'gmail_user' && !process.env.GOOGLE_CLIENT_ID) {
    return res.status(503).json({ error: 'GOOGLE_CLIENT_ID not configured' });
  }
  const state = crypto.randomBytes(24).toString('hex');
  req.session.email_backend_oauth = { state, provider, userId: req.session.user.id };
  const url = provider === 'graph_user' ? eb.buildMsAuthUrl(state, req) : eb.buildGoogleAuthUrl(state, req);
  res.json({ authorize_url: url });
});

// GET /api/email-backends/oauth/callback?code=&state=
// Provider redirects the browser here; we exchange and redirect to the UI.
router.get('/oauth/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  const stash = req.session?.email_backend_oauth;
  function backToAdmin(qs) {
    const base = process.env.FRONTEND_URL || `${req.protocol}://${req.hostname}`;
    return res.redirect(`${base.replace(/\/$/, '')}/admin/email-backends?${qs}`);
  }
  if (error) return backToAdmin(`error=${encodeURIComponent(error_description || error)}`);
  if (!stash || !state || stash.state !== state) {
    return backToAdmin(`error=${encodeURIComponent('OAuth state mismatch — please retry')}`);
  }
  if (!code) return backToAdmin(`error=${encodeURIComponent('No authorization code returned')}`);

  try {
    const profile = stash.provider === 'graph_user'
      ? await eb.exchangeMsCode(code, req)
      : await eb.exchangeGoogleCode(code, req);
    const account = await eb.upsertOAuthAccount({
      provider: stash.provider,
      profile,
      createdByUserId: stash.userId,
    });
    delete req.session.email_backend_oauth;
    backToAdmin(`connected=${account.id}`);
  } catch (e) {
    console.error('email-backend OAuth callback failed:', e);
    backToAdmin(`error=${encodeURIComponent(e.message)}`);
  }
});

// POST /api/email-backends/smtp — manual SMTP credentials form
router.post('/smtp', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const { display_name, from_address, smtp_host, smtp_port, smtp_user, smtp_password, smtp_secure } = req.body || {};
    if (!from_address || !smtp_host) return res.status(400).json({ error: 'from_address and smtp_host required' });
    const sensitive = await buildWritePatch(pool, 'email_backend_accounts', {
      smtp_password: smtp_password || null,
    });
    const passthrough = {
      provider: 'smtp',
      display_name: display_name || from_address,
      from_address,
      smtp_host,
      smtp_port: smtp_port ? parseInt(smtp_port, 10) : 587,
      smtp_user: smtp_user || null,
      smtp_secure: smtp_secure !== false,
      updated_at: new Date(),
      created_by_user_id: req.session.user.id,
    };
    const cols = [...Object.keys(passthrough), ...sensitive.cols];
    const vals = [...Object.values(passthrough), ...sensitive.values];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const r = await pool.query(
      `INSERT INTO email_backend_accounts (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`,
      vals
    );
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/email-backends/:id/activate — single-active is enforced by the
// partial unique index in the schema, so this also clears any prior active.
router.post('/:id/activate', requireAuth, requireRole('Admin'), async (req, res) => {
  try { res.json(await eb.activateAccount(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/email-backends/:id/test — send a test email to the requester
router.post('/:id/test', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const to = req.body?.to || req.session.user.email;
    if (!to) return res.status(400).json({ error: 'to required (no email on session user)' });
    const r = await pool.query(`SELECT * FROM email_backend_accounts WHERE id = $1`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    try {
      await sendMailViaAccount(r.rows[0], {
        to,
        subject: 'Resolvd — email backend test',
        html: '<p>If you received this, the backend is configured correctly.</p>',
      }, req);
      await eb.recordTest(r.rows[0].id, true);
      res.json({ ok: true });
    } catch (sendErr) {
      await eb.recordTest(r.rows[0].id, false, sendErr.message);
      res.status(500).json({ error: sendErr.message });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/email-backends/:id/send-as-submitter  body: { enabled: bool }
// OAuth providers only — SMTP has no per-user delegation mechanism.
router.post('/:id/send-as-submitter', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const enabled = !!req.body?.enabled;
    const r = await pool.query(
      `UPDATE email_backend_accounts
          SET send_as_submitter = $1, updated_at = NOW()
        WHERE id = $2 AND provider IN ('graph_user','gmail_user')
        RETURNING id, provider, send_as_submitter`,
      [enabled, req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found, or SMTP accounts do not support send-as' });
    res.json({ ok: true, send_as_submitter: r.rows[0].send_as_submitter });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try { await eb.deleteAccount(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/email-backends/:id/monitor — toggle inbox monitoring
// Body: { enabled: true|false }. Creates the provider subscription on
// "true" and tears it down on "false".
router.post('/:id/monitor', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const enabled = !!req.body?.enabled;
    const r = await pool.query(`SELECT * FROM email_backend_accounts WHERE id = $1`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    const { decryptRow } = require('../services/fields');
    await decryptRow('email_backend_accounts', r.rows[0]);
    const account = r.rows[0];
    const graphInbox = require('../services/graphInbox');
    const gmailInbox = require('../services/gmailInbox');
    if (enabled) {
      if (account.provider === 'graph_user')      await graphInbox.createSubscription(account);
      else if (account.provider === 'gmail_user') await gmailInbox.createWatch(account);
      else return res.status(400).json({ error: 'Inbox monitoring is OAuth-only (graph_user / gmail_user).' });
    } else {
      if (account.provider === 'graph_user')      await graphInbox.deleteSubscription(account);
      else if (account.provider === 'gmail_user') await gmailInbox.stopWatch(account);
      else return res.status(400).json({ error: 'Inbox monitoring is OAuth-only.' });
    }
    res.json({ ok: true, enabled });
  } catch (e) {
    console.error('monitor toggle failed:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

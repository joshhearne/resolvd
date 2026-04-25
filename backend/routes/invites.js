const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getAuthSettings } = require('../services/authSettings');
const { sendInviteEmail } = require('../services/email');
const local = require('../auth/providers/local');
const { generateToken, hashToken } = require('../auth/tokens');
const { loginUser, buildSessionUser } = require('../auth/session');

const router = express.Router();

const VALID_ROLES = ['Admin', 'Submitter', 'Viewer'];
const VALID_PROVIDERS = ['local', 'entra', 'google'];

// POST /api/invites — admin invites a user
router.post('/', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const { email, role = 'Viewer', intended_provider = 'local', display_name = '' } = req.body || {};
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (!VALID_PROVIDERS.includes(intended_provider)) return res.status(400).json({ error: 'Invalid provider' });

    const settings = await getAuthSettings();
    const ttlHours = settings?.invite_ttl_hours || 168;

    // Pre-create the user row in 'invited' status so the email link can resolve it
    const existingUser = await pool.query('SELECT id, status FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    let userId;
    if (existingUser.rows[0]) {
      if (existingUser.rows[0].status === 'active') {
        return res.status(409).json({ error: 'User with that email already exists and is active' });
      }
      userId = existingUser.rows[0].id;
    } else {
      const ins = await pool.query(
        `INSERT INTO users (email, display_name, role, auth_provider, status, invited_by)
         VALUES ($1, $2, $3, $4, 'invited', $5) RETURNING id`,
        [email, display_name, role, intended_provider, req.session.user.id]
      );
      userId = ins.rows[0].id;
    }

    const token = generateToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO invite_tokens (token_hash, email, role, invited_by, intended_provider, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tokenHash, email, role, req.session.user.id, intended_provider, expiresAt]
    );

    const baseUrl = (process.env.FRONTEND_URL || `${req.protocol}://${req.hostname}`).replace(/\/$/, '');
    const inviteUrl = `${baseUrl}/accept-invite/${token}`;
    await sendInviteEmail({
      to: email,
      inviteUrl,
      invitedByName: req.session.user.displayName,
      role,
    });

    res.json({ ok: true, userId, expiresAt });
  } catch (err) {
    console.error('invite create error:', err);
    res.status(500).json({ error: 'Invite failed' });
  }
});

// GET /api/invites/:token — public, validates token without consuming
router.get('/:token', async (req, res) => {
  try {
    const tokenHash = hashToken(req.params.token);
    const r = await pool.query(
      `SELECT email, role, intended_provider, expires_at, accepted_at
       FROM invite_tokens WHERE token_hash = $1`,
      [tokenHash]
    );
    const row = r.rows[0];
    if (!row) return res.status(404).json({ error: 'Invalid invite' });
    if (row.accepted_at) return res.status(410).json({ error: 'Invite already used' });
    if (new Date(row.expires_at) < new Date()) return res.status(410).json({ error: 'Invite expired' });
    res.json({
      email: row.email,
      role: row.role,
      intended_provider: row.intended_provider,
    });
  } catch (err) {
    console.error('invite get error:', err);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// POST /api/invites/:token/accept — for local provider, sets password
router.post('/:token/accept', async (req, res) => {
  try {
    const { password, displayName } = req.body || {};
    const tokenHash = hashToken(req.params.token);
    const r = await pool.query(
      `SELECT * FROM invite_tokens WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > NOW()`,
      [tokenHash]
    );
    const invite = r.rows[0];
    if (!invite) return res.status(400).json({ error: 'Invalid or expired invite' });

    const userResult = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [invite.email]);
    let user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: 'Invited user record missing' });

    if (invite.intended_provider === 'local') {
      const validation = local.validatePassword(password);
      if (validation) return res.status(400).json({ error: validation });
      const hash = await local.hashPassword(password);
      await pool.query(
        `UPDATE users SET password_hash = $1, password_updated_at = NOW(),
           display_name = COALESCE(NULLIF($2, ''), display_name),
           status = 'active', auth_provider = 'local',
           last_login = NOW(), last_login_provider = 'local'
         WHERE id = $3`,
        [hash, displayName || '', user.id]
      );
    } else {
      // SSO invite: just mark active and direct user to the SSO entry point.
      // The session is established once they sign in via SSO and email matches.
      await pool.query(
        `UPDATE users SET status = 'active',
           display_name = COALESCE(NULLIF($1, ''), display_name)
         WHERE id = $2`,
        [displayName || '', user.id]
      );
    }

    await pool.query(
      `UPDATE invite_tokens SET accepted_at = NOW(), accepted_user_id = $1 WHERE id = $2`,
      [user.id, invite.id]
    );

    if (invite.intended_provider === 'local') {
      const refreshed = await pool.query('SELECT * FROM users WHERE id = $1', [user.id]);
      await loginUser(req, refreshed.rows[0]);
      return res.json({ ok: true, user: buildSessionUser(refreshed.rows[0]) });
    }
    // For SSO invites, instruct frontend to redirect to provider
    res.json({ ok: true, redirectProvider: invite.intended_provider });
  } catch (err) {
    console.error('invite accept error:', err);
    res.status(500).json({ error: 'Accept failed' });
  }
});

// DELETE /api/invites/:id — admin revokes an outstanding invite
router.delete('/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM invite_tokens WHERE id = $1 RETURNING email', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Invite not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('invite delete error:', err);
    res.status(500).json({ error: 'Delete failed' });
  }
});

// GET /api/invites — admin lists outstanding invites
router.get('/', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT i.id, i.email, i.role, i.intended_provider, i.expires_at, i.accepted_at, i.created_at,
              u.display_name AS invited_by_name
       FROM invite_tokens i
       LEFT JOIN users u ON u.id = i.invited_by
       WHERE i.accepted_at IS NULL
       ORDER BY i.created_at DESC`
    );
    res.json(r.rows);
  } catch (err) {
    console.error('invites list error:', err);
    res.status(500).json({ error: 'List failed' });
  }
});

module.exports = router;

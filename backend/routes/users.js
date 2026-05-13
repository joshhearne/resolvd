const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { buildSessionUser } = require('../auth/session');
const { avatarPath, saveAvatarFromBytes, clearAvatar } = require('../services/avatar');
const {
  DEFAULT_NOTIFICATION_PREFS,
  DEFAULT_EMAIL_DIGEST,
  EVENT_TYPES,
  CADENCES,
} = require('../services/notificationPrefs');

const router = express.Router();

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Avatar must be an image'));
    cb(null, true);
  },
});

// Tech sits between Manager and Submitter — internal IT staff who can
// handle tickets (assignment target, status changes, internal comments)
// without admin-level config access. Permission gates added per-route;
// the role string itself is opt-in by including 'Tech' in requireRole(...).
const VALID_ROLES = ['Admin', 'Manager', 'Tech', 'Submitter', 'Viewer', 'Support'];

// GET /api/users (Admin + Manager)
router.get('/', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, display_name, email, upn, role, created_at, last_login,
             auth_provider, status, mfa_enabled, last_login_provider
      FROM users ORDER BY display_name ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/users/:id/status (Admin only) — enable/disable account
router.patch('/:id/status', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!['active', 'disabled'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    if (Number(req.params.id) === req.session.user.id) {
      return res.status(400).json({ error: 'Cannot change your own status' });
    }
    await pool.query('UPDATE users SET status = $1 WHERE id = $2', [status, req.params.id]);
    res.json({ ok: true, status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/users/:id (Admin only) — remove invited or disabled user records
router.delete('/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    if (Number(req.params.id) === req.session.user.id) {
      return res.status(400).json({ error: 'Cannot delete yourself' });
    }
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/users/:id/role (Admin only)
router.patch('/:id/role', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const { role } = req.body;

    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}` });
    }

    if (role === 'Admin' && req.session.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Only Admins can assign the Admin role' });
    }

    if (Number(req.params.id) === req.session.user.id) {
      return res.status(400).json({ error: 'Cannot change your own role' });
    }

    const user = await pool.query('SELECT id FROM users WHERE id = $1', [req.params.id]);
    if (!user.rows[0]) return res.status(404).json({ error: 'User not found' });

    await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, req.params.id]);

    const updated = await pool.query(
      'SELECT id, display_name, email, upn, role, created_at, last_login FROM users WHERE id = $1',
      [req.params.id]
    );
    res.json(updated.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Defaults for the QoL preferences blob. Anything missing on read falls
// back to these — keeps the frontend simple and avoids null checks.
const PREF_DEFAULTS = Object.freeze({
  scope_follows_filter: true,
  ctrl_enter_to_post: true,
  auto_follow_on_comment: true,
  notification_prefs: DEFAULT_NOTIFICATION_PREFS,
  email_digest: DEFAULT_EMAIL_DIGEST,
  confirm_before_close: false,
  compact_mode: false,
  phonetic_readback: true,
  default_ticket_sort: 'updated_at_desc',
  // Locale overrides — empty string means "inherit org branding".
  date_style_override: '',
  time_style_override: '',
  timezone_override: '',
});

// GET /api/users/me/prefs — return merged defaults + stored values.
// `default_project_id` is a real column (not part of the JSON blob) but
// is surfaced here too so a single endpoint covers all per-user prefs.
router.get('/me/prefs', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT preferences, default_project_id FROM users WHERE id = $1',
      [req.session.user.id]
    );
    const stored = r.rows[0]?.preferences || {};
    const mergedMatrix = {
      ...DEFAULT_NOTIFICATION_PREFS,
      ...(stored.notification_prefs || {}),
    };
    res.json({
      ...PREF_DEFAULTS,
      ...stored,
      notification_prefs: mergedMatrix,
      default_project_id: r.rows[0]?.default_project_id ?? null,
    });
  } catch (err) {
    console.error('prefs get error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/users/me/prefs — shallow-merge a partial object into the
// stored preferences blob. Unknown keys are accepted and persisted as-is
// (settings inventory is intentionally additive — invalid values just
// get ignored by the consumer).
//
// `default_project_id` is peeled off and routed to the dedicated column;
// it never enters the JSON blob. `null` clears it; a value is validated
// against active projects.
router.patch('/me/prefs', requireAuth, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (Array.isArray(body)) return res.status(400).json({ error: 'Body must be an object' });
    const userId = req.session.user.id;

    const { default_project_id, ...patch } = body;

    if (Object.prototype.hasOwnProperty.call(body, 'default_project_id')) {
      if (default_project_id !== null && default_project_id !== undefined) {
        const proj = await pool.query(
          'SELECT id FROM projects WHERE id = $1 AND status = $2',
          [default_project_id, 'active']
        );
        if (!proj.rows[0]) return res.status(404).json({ error: 'Project not found' });
      }
      const val = default_project_id || null;
      await pool.query('UPDATE users SET default_project_id = $1 WHERE id = $2', [val, userId]);
      req.session.user.defaultProjectId = val;
      req.session.save(() => {});
    }

    // Narrow validation for the two structured fields. Other keys remain
    // additive — unknown values pass through unchanged (matches existing
    // pattern for QoL toggles).
    if (patch.email_digest !== undefined && !CADENCES.includes(patch.email_digest)) {
      return res.status(400).json({ error: 'Invalid email_digest' });
    }
    if (patch.notification_prefs !== undefined) {
      const np = patch.notification_prefs;
      if (!np || typeof np !== 'object' || Array.isArray(np)) {
        return res.status(400).json({ error: 'notification_prefs must be an object' });
      }
      const sanitized = {};
      for (const evt of EVENT_TYPES) {
        const row = np[evt];
        if (!row || typeof row !== 'object') continue;
        sanitized[evt] = {
          in_app: !!row.in_app,
          email: !!row.email,
          push: !!row.push,
        };
      }
      patch.notification_prefs = sanitized;
    }

    const r = await pool.query(
      `UPDATE users SET preferences = preferences || $1::jsonb
        WHERE id = $2 RETURNING preferences, default_project_id`,
      [JSON.stringify(patch), userId]
    );
    const stored = r.rows[0]?.preferences || {};
    const mergedMatrix = {
      ...DEFAULT_NOTIFICATION_PREFS,
      ...(stored.notification_prefs || {}),
    };
    res.json({
      ...PREF_DEFAULTS,
      ...stored,
      notification_prefs: mergedMatrix,
      default_project_id: r.rows[0]?.default_project_id ?? null,
    });
  } catch (err) {
    console.error('prefs patch error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/users/me/profile — update own display name
router.patch('/me/profile', requireAuth, async (req, res) => {
  try {
    const { displayName } = req.body || {};
    const userId = req.session.user.id;
    if (typeof displayName !== 'string' || !displayName.trim()) {
      return res.status(400).json({ error: 'Display name required' });
    }
    const trimmed = displayName.trim().slice(0, 120);
    await pool.query('UPDATE users SET display_name = $1 WHERE id = $2', [trimmed, userId]);
    const r = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    req.session.user = buildSessionUser(r.rows[0]);
    req.session.save(() => {});
    res.json({ user: req.session.user });
  } catch (err) {
    console.error('profile update error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/users/search?q=&project_id= — mention autocomplete (any authenticated user).
// When project_id is provided, results are filtered to project members iff
// the effective restrict_mentions_to_members for that project is on. Admins
// (global role) bypass the filter so they can mention anyone.
router.get('/search', requireAuth, async (req, res) => {
  try {
    const q = ((req.query.q || '').trim().toLowerCase()) + '%';
    const projectId = req.query.project_id ? Number(req.query.project_id) : null;
    const isAdmin = req.session.user?.role === 'Admin';
    let restrictToMembers = false;
    if (projectId) {
      const proj = await pool.query(
        `SELECT restrict_mentions_to_members FROM projects WHERE id = $1`,
        [projectId]
      );
      if (proj.rows[0]) {
        const { getRestrictionDefaults, effectiveFlag } = require('../services/restrictions');
        const def = await getRestrictionDefaults();
        restrictToMembers = effectiveFlag(proj.rows[0].restrict_mentions_to_members, def.mentions);
      }
    }
    let r;
    if (projectId && restrictToMembers && !isAdmin) {
      r = await pool.query(`
        SELECT u.id, u.display_name, u.email
          FROM users u
          JOIN project_members pm ON pm.user_id = u.id AND pm.project_id = $2
         WHERE u.status = 'active'
           AND (
             LOWER(u.display_name) LIKE $1
             OR LOWER(u.email) LIKE $1
             OR LOWER(SPLIT_PART(u.email, '@', 1)) LIKE $1
           )
         ORDER BY u.display_name
         LIMIT 8
      `, [q, projectId]);
    } else {
      r = await pool.query(`
        SELECT id, display_name, email
          FROM users
         WHERE status = 'active'
           AND (
             LOWER(display_name) LIKE $1
             OR LOWER(email) LIKE $1
             OR LOWER(SPLIT_PART(email, '@', 1)) LIKE $1
           )
         ORDER BY display_name
         LIMIT 8
      `, [q]);
    }
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/users/:id/avatar — serve avatar (auth required)
router.get('/:id/avatar', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT profile_picture_filename FROM users WHERE id = $1', [req.params.id]);
    const filename = r.rows[0]?.profile_picture_filename;
    if (!filename) return res.status(404).end();
    const filePath = avatarPath(filename);
    if (!fs.existsSync(filePath)) return res.status(404).end();
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).end();
  }
});

// POST /api/users/me/avatar — upload own avatar (image bytes, e.g. cropped PNG)
router.post('/me/avatar', requireAuth, avatarUpload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const userId = req.session.user.id;
    await saveAvatarFromBytes(userId, req.file.buffer, req.file.mimetype);
    const r = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    req.session.user = buildSessionUser(r.rows[0]);
    req.session.save(() => {});
    res.json({ user: req.session.user });
  } catch (err) {
    console.error('avatar upload error:', err);
    res.status(500).json({ error: 'Avatar upload failed' });
  }
});

// DELETE /api/users/me/avatar — remove own avatar
router.delete('/me/avatar', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    await clearAvatar(userId);
    const r = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    req.session.user = buildSessionUser(r.rows[0]);
    req.session.save(() => {});
    res.json({ user: req.session.user });
  } catch (err) {
    console.error('avatar delete error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

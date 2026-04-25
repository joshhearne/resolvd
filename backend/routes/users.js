const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { buildSessionUser } = require('../auth/session');
const { avatarPath, saveAvatarFromBytes, clearAvatar } = require('../services/avatar');

const router = express.Router();

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Avatar must be an image'));
    cb(null, true);
  },
});

const VALID_ROLES = ['Admin', 'Submitter', 'Viewer'];

// GET /api/users (Admin only)
router.get('/', requireAuth, requireRole('Admin'), async (req, res) => {
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

// PATCH /api/users/me/preferences — any authenticated user
router.patch('/me/preferences', requireAuth, async (req, res) => {
  try {
    const { default_project_id } = req.body;
    const userId = req.session.user.id;

    // null clears the preference; otherwise verify project exists and user can access it
    if (default_project_id !== null && default_project_id !== undefined) {
      const proj = await pool.query('SELECT id FROM projects WHERE id = $1 AND status = $2', [default_project_id, 'active']);
      if (!proj.rows[0]) return res.status(404).json({ error: 'Project not found' });
    }

    const val = default_project_id || null;
    await pool.query('UPDATE users SET default_project_id = $1 WHERE id = $2', [val, userId]);
    req.session.user.defaultProjectId = val;
    req.session.save(() => {});
    res.json({ default_project_id: val });
  } catch (err) {
    console.error(err);
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

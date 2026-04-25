const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const VALID_ROLES = ['Admin', 'Submitter', 'Viewer'];

// GET /api/users (Admin only)
router.get('/', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, display_name, email, upn, role, created_at, last_login
      FROM users ORDER BY display_name ASC
    `);
    res.json(result.rows);
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

module.exports = router;

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/views — list all saved views (system-wide)
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT sv.*, u.display_name as created_by_name
      FROM saved_views sv
      LEFT JOIN users u ON sv.user_id = u.id
      ORDER BY sv.name ASC
    `);
    // filters is JSONB — pg driver returns parsed object already
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/views — save a new view
router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, filters } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
    if (!filters || typeof filters !== 'object') return res.status(400).json({ error: 'Filters required' });

    const result = await pool.query(
      'INSERT INTO saved_views (user_id, name, filters) VALUES ($1, $2, $3) RETURNING *',
      [req.session.user.id, name.trim(), filters]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/views/:id — creator or Admin can delete
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM saved_views WHERE id = $1', [req.params.id]);
    const view = result.rows[0];
    if (!view) return res.status(404).json({ error: 'View not found' });
    const isAdmin = req.session.user.role === 'Admin';
    const isCreator = view.user_id === req.session.user.id;
    if (!isAdmin && !isCreator) return res.status(403).json({ error: 'Forbidden' });
    await pool.query('DELETE FROM saved_views WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

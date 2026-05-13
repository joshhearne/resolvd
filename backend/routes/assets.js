const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/assets — paginated list with optional search. Phase 1A
// surface for smoke testing the Action1 sync before the dedicated UI
// lands. Admin-only until the Technician role exists.
router.get('/', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const q = (req.query.q || '').trim();

    const params = [];
    let where = '';
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      where = `WHERE LOWER(hostname) LIKE $1
                  OR LOWER(serial) LIKE $1
                  OR LOWER(organization) LIKE $1
                  OR LOWER(model) LIKE $1`;
    }
    params.push(limit, offset);
    const limitIdx = params.length - 1;
    const offsetIdx = params.length;

    const r = await pool.query(
      `SELECT id, source_system, source_external_id, hostname, serial,
              manufacturer, model, os, os_version, organization,
              last_seen_at, updated_at
         FROM assets
         ${where}
         ORDER BY last_seen_at DESC NULLS LAST, hostname
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );
    const total = await pool.query(`SELECT COUNT(*)::int AS n FROM assets ${where}`, q ? [params[0]] : []);
    res.json({ items: r.rows, total: total.rows[0].n, limit, offset });
  } catch (err) {
    console.error('assets list error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/assets/:id — single asset incl. raw_data
router.get('/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM assets WHERE id = $1`, [Number(req.params.id)]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('asset get error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

// Admin CRUD for dedup-omit rules + a stateless /test endpoint that the
// admin UI's tester panel calls to evaluate a regex against a pasted
// sample (server-side parity with the runtime matcher). See
// services/dedupOmit.js for how these rules gate inbound auto-create dedup.

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const dedupOmit = require('../services/dedupOmit');

const router = express.Router();

// GET /api/dedup-omit-rules — list (Admin + Manager can view)
router.get('/', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, pattern, flags, scope, enabled, created_at, updated_at
         FROM dedup_omit_rules ORDER BY created_at ASC, id ASC`
    );
    res.json(r.rows);
  } catch (err) {
    console.error('dedup-omit list:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/dedup-omit-rules/test — evaluate a candidate rule against a
// pasted sample. Stateless; does not persist. Returns { match, error }.
// Placed before '/:id' routes so "test" isn't captured as an id.
router.post('/test', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  const { pattern, flags = 'i', scope = 'title_body', sample = '' } = req.body || {};
  const c = dedupOmit.compile(pattern, flags);
  if (c.error) return res.json({ ok: true, match: false, error: c.error });
  // The tester uses a single paste box; evaluate the pattern against the
  // sample for every field the scope covers (mirrors ruleMatches).
  const match = dedupOmit.ruleMatches(
    { pattern, flags, scope },
    { title: sample, body: sample }
  );
  res.json({ ok: true, match, error: null });
});

// POST /api/dedup-omit-rules — create (Admin only)
router.post('/', requireAuth, requireRole('Admin'), async (req, res) => {
  const v = dedupOmit.validateRule(req.body || {});
  if (v) return res.status(400).json({ error: v });
  const { name, pattern, flags = 'i', scope = 'title', enabled = true } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO dedup_omit_rules (name, pattern, flags, scope, enabled)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [String(name).trim(), pattern, String(flags), scope, !!enabled]
    );
    dedupOmit.bustCache();
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error('dedup-omit create:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/dedup-omit-rules/:id — update (Admin only)
router.patch('/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  const v = dedupOmit.validateRule(req.body || {}, { partial: true });
  if (v) return res.status(400).json({ error: v });
  try {
    const sets = [];
    const values = [];
    let p = 1;
    for (const k of ['name', 'pattern', 'flags', 'scope', 'enabled']) {
      if (Object.prototype.hasOwnProperty.call(req.body, k)) {
        sets.push(`${k} = $${p++}`);
        values.push(k === 'enabled' ? !!req.body[k] : req.body[k]);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'no updatable fields' });
    sets.push('updated_at = NOW()');
    values.push(Number(req.params.id));
    const r = await pool.query(
      `UPDATE dedup_omit_rules SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`,
      values
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    dedupOmit.bustCache();
    res.json(r.rows[0]);
  } catch (err) {
    console.error('dedup-omit patch:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/dedup-omit-rules/:id (Admin only)
router.delete('/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM dedup_omit_rules WHERE id = $1 RETURNING id`,
      [Number(req.params.id)]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    dedupOmit.bustCache();
    res.json({ ok: true });
  } catch (err) {
    console.error('dedup-omit delete:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

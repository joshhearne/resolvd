// Admin CRUD for software_aliases. Routes are Admin-only; aliases
// are global (no per-tenant scoping yet — one canonical map per
// install, matching how other admin lists work today).

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { invalidateCache } = require('../services/softwareAliases');

const router = express.Router();

function validateBody(body) {
  if (!body || typeof body !== 'object') return 'body required';
  const pattern = (body.pattern || '').toString();
  if (!pattern.trim()) return 'pattern required';
  if (pattern.length > 500) return 'pattern too long (max 500)';
  const canonical = (body.canonical_name || '').toString();
  if (!canonical.trim()) return 'canonical_name required';
  if (canonical.length > 200) return 'canonical_name too long (max 200)';
  if (body.is_regex) {
    try { new RegExp(pattern); }
    catch (e) { return `invalid regex: ${e.message}`; }
  }
  if (body.priority != null) {
    const n = Number(body.priority);
    if (!Number.isInteger(n) || n < 0 || n > 10000) return 'priority must be integer 0–10000';
  }
  return null;
}

router.get('/', requireAuth, requireRole('Admin', 'Manager'), async (_req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, pattern, is_regex, canonical_name, canonical_vendor,
             priority, created_at, updated_at,
             (SELECT COUNT(*)::int FROM asset_software WHERE last_alias_id = software_aliases.id) AS match_count
        FROM software_aliases
       ORDER BY priority ASC, id ASC
    `);
    res.json(r.rows);
  } catch (err) {
    console.error('software-aliases list:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.post('/', requireAuth, requireRole('Admin'), async (req, res) => {
  const err = validateBody(req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const r = await pool.query(
      `INSERT INTO software_aliases (pattern, is_regex, canonical_name, canonical_vendor, priority)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        req.body.pattern.trim(),
        !!req.body.is_regex,
        req.body.canonical_name.trim(),
        req.body.canonical_vendor ? req.body.canonical_vendor.trim() : null,
        req.body.priority != null ? Number(req.body.priority) : 100,
      ]
    );
    invalidateCache();
    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error('software-alias create:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

router.patch('/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  const err = validateBody(req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const r = await pool.query(
      `UPDATE software_aliases
          SET pattern = $1, is_regex = $2, canonical_name = $3,
              canonical_vendor = $4, priority = $5, updated_at = NOW()
        WHERE id = $6
      RETURNING *`,
      [
        req.body.pattern.trim(),
        !!req.body.is_regex,
        req.body.canonical_name.trim(),
        req.body.canonical_vendor ? req.body.canonical_vendor.trim() : null,
        req.body.priority != null ? Number(req.body.priority) : 100,
        req.params.id,
      ]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    invalidateCache();
    res.json(r.rows[0]);
  } catch (e) {
    console.error('software-alias patch:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

router.delete('/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM software_aliases WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    invalidateCache();
    res.json({ ok: true });
  } catch (e) {
    console.error('software-alias delete:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

// Near-duplicates suggestion. Uses pg_trgm similarity() to find pairs
// of distinct software names that look like the same product. The
// query is bounded by:
//   * picking only the most-installed names (top 200) to keep the
//     n^2 join tractable on big tables;
//   * similarity threshold (>= 0.65 by default) so we don't surface
//     unrelated noise;
//   * cap at 50 suggestion pairs returned to the UI.
// Admin clicks a suggestion -> opens the create-alias form pre-filled.
// Falls back to an empty list silently when pg_trgm isn't installed.
router.get('/_meta/near-dupes', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  const threshold = Math.max(0.4, Math.min(0.95, Number(req.query.threshold) || 0.65));
  try {
    const r = await pool.query(`
      WITH top_names AS (
        SELECT name, COUNT(*)::int AS install_count
          FROM asset_software
         WHERE canonical_name IS NULL
         GROUP BY name
         ORDER BY install_count DESC
         LIMIT 200
      )
      SELECT a.name AS a_name, a.install_count AS a_count,
             b.name AS b_name, b.install_count AS b_count,
             similarity(a.name, b.name) AS sim
        FROM top_names a
        JOIN top_names b ON a.name < b.name
       WHERE similarity(a.name, b.name) >= $1
       ORDER BY sim DESC, a_count + b_count DESC
       LIMIT 50
    `, [threshold]);
    res.json(r.rows);
  } catch (err) {
    // pg_trgm not available, or query timed out — degrade to empty.
    console.warn('software-aliases near-dupes failed:', err.message);
    res.json([]);
  }
});

module.exports = router;

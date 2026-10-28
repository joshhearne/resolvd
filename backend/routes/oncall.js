// On-call rotation admin. Rotations + overrides; who is on call is
// computed by services/oncall.js. Admin/Manager read and manage — the
// roster is day-to-day team management, like assignment pools.

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { onCallAt, upcomingShifts, loadOverrides } = require('../services/oncall');

const router = express.Router();
const manage = requireRole('Admin', 'Manager');

function validRotation(b, { create }) {
  if (create || b.name !== undefined) {
    if (!b.name || typeof b.name !== 'string' || !b.name.trim()) return 'name required';
  }
  if (b.project_id != null && (!Number.isInteger(b.project_id) || b.project_id <= 0)) {
    return 'project_id must be a positive integer or null';
  }
  if (create || b.member_ids !== undefined) {
    if (!Array.isArray(b.member_ids) || b.member_ids.some((id) => !Number.isInteger(id) || id <= 0)) {
      return 'member_ids must be an array of user ids';
    }
    if (new Set(b.member_ids).size !== b.member_ids.length) return 'member_ids must not repeat';
  }
  if (create || b.shift_hours !== undefined) {
    if (!Number.isInteger(b.shift_hours) || b.shift_hours < 1 || b.shift_hours > 8760) {
      return 'shift_hours must be 1–8760';
    }
  }
  if (create || b.handoff_at !== undefined) {
    if (!b.handoff_at || Number.isNaN(Date.parse(b.handoff_at))) return 'handoff_at must be a timestamp';
  }
  if (b.enabled !== undefined && typeof b.enabled !== 'boolean') return 'enabled must be boolean';
  return null;
}

// GET /api/oncall — rotations with overrides, who's on call now, and the
// next few shifts.
router.get('/', requireAuth, manage, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT o.*, p.name AS project_name, p.prefix AS project_prefix
        FROM oncall_rotations o
        LEFT JOIN projects p ON p.id = o.project_id
       ORDER BY o.project_id NULLS FIRST, o.name, o.id
    `);
    const overrides = await loadOverrides(pool, r.rows.map((x) => x.id));
    const now = new Date();
    res.json(r.rows.map((rot) => {
      const list = (overrides.get(rot.id) || []).sort((a, b) => a.starts_at - b.starts_at);
      return {
        ...rot,
        overrides: list.filter((o) => o.ends_at > now),
        on_call_now: onCallAt(rot, list, now),
        upcoming: upcomingShifts(rot, now, 4),
      };
    }));
  } catch (err) {
    console.error('oncall list:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.post('/', requireAuth, manage, async (req, res) => {
  const b = req.body || {};
  const v = validRotation(b, { create: true });
  if (v) return res.status(400).json({ error: v });
  try {
    const r = await pool.query(
      `INSERT INTO oncall_rotations (name, project_id, member_ids, shift_hours, handoff_at, enabled)
       VALUES ($1, $2, $3::int[], $4, $5, COALESCE($6, TRUE)) RETURNING *`,
      [b.name.trim(), b.project_id || null, b.member_ids, b.shift_hours, b.handoff_at, b.enabled]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error('oncall create:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.patch('/:id', requireAuth, manage, async (req, res) => {
  const b = req.body || {};
  const v = validRotation(b, { create: false });
  if (v) return res.status(400).json({ error: v });
  const sets = [];
  const values = [];
  const add = (sql, val) => { values.push(val); sets.push(sql.replace('?', `$${values.length}`)); };
  if (b.name !== undefined) add('name = ?', b.name.trim());
  if (b.project_id !== undefined) add('project_id = ?', b.project_id || null);
  if (b.member_ids !== undefined) add('member_ids = ?::int[]', b.member_ids);
  if (b.shift_hours !== undefined) add('shift_hours = ?', b.shift_hours);
  if (b.handoff_at !== undefined) add('handoff_at = ?', b.handoff_at);
  if (b.enabled !== undefined) add('enabled = ?', b.enabled);
  if (!sets.length) return res.status(400).json({ error: 'no updatable fields supplied' });
  try {
    values.push(Number(req.params.id));
    const r = await pool.query(
      `UPDATE oncall_rotations SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('oncall patch:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.delete('/:id', requireAuth, manage, async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM oncall_rotations WHERE id = $1`, [Number(req.params.id)]);
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('oncall delete:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/oncall/:id/overrides — { user_id, starts_at, ends_at, note? }
router.post('/:id/overrides', requireAuth, manage, async (req, res) => {
  const { user_id, starts_at, ends_at, note } = req.body || {};
  if (!Number.isInteger(user_id) || user_id <= 0) return res.status(400).json({ error: 'user_id required' });
  const s = Date.parse(starts_at);
  const e = Date.parse(ends_at);
  if (Number.isNaN(s) || Number.isNaN(e)) return res.status(400).json({ error: 'starts_at and ends_at must be timestamps' });
  if (e <= s) return res.status(400).json({ error: 'ends_at must be after starts_at' });
  try {
    const r = await pool.query(
      `INSERT INTO oncall_overrides (rotation_id, user_id, starts_at, ends_at, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [Number(req.params.id), user_id, starts_at, ends_at, note ? String(note).slice(0, 200) : null, req.session.user.id]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23503') return res.status(404).json({ error: 'rotation or user not found' });
    console.error('oncall override create:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.delete('/:id/overrides/:overrideId', requireAuth, manage, async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM oncall_overrides WHERE id = $1 AND rotation_id = $2`,
      [Number(req.params.overrideId), Number(req.params.id)]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('oncall override delete:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

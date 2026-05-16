// Admin CRUD for auto-assignment policies. Same scoping rules as
// sla_policies: project_id IS NULL is the org default for a priority,
// project_id NOT NULL is a project override. No seeded rows — auto-
// assignment is opt-in, ticket creators get pure project-default
// fallback until an admin sets up policies.

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const STRATEGIES = ['round_robin', 'case_load', 'specific_user'];
const PRIORITY_OPS = ['=', '<', '>', '<=', '>='];

function validateBody(body, { requireScope = false } = {}) {
  const { priority, priority_op, project_id, strategy, agent_pool, specific_user_id, enabled } = body || {};
  if (requireScope && (!Number.isInteger(priority) || priority < 1 || priority > 5)) {
    return 'priority must be 1–5';
  }
  if (requireScope && project_id != null && (!Number.isInteger(project_id) || project_id <= 0)) {
    return 'project_id must be positive integer or null';
  }
  if (priority_op !== undefined && !PRIORITY_OPS.includes(priority_op)) {
    return `priority_op must be one of ${PRIORITY_OPS.join(', ')}`;
  }
  if (strategy !== undefined && !STRATEGIES.includes(strategy)) {
    return `strategy must be one of ${STRATEGIES.join(', ')}`;
  }
  if (agent_pool !== undefined) {
    if (!Array.isArray(agent_pool) || agent_pool.some((id) => !Number.isInteger(id) || id <= 0)) {
      return 'agent_pool must be an array of positive integer user ids';
    }
  }
  if (specific_user_id !== undefined && specific_user_id !== null
      && (!Number.isInteger(specific_user_id) || specific_user_id <= 0)) {
    return 'specific_user_id must be positive integer or null';
  }
  if (enabled !== undefined && typeof enabled !== 'boolean') return 'enabled must be boolean';
  return null;
}

// GET /api/assignment-policies — list. Admin/Manager.
router.get('/', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT a.*, p.name AS project_name, p.prefix AS project_prefix,
             u.display_name AS specific_user_name
        FROM assignment_policies a
        LEFT JOIN projects p ON p.id = a.project_id
        LEFT JOIN users u ON u.id = a.specific_user_id
       ORDER BY a.project_id NULLS FIRST, a.priority
    `);
    res.json(r.rows);
  } catch (err) {
    console.error('assignment policies list:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/assignment-policies — create. Admin only.
router.post('/', requireAuth, requireRole('Admin'), async (req, res) => {
  const v = validateBody(req.body, { requireScope: true });
  if (v) return res.status(400).json({ error: v });
  try {
    const { priority, priority_op, project_id, strategy, agent_pool, specific_user_id, enabled } = req.body;
    const r = await pool.query(
      `INSERT INTO assignment_policies
         (priority, priority_op, project_id, strategy, agent_pool, specific_user_id, enabled)
       VALUES ($1, $2, $3, $4, $5::int[], $6, COALESCE($7, TRUE))
       RETURNING *`,
      [
        priority,
        priority_op || '=',
        project_id || null,
        strategy || 'specific_user',
        agent_pool || [],
        specific_user_id || null,
        enabled,
      ]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error('assignment policy create:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/assignment-policies/:id — Admin only.
router.patch('/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  const v = validateBody(req.body);
  if (v) return res.status(400).json({ error: v });
  try {
    const id = Number(req.params.id);
    const body = req.body || {};
    const sets = [];
    const values = [];
    let p = 1;
    for (const k of ['strategy', 'priority_op', 'specific_user_id', 'enabled']) {
      if (Object.prototype.hasOwnProperty.call(body, k)) {
        sets.push(`${k} = $${p++}`);
        values.push(body[k]);
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'agent_pool')) {
      sets.push(`agent_pool = $${p++}::int[]`);
      values.push(body.agent_pool);
    }
    // Allow admins to reset the cursor manually (useful when the pool
    // changes mid-cycle and they want round-robin to start over).
    if (Object.prototype.hasOwnProperty.call(body, 'round_robin_cursor')) {
      if (!Number.isInteger(body.round_robin_cursor) || body.round_robin_cursor < 0) {
        return res.status(400).json({ error: 'round_robin_cursor must be non-negative integer' });
      }
      sets.push(`round_robin_cursor = $${p++}`);
      values.push(body.round_robin_cursor);
    }
    if (!sets.length) return res.status(400).json({ error: 'no updatable fields supplied' });
    sets.push('updated_at = NOW()');
    values.push(id);
    const r = await pool.query(
      `UPDATE assignment_policies SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`,
      values
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'policy not found' });
    res.json(r.rows[0]);
  } catch (e) {
    console.error('assignment policy patch:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

router.delete('/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM assignment_policies WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('assignment policy delete:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

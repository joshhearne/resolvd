// Escalation chain admin. Each row = one step. Group in the UI by
// (priority, project_id, trigger); step_order drives execution order.

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const TRIGGERS = ['warning_response', 'warning_resolve', 'breach_response', 'breach_resolve'];
const ACTIONS = ['notify_user', 'notify_role', 'reassign_user', 'reassign_role'];
const ROLES = ['Admin', 'Manager', 'Tech'];

function validate(body, { create = false } = {}) {
  const b = body || {};
  if (create) {
    if (!Number.isInteger(b.priority) || b.priority < 1 || b.priority > 5) return 'priority must be 1–5';
    if (b.project_id != null && (!Number.isInteger(b.project_id) || b.project_id <= 0)) return 'project_id must be positive integer or null';
    if (!TRIGGERS.includes(b.trigger)) return `trigger must be one of ${TRIGGERS.join(', ')}`;
    if (!ACTIONS.includes(b.action)) return `action must be one of ${ACTIONS.join(', ')}`;
  } else {
    if (b.trigger !== undefined && !TRIGGERS.includes(b.trigger)) return `trigger must be one of ${TRIGGERS.join(', ')}`;
    if (b.action !== undefined && !ACTIONS.includes(b.action)) return `action must be one of ${ACTIONS.join(', ')}`;
  }
  if (b.delay_minutes !== undefined && (!Number.isInteger(b.delay_minutes) || b.delay_minutes < 0)) {
    return 'delay_minutes must be non-negative integer';
  }
  if (b.step_order !== undefined && (!Number.isInteger(b.step_order) || b.step_order < 1)) {
    return 'step_order must be positive integer';
  }
  if (b.target_user_id !== undefined && b.target_user_id !== null
      && (!Number.isInteger(b.target_user_id) || b.target_user_id <= 0)) {
    return 'target_user_id must be positive integer or null';
  }
  if (b.target_role !== undefined && b.target_role !== null && !ROLES.includes(b.target_role)) {
    return `target_role must be one of ${ROLES.join(', ')} or null`;
  }
  return null;
}

router.get('/', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT e.*, p.name AS project_name, p.prefix AS project_prefix,
             u.display_name AS target_user_name
        FROM escalation_chain_steps e
        LEFT JOIN projects p ON p.id = e.project_id
        LEFT JOIN users u ON u.id = e.target_user_id
       ORDER BY e.project_id NULLS FIRST, e.priority, e.trigger, e.step_order, e.id
    `);
    res.json(r.rows);
  } catch (err) {
    console.error('escalation list:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.post('/', requireAuth, requireRole('Admin'), async (req, res) => {
  const v = validate(req.body, { create: true });
  if (v) return res.status(400).json({ error: v });
  try {
    const b = req.body;
    const r = await pool.query(
      `INSERT INTO escalation_chain_steps
         (priority, project_id, trigger, step_order, delay_minutes,
          action, target_user_id, target_role, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, TRUE))
       RETURNING *`,
      [
        b.priority,
        b.project_id || null,
        b.trigger,
        b.step_order || 1,
        b.delay_minutes || 0,
        b.action,
        b.target_user_id || null,
        b.target_role || null,
        b.enabled,
      ]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error('escalation create:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

router.patch('/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  const v = validate(req.body);
  if (v) return res.status(400).json({ error: v });
  try {
    const id = Number(req.params.id);
    const b = req.body || {};
    const sets = [];
    const values = [];
    let p = 1;
    for (const k of ['trigger', 'step_order', 'delay_minutes', 'action',
                     'target_user_id', 'target_role', 'enabled']) {
      if (Object.prototype.hasOwnProperty.call(b, k)) {
        sets.push(`${k} = $${p++}`);
        values.push(b[k]);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'no updatable fields supplied' });
    sets.push('updated_at = NOW()');
    values.push(id);
    const r = await pool.query(
      `UPDATE escalation_chain_steps SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`,
      values
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
  } catch (e) {
    console.error('escalation patch:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

router.delete('/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM escalation_chain_steps WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('escalation delete:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

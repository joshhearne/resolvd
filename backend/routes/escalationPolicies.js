// Escalation chain admin. Each row = one step. Group in the UI by
// (priority, project_id, trigger); step_order drives execution order.
// Each step carries an actions[] array — fan out to multiple targets
// on the same (trigger, delay) without duplicating rows.

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const TRIGGERS = ['warning_response', 'warning_resolve', 'breach_response', 'breach_resolve'];
const ACTION_KINDS = ['notify_user', 'notify_role', 'notify_assignee', 'reassign_user', 'reassign_role', 'reassign_agent', 'bump_priority'];
const ROLES = ['Admin', 'Manager', 'Tech'];
const PRIORITY_OPS = ['=', '<', '>', '<=', '>='];

// Validate one action object. Returns error string or null.
function validateAction(a) {
  if (!a || typeof a !== 'object') return 'action entry must be an object';
  if (!ACTION_KINDS.includes(a.kind)) return `action.kind must be one of ${ACTION_KINDS.join(', ')}`;
  // notify_assignee + reassign_agent need neither target. notify_assignee
  // uses ticket.assigned_to. reassign_agent picks any project agent that
  // isn't the current assignee at fire time.
  if (a.kind === 'notify_user' || a.kind === 'reassign_user') {
    if (!Number.isInteger(a.target_user_id) || a.target_user_id <= 0) {
      return `${a.kind} requires target_user_id (positive integer)`;
    }
  }
  if (a.kind === 'notify_role' || a.kind === 'reassign_role') {
    if (!ROLES.includes(a.target_role)) {
      return `${a.kind} requires target_role ∈ ${ROLES.join(', ')}`;
    }
  }
  if (a.kind === 'bump_priority') {
    // levels: how many tiers to escalate toward more urgent (subtract from
    // numeric priority). Max 4 — P5 → P1 is the longest possible bump.
    if (!Number.isInteger(a.levels) || a.levels < 1 || a.levels > 4) {
      return 'bump_priority requires levels (integer 1–4)';
    }
    if (a.floor !== undefined && a.floor !== null) {
      if (!Number.isInteger(a.floor) || a.floor < 1 || a.floor > 5) {
        return 'bump_priority floor must be 1–5';
      }
    }
  }
  return null;
}

function validate(body, { create = false } = {}) {
  const b = body || {};
  if (create) {
    if (!Number.isInteger(b.priority) || b.priority < 1 || b.priority > 5) return 'priority must be 1–5';
    if (b.project_id != null && (!Number.isInteger(b.project_id) || b.project_id <= 0)) return 'project_id must be positive integer or null';
    if (!TRIGGERS.includes(b.trigger)) return `trigger must be one of ${TRIGGERS.join(', ')}`;
    if (!Array.isArray(b.actions) || b.actions.length === 0) return 'actions must be a non-empty array';
  } else {
    if (b.trigger !== undefined && !TRIGGERS.includes(b.trigger)) return `trigger must be one of ${TRIGGERS.join(', ')}`;
  }
  if (b.actions !== undefined) {
    if (!Array.isArray(b.actions) || b.actions.length === 0) return 'actions must be a non-empty array';
    for (const a of b.actions) {
      const err = validateAction(a);
      if (err) return err;
    }
  }
  if (b.priority_op !== undefined && !PRIORITY_OPS.includes(b.priority_op)) {
    return `priority_op must be one of ${PRIORITY_OPS.join(', ')}`;
  }
  if (b.delay_minutes !== undefined && (!Number.isInteger(b.delay_minutes) || b.delay_minutes < 0)) {
    return 'delay_minutes must be non-negative integer';
  }
  if (b.step_order !== undefined && (!Number.isInteger(b.step_order) || b.step_order < 1)) {
    return 'step_order must be positive integer';
  }
  return null;
}

// Strip nulls from action entries before persisting so the JSONB blob
// stays compact (e.g. notify_assignee carries no targets).
function normalizeActions(actions) {
  return actions.map((a) => {
    const out = { kind: a.kind };
    if (a.target_user_id) out.target_user_id = Number(a.target_user_id);
    if (a.target_role) out.target_role = a.target_role;
    if (a.kind === 'bump_priority') {
      out.levels = Number(a.levels);
      if (a.floor !== undefined && a.floor !== null) out.floor = Number(a.floor);
    }
    return out;
  });
}

router.get('/', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT e.*, p.name AS project_name, p.prefix AS project_prefix
        FROM escalation_chain_steps e
        LEFT JOIN projects p ON p.id = e.project_id
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
         (priority, priority_op, project_id, trigger, step_order, delay_minutes,
          actions, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, COALESCE($8, TRUE))
       RETURNING *`,
      [
        b.priority,
        b.priority_op || '=',
        b.project_id || null,
        b.trigger,
        b.step_order || 1,
        b.delay_minutes || 0,
        JSON.stringify(normalizeActions(b.actions)),
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
    for (const k of ['trigger', 'priority_op', 'step_order', 'delay_minutes', 'enabled']) {
      if (Object.prototype.hasOwnProperty.call(b, k)) {
        sets.push(`${k} = $${p++}`);
        values.push(b[k]);
      }
    }
    if (Object.prototype.hasOwnProperty.call(b, 'actions')) {
      sets.push(`actions = $${p++}::jsonb`);
      values.push(JSON.stringify(normalizeActions(b.actions)));
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

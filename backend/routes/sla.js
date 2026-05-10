// SLA admin + dashboard endpoints.
//
// Admin: CRUD for sla_policies. One default row per priority (project_id
// IS NULL) is seeded by the schema migration; admins can edit those, add
// per-project overrides, or delete overrides to fall back to default.
//
// Dashboard: counts + breach lists for at-a-glance SLA health.

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { decryptRows } = require('../services/fields');

const router = express.Router();

// ─── Policies ────────────────────────────────────────────────────────────

// GET /api/sla/policies — list all policies (defaults + overrides).
// Admin/Manager can read; only Admin can mutate.
router.get('/policies', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT s.id, s.priority, s.project_id, p.name AS project_name, p.prefix AS project_prefix,
             s.response_target_minutes, s.resolve_target_minutes,
             s.created_at, s.updated_at
        FROM sla_policies s
        LEFT JOIN projects p ON p.id = s.project_id
       ORDER BY s.project_id NULLS FIRST, s.priority
    `);
    res.json(r.rows);
  } catch (err) {
    console.error('sla policies list:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/sla/policies — create a project override (cannot create org
// default rows here; the migration seeded those).
router.post('/policies', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const { priority, project_id, response_target_minutes, resolve_target_minutes } = req.body || {};
    if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
      return res.status(400).json({ error: 'priority must be 1-5' });
    }
    if (!Number.isInteger(project_id) || project_id <= 0) {
      return res.status(400).json({ error: 'project_id required for override (use PATCH on org defaults)' });
    }
    if (!Number.isInteger(response_target_minutes) || response_target_minutes <= 0) {
      return res.status(400).json({ error: 'response_target_minutes must be positive integer' });
    }
    if (!Number.isInteger(resolve_target_minutes) || resolve_target_minutes <= 0) {
      return res.status(400).json({ error: 'resolve_target_minutes must be positive integer' });
    }
    const r = await pool.query(`
      INSERT INTO sla_policies (priority, project_id, response_target_minutes, resolve_target_minutes)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [priority, project_id, response_target_minutes, resolve_target_minutes]);
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'override already exists for this priority + project' });
    console.error('sla policy create:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/sla/policies/:id — edit response/resolve targets on any row
// (org default or project override).
router.patch('/policies/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { response_target_minutes, resolve_target_minutes } = req.body || {};
    const updates = [];
    const values = [];
    if (response_target_minutes !== undefined) {
      if (!Number.isInteger(response_target_minutes) || response_target_minutes <= 0) {
        return res.status(400).json({ error: 'response_target_minutes must be positive integer' });
      }
      values.push(response_target_minutes);
      updates.push(`response_target_minutes = $${values.length}`);
    }
    if (resolve_target_minutes !== undefined) {
      if (!Number.isInteger(resolve_target_minutes) || resolve_target_minutes <= 0) {
        return res.status(400).json({ error: 'resolve_target_minutes must be positive integer' });
      }
      values.push(resolve_target_minutes);
      updates.push(`resolve_target_minutes = $${values.length}`);
    }
    if (!updates.length) return res.status(400).json({ error: 'no updatable fields supplied' });
    updates.push('updated_at = NOW()');
    values.push(id);
    const r = await pool.query(`
      UPDATE sla_policies SET ${updates.join(', ')}
        WHERE id = $${values.length}
        RETURNING *
    `, values);
    if (!r.rows[0]) return res.status(404).json({ error: 'policy not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('sla policy patch:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/sla/policies/:id — only project-override rows can be
// deleted. Org defaults are protected (delete one and tickets in that
// priority lose SLA tracking entirely).
router.delete('/policies/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const r = await pool.query(`SELECT project_id FROM sla_policies WHERE id = $1`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'policy not found' });
    if (r.rows[0].project_id == null) {
      return res.status(400).json({ error: 'cannot delete org-default policy; PATCH it instead' });
    }
    await pool.query(`DELETE FROM sla_policies WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('sla policy delete:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── Dashboard ───────────────────────────────────────────────────────────

// GET /api/sla/dashboard — at-a-glance counts + breach lists.
// Returns: { counts: {open, at_risk, breached_response, breached_resolve},
//           breached: [...recent breached tickets], at_risk: [...] }
// at_risk = within 25% of due-at, not yet responded / resolved.
router.get('/dashboard', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const counts = await pool.query(`
      SELECT
        SUM(CASE WHEN sla_response_breached = TRUE AND sla_first_response_at IS NULL THEN 1 ELSE 0 END)::int AS breached_response,
        SUM(CASE WHEN sla_resolve_breached = TRUE AND resolved_at IS NULL THEN 1 ELSE 0 END)::int AS breached_resolve,
        SUM(CASE WHEN sla_response_due_at IS NOT NULL AND sla_first_response_at IS NULL AND sla_response_breached = FALSE THEN 1 ELSE 0 END)::int AS open_response,
        SUM(CASE WHEN sla_resolve_due_at  IS NOT NULL AND resolved_at IS NULL              AND sla_resolve_breached  = FALSE THEN 1 ELSE 0 END)::int AS open_resolve
      FROM tickets
    `);

    // At-risk = unresponded tickets where (now → due) is < 25% of
    // (created → due) remaining. Quick-and-dirty proxy for "due soon".
    const atRisk = await pool.query(`
      SELECT id, internal_ref, title, title_enc, priority, sla_response_due_at, sla_resolve_due_at,
             sla_first_response_at, resolved_at, sla_paused_at, project_id
        FROM tickets
       WHERE sla_paused_at IS NULL
         AND (
           (sla_response_due_at IS NOT NULL AND sla_first_response_at IS NULL AND sla_response_breached = FALSE
              AND sla_response_due_at < NOW() + INTERVAL '1 hour')
           OR
           (sla_resolve_due_at IS NOT NULL AND resolved_at IS NULL AND sla_resolve_breached = FALSE
              AND sla_resolve_due_at < NOW() + INTERVAL '4 hours')
         )
       ORDER BY LEAST(COALESCE(sla_response_due_at, 'infinity'), COALESCE(sla_resolve_due_at, 'infinity')) ASC
       LIMIT 50
    `);
    await decryptRows('tickets', atRisk.rows);

    const breached = await pool.query(`
      SELECT id, internal_ref, title, title_enc, priority, sla_response_due_at, sla_resolve_due_at,
             sla_response_breached, sla_resolve_breached, sla_first_response_at, resolved_at, project_id
        FROM tickets
       WHERE (sla_response_breached = TRUE AND sla_first_response_at IS NULL)
          OR (sla_resolve_breached  = TRUE AND resolved_at IS NULL)
       ORDER BY GREATEST(
           COALESCE(sla_response_due_at, '-infinity'),
           COALESCE(sla_resolve_due_at,  '-infinity')
       ) DESC
       LIMIT 50
    `);
    await decryptRows('tickets', breached.rows);

    res.json({
      counts: counts.rows[0],
      at_risk: atRisk.rows,
      breached: breached.rows,
    });
  } catch (err) {
    console.error('sla dashboard:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

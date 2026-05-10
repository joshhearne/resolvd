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

// Returns array of project IDs the user can access, or null if
// Admin/Manager (which means "all projects"). Mirrors the helper in
// routes/tickets.js — kept inline so this module stays self-contained.
async function getAccessibleProjectIds(user) {
  if (['Admin', 'Manager'].includes(user.role)) return null;
  const result = await pool.query(
    'SELECT project_id FROM project_members WHERE user_id = $1',
    [user.id]
  );
  return result.rows.map(r => r.project_id);
}

// GET /api/sla/dashboard — counts + breach lists for the dashboard
// SLA card. Open to any authenticated user; project visibility is
// scoped by membership (Admin/Manager see all, Submitter/Viewer see
// only project_members rows). MTD breach counts are grouped per
// project so the user can see where their pain is.
router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const accessible = await getAccessibleProjectIds(req.session.user);
    // Empty array case: scoped user with zero project memberships → no
    // SLA data to show. Return zeroed shape so the frontend can render
    // an empty state without special-casing.
    if (accessible !== null && accessible.length === 0) {
      return res.json({
        scope: 'project_member',
        live: { breached_response: 0, breached_resolve: 0, open_response: 0, open_resolve: 0 },
        mtd_total: { response: 0, resolve: 0 },
        mtd_by_project: [],
        at_risk: [],
        breached: [],
      });
    }

    // Build a "project_id IN ($scope)" SQL fragment + params. Reuses
    // the same scope across the four queries below.
    const scopeParams = [];
    let scopeWhere = '';
    if (accessible !== null) {
      scopeParams.push(accessible);
      scopeWhere = `AND project_id = ANY($1)`;
    }

    // Live state across in-scope tickets.
    const counts = await pool.query(`
      SELECT
        SUM(CASE WHEN sla_response_breached = TRUE AND sla_first_response_at IS NULL THEN 1 ELSE 0 END)::int AS breached_response,
        SUM(CASE WHEN sla_resolve_breached = TRUE AND resolved_at IS NULL THEN 1 ELSE 0 END)::int AS breached_resolve,
        SUM(CASE WHEN sla_response_due_at IS NOT NULL AND sla_first_response_at IS NULL AND sla_response_breached = FALSE THEN 1 ELSE 0 END)::int AS open_response,
        SUM(CASE WHEN sla_resolve_due_at  IS NOT NULL AND resolved_at IS NULL              AND sla_resolve_breached  = FALSE THEN 1 ELSE 0 END)::int AS open_resolve
      FROM tickets
      WHERE 1=1 ${scopeWhere}
    `, scopeParams);

    // Month-to-date breach totals across all in-scope projects.
    const mtdTotal = await pool.query(`
      SELECT
        SUM(CASE WHEN sla_response_breached_at IS NOT NULL AND sla_response_breached_at >= date_trunc('month', NOW()) THEN 1 ELSE 0 END)::int AS response,
        SUM(CASE WHEN sla_resolve_breached_at  IS NOT NULL AND sla_resolve_breached_at  >= date_trunc('month', NOW()) THEN 1 ELSE 0 END)::int AS resolve
      FROM tickets
      WHERE 1=1 ${scopeWhere}
    `, scopeParams);

    // Per-project MTD breakdown — joined with projects so we have a
    // friendly name + prefix for the UI.
    const mtdByProject = await pool.query(`
      SELECT
        t.project_id,
        p.name    AS project_name,
        p.prefix  AS project_prefix,
        SUM(CASE WHEN t.sla_response_breached_at IS NOT NULL AND t.sla_response_breached_at >= date_trunc('month', NOW()) THEN 1 ELSE 0 END)::int AS breached_response,
        SUM(CASE WHEN t.sla_resolve_breached_at  IS NOT NULL AND t.sla_resolve_breached_at  >= date_trunc('month', NOW()) THEN 1 ELSE 0 END)::int AS breached_resolve
      FROM tickets t
      LEFT JOIN projects p ON p.id = t.project_id
      WHERE 1=1 ${scopeWhere ? 'AND t.project_id = ANY($1)' : ''}
      GROUP BY t.project_id, p.name, p.prefix
      HAVING SUM(CASE WHEN t.sla_response_breached_at >= date_trunc('month', NOW()) THEN 1 ELSE 0 END) > 0
          OR SUM(CASE WHEN t.sla_resolve_breached_at  >= date_trunc('month', NOW()) THEN 1 ELSE 0 END) > 0
      ORDER BY (
        SUM(CASE WHEN t.sla_response_breached_at >= date_trunc('month', NOW()) THEN 1 ELSE 0 END) +
        SUM(CASE WHEN t.sla_resolve_breached_at  >= date_trunc('month', NOW()) THEN 1 ELSE 0 END)
      ) DESC
    `, scopeParams);

    // At-risk + breached samples (capped) for inline drill-down.
    const atRisk = await pool.query(`
      SELECT id, internal_ref, title, title_enc, effective_priority, sla_response_due_at, sla_resolve_due_at,
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
         ${scopeWhere}
       ORDER BY LEAST(COALESCE(sla_response_due_at, 'infinity'), COALESCE(sla_resolve_due_at, 'infinity')) ASC
       LIMIT 25
    `, scopeParams);
    await decryptRows('tickets', atRisk.rows);

    const breached = await pool.query(`
      SELECT id, internal_ref, title, title_enc, effective_priority, sla_response_due_at, sla_resolve_due_at,
             sla_response_breached, sla_resolve_breached, sla_first_response_at, resolved_at, project_id
        FROM tickets
       WHERE ((sla_response_breached = TRUE AND sla_first_response_at IS NULL)
           OR (sla_resolve_breached  = TRUE AND resolved_at IS NULL))
         ${scopeWhere}
       ORDER BY GREATEST(
           COALESCE(sla_response_due_at, '-infinity'),
           COALESCE(sla_resolve_due_at,  '-infinity')
       ) DESC
       LIMIT 25
    `, scopeParams);
    await decryptRows('tickets', breached.rows);

    res.json({
      scope: accessible === null ? 'all' : 'project_member',
      live: counts.rows[0],
      mtd_total: mtdTotal.rows[0],
      mtd_by_project: mtdByProject.rows,
      at_risk: atRisk.rows,
      breached: breached.rows,
    });
  } catch (err) {
    console.error('sla dashboard:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

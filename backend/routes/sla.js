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
             s.warning_threshold_percent, s.business_hours_id,
             bh.name AS business_hours_name, bh.tz AS business_hours_tz, bh.enabled AS business_hours_enabled,
             s.created_at, s.updated_at
        FROM sla_policies s
        LEFT JOIN projects p ON p.id = s.project_id
        LEFT JOIN business_hours_policies bh ON bh.id = s.business_hours_id
       ORDER BY s.project_id NULLS FIRST, s.priority
    `);
    res.json(r.rows);
  } catch (err) {
    console.error('sla policies list:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── Business hours ──────────────────────────────────────────────────────

// GET /api/sla/business-hours — list. Admin/Manager read.
router.get('/business-hours', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT b.*, p.name AS project_name, p.prefix AS project_prefix
        FROM business_hours_policies b
        LEFT JOIN projects p ON p.id = b.project_id
       ORDER BY b.project_id NULLS FIRST, b.name
    `);
    res.json(r.rows);
  } catch (err) {
    console.error('business-hours list:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

function validateBh(body) {
  const { name, project_id, tz, days, start_time, end_time, enabled } = body || {};
  if (!name || typeof name !== 'string') return 'name required';
  if (project_id != null && (!Number.isInteger(project_id) || project_id <= 0)) return 'project_id must be positive integer or null';
  if (!tz || typeof tz !== 'string') return 'tz required (IANA name)';
  if (!Array.isArray(days) || !days.length) return 'days must be a non-empty array (0=Sun..6=Sat)';
  if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return 'days entries must be 0–6';
  if (!/^\d{1,2}:\d{2}$/.test(String(start_time || ''))) return 'start_time must be HH:MM';
  if (!/^\d{1,2}:\d{2}$/.test(String(end_time || ''))) return 'end_time must be HH:MM';
  if (enabled != null && typeof enabled !== 'boolean') return 'enabled must be boolean';
  return null;
}

router.post('/business-hours', requireAuth, requireRole('Admin'), async (req, res) => {
  const err = validateBh(req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { name, project_id, tz, days, start_time, end_time, enabled } = req.body;
    const r = await pool.query(
      `INSERT INTO business_hours_policies (name, project_id, tz, days, start_time, end_time, enabled)
       VALUES ($1, $2, $3, $4::int[], $5, $6, COALESCE($7, TRUE))
       RETURNING *`,
      [name.trim(), project_id || null, tz, days, start_time, end_time, enabled]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'business hours already exist for this scope' });
    console.error('business-hours create:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

router.patch('/business-hours/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const body = req.body || {};
    const sets = [];
    const values = [];
    let p = 1;
    for (const k of ['name', 'tz', 'start_time', 'end_time', 'enabled']) {
      if (Object.prototype.hasOwnProperty.call(body, k)) {
        sets.push(`${k} = $${p++}`);
        values.push(body[k]);
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'days')) {
      if (!Array.isArray(body.days) || body.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
        return res.status(400).json({ error: 'days must be array of 0–6 ints' });
      }
      sets.push(`days = $${p++}::int[]`);
      values.push(body.days);
    }
    if (!sets.length) return res.status(400).json({ error: 'no updatable fields supplied' });
    sets.push('updated_at = NOW()');
    values.push(id);
    const r = await pool.query(
      `UPDATE business_hours_policies SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`,
      values
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
  } catch (e) {
    console.error('business-hours patch:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

router.delete('/business-hours/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const r = await pool.query(`SELECT project_id FROM business_hours_policies WHERE id = $1`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    if (r.rows[0].project_id == null) return res.status(400).json({ error: 'cannot delete org default; disable it instead' });
    await pool.query(`DELETE FROM business_hours_policies WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('business-hours delete:', e);
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
    const {
      response_target_minutes,
      resolve_target_minutes,
      warning_threshold_percent,
      business_hours_id,
    } = req.body || {};
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
    if (warning_threshold_percent !== undefined) {
      if (!Number.isInteger(warning_threshold_percent) || warning_threshold_percent < 0 || warning_threshold_percent > 99) {
        return res.status(400).json({ error: 'warning_threshold_percent must be 0–99' });
      }
      values.push(warning_threshold_percent);
      updates.push(`warning_threshold_percent = $${values.length}`);
    }
    if (business_hours_id !== undefined) {
      if (business_hours_id !== null && (!Number.isInteger(business_hours_id) || business_hours_id <= 0)) {
        return res.status(400).json({ error: 'business_hours_id must be positive integer or null' });
      }
      values.push(business_hours_id);
      updates.push(`business_hours_id = $${values.length}`);
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

    // Live state across in-scope tickets. Pause-time breakdown joins
    // the live in-progress pause (NOW - sla_paused_at) onto the
    // accumulated totals so an active pause is reflected immediately
    // without waiting for the next status change.
    const counts = await pool.query(`
      SELECT
        SUM(CASE WHEN sla_response_breached = TRUE AND sla_first_response_at IS NULL THEN 1 ELSE 0 END)::int AS breached_response,
        SUM(CASE WHEN sla_resolve_breached = TRUE AND resolved_at IS NULL THEN 1 ELSE 0 END)::int AS breached_resolve,
        SUM(CASE WHEN sla_response_due_at IS NOT NULL AND sla_first_response_at IS NULL AND sla_response_breached = FALSE THEN 1 ELSE 0 END)::int AS open_response,
        SUM(CASE WHEN sla_resolve_due_at  IS NOT NULL AND resolved_at IS NULL              AND sla_resolve_breached  = FALSE THEN 1 ELSE 0 END)::int AS open_resolve,
        SUM(
          sla_vendor_wait_seconds
          + CASE WHEN sla_pause_kind = 'vendor' AND sla_paused_at IS NOT NULL
                 THEN GREATEST(0, EXTRACT(EPOCH FROM (NOW() - sla_paused_at))::int)
                 ELSE 0 END
        )::bigint AS vendor_wait_seconds,
        SUM(
          sla_internal_hold_seconds
          + CASE WHEN sla_pause_kind = 'internal' AND sla_paused_at IS NOT NULL
                 THEN GREATEST(0, EXTRACT(EPOCH FROM (NOW() - sla_paused_at))::int)
                 ELSE 0 END
        )::bigint AS internal_hold_seconds
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

// GET /api/sla/time-in-status — aggregated time tickets have spent in
// each status, derived from audit_log status_change rows. Spans are
// (entered_at, next status_change OR NOW()). Initial status (before
// any change) isn't counted — keeps the SQL simple and the signal is
// still meaningful for chokepoint detection.
//
// Resolved-pending-close statuses (semantic_tag='resolved_pending_close')
// are excluded: tickets are *supposed* to sit there for the auto-close
// grace window, so counting that time as time-in-status would tag a
// healthy queue as a chokepoint. (Previously we tried to cap spans by
// joining t.resolved_at, but that column gets rewritten on reopens, so
// prior Resolved spans went uncapped and the bucket dominated the
// chart.)
//
// Query params:
//   project_id — restrict to one project (optional). Otherwise scoped
//                by member visibility same as /dashboard.
//   since      — ISO8601 lower bound for entered_at (optional).
//   until      — ISO8601 upper bound for entered_at (optional).
router.get('/time-in-status', requireAuth, async (req, res) => {
  try {
    const accessible = await getAccessibleProjectIds(req.session.user);
    if (accessible !== null && accessible.length === 0) {
      return res.json({ scope: 'project_member', rows: [] });
    }

    const params = [];
    const where = [
      `al.action = 'status_change'`,
      // Exclude resolved-pending-close statuses (Resolved sits 3 days
      // by design) and terminal statuses (Closed sits forever). Both
      // would dominate the chart for non-chokepoint reasons.
      `al.new_value NOT IN (
         SELECT name FROM statuses
         WHERE kind = 'internal'
           AND (semantic_tag = 'resolved_pending_close' OR is_terminal = TRUE)
       )`,
    ];
    if (req.query.project_id) {
      params.push(Number(req.query.project_id));
      where.push(`t.project_id = $${params.length}`);
    }
    if (accessible !== null) {
      params.push(accessible);
      where.push(`t.project_id = ANY($${params.length})`);
    }
    if (req.query.since) {
      params.push(req.query.since);
      where.push(`al.created_at >= $${params.length}`);
    }
    if (req.query.until) {
      params.push(req.query.until);
      where.push(`al.created_at < $${params.length}`);
    }

    const r = await pool.query(
      `WITH status_history AS (
         SELECT
           al.ticket_id,
           al.new_value AS status,
           al.created_at AS entered_at,
           LEAST(
             LEAD(al.created_at) OVER (PARTITION BY al.ticket_id ORDER BY al.created_at),
             NOW()
           ) AS left_at
         FROM audit_log al
         JOIN tickets t ON t.id = al.ticket_id
         WHERE ${where.join(' AND ')}
       )
       SELECT
         status,
         SUM(EXTRACT(EPOCH FROM (left_at - entered_at)))::bigint AS total_seconds,
         AVG(EXTRACT(EPOCH FROM (left_at - entered_at)))::bigint AS avg_seconds,
         COUNT(*)::int AS entries
       FROM status_history
       WHERE left_at IS NOT NULL AND left_at > entered_at
       GROUP BY status
       ORDER BY total_seconds DESC`,
      params
    );
    res.json({
      scope: accessible === null ? 'all' : 'project_member',
      rows: r.rows,
    });
  } catch (err) {
    console.error('sla time-in-status:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

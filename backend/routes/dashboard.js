const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { getTicketScope, scopeClause, isSubmitterRole } = require('../services/ticketVisibility');

const router = express.Router();

// Parse comma-separated query param into an array of trimmed values.
// Returns null when the param is missing/empty so callers can skip the
// filter rather than pass an empty array (which would match nothing).
function parseCsv(v) {
  if (v == null) return null;
  const arr = String(v).split(',').map((s) => s.trim()).filter(Boolean);
  return arr.length ? arr : null;
}

function parseInts(v) {
  const arr = parseCsv(v);
  if (!arr) return null;
  const out = arr.map((s) => Number(s)).filter((n) => Number.isFinite(n));
  return out.length ? out : null;
}

function parseSince(v) {
  if (!v) return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// Build the SQL fragment + params for the dashboard's filter intersection.
// Combines (a) requested project_id filter, (b) the caller's visibility
// scope (services/ticketVisibility — Submitters: own + followed only),
// (c) requested status filter, (d) requested since cutoff. alias = the
// tickets alias used in the query.
async function buildTicketFilter(user, query, alias = 't') {
  const scope = await getTicketScope(user);
  const requested = parseInts(query.project_id);

  const statuses = parseCsv(query.status);
  const since = parseSince(query.since);
  const params = [];
  const where = [];
  if (requested) {
    params.push(requested);
    where.push(`${alias}.project_id = ANY($${params.length}::int[])`);
  }
  if (!scope.unrestricted) {
    const c = scopeClause(scope, alias, params.length + 1);
    params.push(...c.params);
    where.push(c.sql);
  }
  if (statuses) {
    params.push(statuses);
    where.push(`${alias}.internal_status = ANY($${params.length}::text[])`);
  }
  if (since) {
    params.push(since);
    where.push(`${alias}.created_at >= $${params.length}`);
  }
  return {
    sql: where.length ? where.join(' AND ') : 'TRUE',
    params,
    empty: false,
    restricted: !scope.unrestricted,
  };
}

// Audit actions a Submitter may see in their activity feed. Anything
// handler-internal (time logs, custom-field recomputes, mute toggles,
// alert plumbing) stays off the submitter view.
const SUBMITTER_ACTIVITY_ACTIONS = [
  'ticket_created',
  'ticket_created_from_alert',
  'submitted_on_behalf',
  'status_change',
  'external_status_update',
  'reopened',
  'assignment_change',
  'ticket_moved',
];

// GET /api/dashboard/stats — accepts ?project_id=N,M&status=A,B&since=ISO.
// Filters constrain ticket counts and priority distribution. Without
// filters, behaves identically to the v0.6.x signature so existing
// callers don't break.
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const f = await buildTicketFilter(req.session.user, req.query);
    if (f.empty) {
      return res.json({
        total_open: 0, total_in_progress: 0, total_awaiting_mot: 0,
        total_pending_review: 0, total_closed: 0, total_reopened: 0,
        flagged_for_review: 0, priority_distribution: [],
      });
    }

    const statusCounts = await pool.query(
      `SELECT internal_status, COUNT(*)::int AS count
         FROM tickets t
        WHERE ${f.sql}
        GROUP BY internal_status`,
      f.params,
    );

    // "Active" excludes terminal (Closed) AND resolved_pending_close (Resolved)
    // — a resolved ticket in its grace window isn't active work.
    const priorityCounts = await pool.query(
      `SELECT effective_priority, COUNT(*)::int AS count
         FROM tickets t
         LEFT JOIN statuses s ON s.kind = 'internal' AND s.name = t.internal_status
        WHERE s.is_terminal IS NOT TRUE
          AND COALESCE(s.semantic_tag,'') <> 'resolved_pending_close'
          AND ${f.sql}
        GROUP BY effective_priority
        ORDER BY effective_priority`,
      f.params,
    );

    const flaggedCount = await pool.query(
      `SELECT COUNT(*)::int AS count
         FROM tickets t
        WHERE flagged_for_review = TRUE
          AND internal_status != 'Closed'
          AND ${f.sql}`,
      f.params,
    );

    const statusMap = {};
    statusCounts.rows.forEach((r) => { statusMap[r.internal_status] = r.count; });
    const bucket = (...names) => names.reduce((n, s) => n + (statusMap[s] || 0), 0);

    res.json({
      // Dashboard cards bucket several internal statuses into one number, so
      // tickets in Acknowledged / On Hold / External Escalation / Resolved
      // aren't silently dropped (was returning 0s). Keep these buckets in sync
      // with URL_PRESETS in frontend/src/pages/TicketList.jsx.
      total_open: bucket('Open'),
      total_in_progress: bucket('In Progress', 'Acknowledged'),
      total_awaiting_mot: bucket('Awaiting Input', 'On Hold', 'External Escalation'),
      total_pending_review: bucket('Pending Review'),
      total_closed: bucket('Resolved', 'Closed'),
      total_reopened: bucket('Reopened'),
      flagged_for_review: flaggedCount.rows[0].count,
      priority_distribution: priorityCounts.rows,
    });
  } catch (err) {
    console.error('dashboard stats:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/dashboard/activity — accepts ?project_id=&since=. status
// filter intentionally ignored here: activity rows mention old/new
// status, so a status filter on the *current* ticket state would hide
// audit history that's still relevant.
router.get('/activity', requireAuth, async (req, res) => {
  try {
    const { decryptRows } = require('../services/fields');
    // Use the shared filter for project scoping only — since on tickets
    // would hide audit rows that touch older tickets, and status would
    // race the audit row's notion of "current" state.
    const f = await buildTicketFilter(
      req.session.user,
      { ...req.query, status: undefined, since: undefined },
      't',
    );
    if (f.empty) return res.json([]);

    const params = [...f.params];
    let sinceClause = '';
    const since = parseSince(req.query.since);
    if (since) {
      params.push(since);
      sinceClause = `AND a.created_at >= $${params.length}`;
    }

    // Global (ticket-less) audit rows are admin/system activity — only
    // unrestricted callers see them. Submitters additionally only see a
    // curated set of ticket-lifecycle actions.
    const ticketScope = f.restricted
      ? `(a.ticket_id IS NOT NULL AND ${f.sql})`
      : `(a.ticket_id IS NULL OR ${f.sql})`;
    let actionClause = '';
    if (isSubmitterRole(req.session.user)) {
      params.push(SUBMITTER_ACTIVITY_ACTIONS);
      actionClause = `AND a.action = ANY($${params.length}::text[])`;
    }

    const result = await pool.query(
      `SELECT a.*, u.display_name AS user_name, t.internal_ref,
              t.title AS ticket_title, t.title_enc AS ticket_title_enc
         FROM audit_log a
         LEFT JOIN users u ON a.user_id = u.id
         LEFT JOIN tickets t ON a.ticket_id = t.id
        WHERE ${ticketScope}
          ${actionClause}
          ${sinceClause}
        ORDER BY a.created_at DESC
        LIMIT 10`,
      params,
    );
    await decryptRows('audit_log', result.rows, {
      aliases: { ticket_title: 'tickets.title' },
    });
    res.json(result.rows);
  } catch (err) {
    console.error('dashboard activity:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/dashboard/mine — curated dashboard for Submitters (#102).
// Only the caller's own submissions + tickets they follow, regardless of
// project membership or elevation. Available to every role (it's a
// personal view), but the frontend shows it in place of the team
// dashboard for global Submitters.
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const { decryptRows } = require('../services/fields');
    const uid = req.session.user.id;

    // Live = non-terminal and not in the resolved grace window; mirrors
    // the "active" definition used by the team dashboard.
    const liveExpr = `(s.is_terminal IS NOT TRUE
                       AND COALESCE(s.semantic_tag,'') <> 'resolved_pending_close')`;
    const awaitingExpr = `(t.internal_status IN ('Awaiting Input','On Hold'))`;
    const resolvedExpr = `(s.is_terminal = TRUE
                           OR COALESCE(s.semantic_tag,'') = 'resolved_pending_close')`;

    const counts = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE t.submitted_by = $1 AND ${liveExpr})::int  AS my_open,
         COUNT(*) FILTER (WHERE t.submitted_by = $1 AND ${liveExpr} AND ${awaitingExpr})::int AS my_awaiting,
         COUNT(*) FILTER (WHERE t.submitted_by = $1 AND ${resolvedExpr})::int AS my_resolved,
         COUNT(*) FILTER (WHERE t.submitted_by IS DISTINCT FROM $1 AND ${liveExpr})::int AS following_open
         FROM tickets t
         LEFT JOIN statuses s ON s.kind = 'internal' AND s.name = t.internal_status
        WHERE t.submitted_by = $1
           OR EXISTS (SELECT 1 FROM ticket_followers tf
                       WHERE tf.ticket_id = t.id AND tf.user_id = $1)`,
      [uid],
    );

    const listSql = (where) => `
      SELECT t.id, t.internal_ref, t.title, t.title_enc, t.internal_status,
             t.effective_priority, t.priority_override, t.computed_priority,
             t.updated_at, t.created_at,
             proj.name AS project_name, proj.prefix AS project_prefix,
             asgn.display_name AS assigned_to_name,
             ${liveExpr} AS is_live
        FROM tickets t
        LEFT JOIN projects proj ON proj.id = t.project_id
        LEFT JOIN users asgn ON asgn.id = t.assigned_to
        LEFT JOIN statuses s ON s.kind = 'internal' AND s.name = t.internal_status
       WHERE ${where}
       ORDER BY ${liveExpr} DESC, t.updated_at DESC
       LIMIT 15`;

    const mine = await pool.query(listSql('t.submitted_by = $1'), [uid]);
    const following = await pool.query(
      listSql(`t.submitted_by IS DISTINCT FROM $1
               AND EXISTS (SELECT 1 FROM ticket_followers tf
                            WHERE tf.ticket_id = t.id AND tf.user_id = $1)`),
      [uid],
    );
    await decryptRows('tickets', mine.rows);
    await decryptRows('tickets', following.rows);

    res.json({
      counts: counts.rows[0],
      my_tickets: mine.rows,
      following: following.rows,
    });
  } catch (err) {
    console.error('dashboard mine:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

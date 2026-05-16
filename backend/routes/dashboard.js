const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

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

// Project visibility: Admin/Manager see everything. Anyone else is
// limited to project_members. Returns null = unrestricted, [] = none.
async function getAccessibleProjectIds(user) {
  if (['Admin', 'Manager'].includes(user.role)) return null;
  const r = await pool.query(
    'SELECT project_id FROM project_members WHERE user_id = $1',
    [user.id],
  );
  return r.rows.map((row) => row.project_id);
}

// Build the SQL fragment + params for the dashboard's filter intersection.
// Combines (a) requested project_id filter, (b) the caller's accessible
// projects (Submitter/Viewer scope), (c) requested status filter, (d)
// requested since cutoff. table = "tickets" or alias used in the query.
async function buildTicketFilter(user, query, alias = 't') {
  const accessible = await getAccessibleProjectIds(user);
  const requested = parseInts(query.project_id);
  let projectFilter = null;
  if (accessible !== null && requested !== null) {
    // Intersect — caller can only narrow within their accessible set.
    projectFilter = requested.filter((id) => accessible.includes(id));
    if (projectFilter.length === 0) return { sql: 'FALSE', params: [], empty: true };
  } else if (accessible !== null) {
    projectFilter = accessible;
    if (projectFilter.length === 0) return { sql: 'FALSE', params: [], empty: true };
  } else if (requested !== null) {
    projectFilter = requested;
  }

  const statuses = parseCsv(query.status);
  const since = parseSince(query.since);
  const params = [];
  const where = [];
  if (projectFilter) {
    params.push(projectFilter);
    where.push(`${alias}.project_id = ANY($${params.length}::int[])`);
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
  };
}

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

    const priorityCounts = await pool.query(
      `SELECT effective_priority, COUNT(*)::int AS count
         FROM tickets t
        WHERE internal_status NOT IN ('Closed')
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

    res.json({
      total_open: statusMap['Open'] || 0,
      total_in_progress: statusMap['In Progress'] || 0,
      total_awaiting_mot: statusMap['Awaiting Input'] || 0,
      total_pending_review: statusMap['Pending Review'] || 0,
      total_closed: statusMap['Closed'] || 0,
      total_reopened: statusMap['Reopened'] || 0,
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

    const result = await pool.query(
      `SELECT a.*, u.display_name AS user_name, t.internal_ref,
              t.title AS ticket_title, t.title_enc AS ticket_title_enc
         FROM audit_log a
         LEFT JOIN users u ON a.user_id = u.id
         LEFT JOIN tickets t ON a.ticket_id = t.id
        WHERE (a.ticket_id IS NULL OR ${f.sql})
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

module.exports = router;

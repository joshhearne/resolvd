const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Cadence per scheduled job. Drives the "stale" indicator on the frontend
// (heartbeat older than 2x cadence = stale = warn). Keep aligned with the
// service file constants.
const JOB_CADENCE_MS = {
  muted_digest: 5 * 60 * 1000,
  inbox_subscription_renewal: 60 * 60 * 1000,
  auto_close: 60 * 60 * 1000,
};

const JOB_LABELS = {
  muted_digest: 'Muted-vendor digest',
  inbox_subscription_renewal: 'Inbox subscription renewal',
  auto_close: 'Auto-close + follow-up reminder',
};

router.get('/', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const [jobs, alertSources, emailAccounts, ticketCounts, inboundCounts, dbStats] = await Promise.all([
      pool.query(`
        SELECT name, last_run_at, last_status, metadata
          FROM system_jobs
         ORDER BY name
      `),
      pool.query(`
        SELECT id, name, preset, enabled, last_seen_at,
               (SELECT COUNT(*)::int FROM external_alert_event WHERE source_id = s.id) AS event_count
          FROM external_alert_source s
         ORDER BY name
      `),
      pool.query(`
        SELECT id, display_name, from_address, provider, is_active,
               inbox_monitor_enabled, inbox_subscription_expires_at,
               last_test_at, last_test_status
          FROM email_backend_accounts
         ORDER BY is_active DESC, display_name
      `),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE internal_status != 'Closed')::int AS active,
          COUNT(*) FILTER (WHERE internal_status = 'Open')::int AS open,
          COUNT(*) FILTER (WHERE internal_status = 'In Progress')::int AS in_progress,
          COUNT(*) FILTER (WHERE flagged_for_review = TRUE AND internal_status != 'Closed')::int AS flagged,
          COUNT(*) FILTER (WHERE effective_priority = 1 AND internal_status != 'Closed')::int AS p1,
          COUNT(*) FILTER (WHERE effective_priority = 2 AND internal_status != 'Closed')::int AS p2,
          COUNT(*) AS total
          FROM tickets
      `),
      pool.query(`
        SELECT status, COUNT(*)::int AS count
          FROM inbound_email_queue
         GROUP BY status
      `),
      pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM users WHERE status = 'active') AS active_users,
          (SELECT COUNT(*)::int FROM projects WHERE status = 'active') AS active_projects,
          (SELECT COUNT(*)::int FROM companies WHERE is_archived = FALSE) AS active_companies,
          pg_database_size(current_database()) AS db_size_bytes,
          pg_postmaster_start_time() AS db_started_at
      `),
    ]);

    const now = Date.now();
    const jobRows = jobs.rows.map((j) => {
      const cadence = JOB_CADENCE_MS[j.name] || null;
      const ageMs = j.last_run_at ? now - new Date(j.last_run_at).getTime() : null;
      let health = 'unknown';
      if (j.last_status === 'error') health = 'error';
      else if (ageMs == null) health = 'never_ran';
      else if (cadence && ageMs > cadence * 2) health = 'stale';
      else health = 'ok';
      return {
        name: j.name,
        label: JOB_LABELS[j.name] || j.name,
        last_run_at: j.last_run_at,
        last_status: j.last_status,
        metadata: j.metadata,
        cadence_ms: cadence,
        health,
      };
    });

    const inboundByStatus = {};
    for (const row of inboundCounts.rows) inboundByStatus[row.status] = row.count;

    res.json({
      jobs: jobRows,
      alert_sources: alertSources.rows,
      email_accounts: emailAccounts.rows,
      ticket_counts: ticketCounts.rows[0],
      inbound_counts: inboundByStatus,
      db_stats: dbStats.rows[0],
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('system-health error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

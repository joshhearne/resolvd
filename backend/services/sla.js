// SLA tracker — per-priority response + resolve targets, with project
// overrides, and pause-on-blocker semantics so vendor/customer wait
// time doesn't count against us.
//
// Conceptual model:
//   - sla_policies row picks the (response, resolve) target minutes
//     for a (priority, project) pair. Project-specific row beats org
//     default. Org default = project_id IS NULL row for that priority.
//   - Ticket gets sla_response_due_at + sla_resolve_due_at stamped at
//     create time = created_at + target minutes.
//   - sla_paused_at flips on when ticket enters a status with
//     semantic_tag IN ('awaiting_input','on_hold'); flips off when it
//     leaves. Each pause→resume bumps sla_paused_seconds and shifts
//     both due-at timestamps forward by the elapsed pause duration.
//   - sla_first_response_at fills in on the first non-system, non-
//     submitter comment.
//   - resolved_at (existing column) closes the resolve clock.
//   - Cron tickBreaches() finds rows past due that haven't responded /
//     resolved yet, flips the breached flag, fires an in-app + email
//     notification to followers + assignee.

const { pool } = require('../db/pool');

const PAUSE_TAGS = new Set(['awaiting_input', 'on_hold']);
const TERMINAL_TAGS = new Set(['closed']); // resolved is handled by resolved_at column

// Look up the effective policy for a (priority, project_id) pair.
// Project-specific row beats org default. Returns { response_minutes,
// resolve_minutes } or null when no policy is configured at all.
async function policyForTicket(client, priority, projectId) {
  const db = client || pool;
  // Try project override first.
  if (projectId) {
    const r = await db.query(
      `SELECT response_target_minutes, resolve_target_minutes
         FROM sla_policies
        WHERE priority = $1 AND project_id = $2`,
      [priority, projectId]
    );
    if (r.rows[0]) {
      return {
        response_minutes: r.rows[0].response_target_minutes,
        resolve_minutes: r.rows[0].resolve_target_minutes,
      };
    }
  }
  // Fall back to org default.
  const def = await db.query(
    `SELECT response_target_minutes, resolve_target_minutes
       FROM sla_policies
      WHERE priority = $1 AND project_id IS NULL`,
    [priority]
  );
  if (!def.rows[0]) return null;
  return {
    response_minutes: def.rows[0].response_target_minutes,
    resolve_minutes: def.rows[0].resolve_target_minutes,
  };
}

// Stamp due-at timestamps on a fresh ticket. Should be called from the
// same transaction as the INSERT so the values are written atomically.
async function applyPolicyOnCreate(client, { ticketId, priority, projectId, createdAt }) {
  const policy = await policyForTicket(client, priority, projectId);
  if (!policy) return; // No policy configured — leave SLA cols null
  const base = createdAt ? new Date(createdAt) : new Date();
  const responseDue = new Date(base.getTime() + policy.response_minutes * 60 * 1000);
  const resolveDue = new Date(base.getTime() + policy.resolve_minutes * 60 * 1000);
  await client.query(
    `UPDATE tickets
        SET sla_response_due_at = $1,
            sla_resolve_due_at  = $2
      WHERE id = $3`,
    [responseDue, resolveDue, ticketId]
  );
}

// Decide whether a status name represents a "paused" state. We re-resolve
// per call because the admin can rename / re-tag statuses.
async function isPauseStatus(client, statusName) {
  if (!statusName) return false;
  const r = await (client || pool).query(
    `SELECT semantic_tag FROM statuses WHERE name = $1 LIMIT 1`,
    [statusName]
  );
  const tag = r.rows[0]?.semantic_tag;
  return PAUSE_TAGS.has(tag);
}

// Pause the SLA clock on a ticket. Records sla_paused_at = NOW(). No-op
// if already paused.
async function pauseSla(client, ticketId) {
  await (client || pool).query(
    `UPDATE tickets SET sla_paused_at = NOW()
       WHERE id = $1 AND sla_paused_at IS NULL`,
    [ticketId]
  );
}

// Resume the SLA clock. Computes pause duration, adds to
// sla_paused_seconds, shifts both due-at timestamps forward by that
// duration, and clears sla_paused_at. No-op if not paused.
async function resumeSla(client, ticketId) {
  await (client || pool).query(
    `UPDATE tickets
        SET sla_paused_seconds = sla_paused_seconds + GREATEST(0, EXTRACT(EPOCH FROM (NOW() - sla_paused_at))::int),
            sla_response_due_at = sla_response_due_at + (NOW() - sla_paused_at),
            sla_resolve_due_at  = sla_resolve_due_at  + (NOW() - sla_paused_at),
            sla_paused_at = NULL
      WHERE id = $1 AND sla_paused_at IS NOT NULL`,
    [ticketId]
  );
}

// Called from the status-change handler. Diffs old vs new status against
// the pause set and pauses / resumes accordingly.
async function onStatusChange(client, { ticketId, oldStatus, newStatus }) {
  const wasPaused = await isPauseStatus(client, oldStatus);
  const isPaused  = await isPauseStatus(client, newStatus);
  if (!wasPaused && isPaused) await pauseSla(client, ticketId);
  else if (wasPaused && !isPaused) await resumeSla(client, ticketId);
}

// Stamp sla_first_response_at if not already set. Caller is responsible
// for filtering — this just trusts the call. Convention: fire from the
// comment POST handler when (a) comment is non-system AND (b) commenter
// is NOT the ticket submitter.
async function markResponded(client, ticketId) {
  await (client || pool).query(
    `UPDATE tickets
        SET sla_first_response_at = NOW()
      WHERE id = $1 AND sla_first_response_at IS NULL`,
    [ticketId]
  );
}

// Cron tick: find tickets past due that haven't been responded /
// resolved yet, flip the breached flag, fire fanout. Returns counts.
async function tickBreaches() {
  let respondedBreached = 0;
  let resolveBreached = 0;
  // Response-time breaches.
  const respDue = await pool.query(
    `UPDATE tickets
        SET sla_response_breached = TRUE
      WHERE sla_response_due_at IS NOT NULL
        AND sla_response_due_at < NOW()
        AND sla_first_response_at IS NULL
        AND sla_paused_at IS NULL
        AND sla_response_breached = FALSE
      RETURNING id, internal_ref, title, title_enc, project_id, assigned_to`
  );
  respondedBreached = respDue.rowCount;
  // Resolve-time breaches.
  const resDue = await pool.query(
    `UPDATE tickets
        SET sla_resolve_breached = TRUE
      WHERE sla_resolve_due_at IS NOT NULL
        AND sla_resolve_due_at < NOW()
        AND resolved_at IS NULL
        AND sla_paused_at IS NULL
        AND sla_resolve_breached = FALSE
      RETURNING id, internal_ref, title, title_enc, project_id, assigned_to`
  );
  resolveBreached = resDue.rowCount;

  // Fan out notifications to assignee + followers via the matrix.
  // Use a dedicated event_type 'sla_breach' so users can opt out per
  // channel. Fire in-app immediately; email follows the recipient's
  // digest cadence.
  if (respondedBreached || resolveBreached) {
    const fanoutSlaBreach = require('./notificationFanout').fanoutSlaBreach;
    if (typeof fanoutSlaBreach === 'function') {
      for (const row of respDue.rows) {
        await fanoutSlaBreach(pool, { ticket: row, kind: 'response' }).catch(err =>
          console.error('sla breach fanout (response) failed:', err.message));
      }
      for (const row of resDue.rows) {
        await fanoutSlaBreach(pool, { ticket: row, kind: 'resolve' }).catch(err =>
          console.error('sla breach fanout (resolve) failed:', err.message));
      }
    }
  }

  await pool.query(
    `UPDATE system_jobs
        SET last_run_at = NOW(), last_status = 'ok',
            metadata = jsonb_build_object('response_breached', $1::int, 'resolve_breached', $2::int)
      WHERE name = 'sla_breach_check'`,
    [respondedBreached, resolveBreached]
  ).catch(() => {});

  return { response_breached: respondedBreached, resolve_breached: resolveBreached };
}

let _interval = null;
function startScheduler() {
  if (_interval) return;
  // 5-minute cadence — same as muted_digest + notificationOutbox; SLA
  // breach detection doesn't need to be more granular than that.
  _interval = setInterval(() => {
    tickBreaches().catch(err => console.error('sla breach tick error:', err.message));
  }, 5 * 60 * 1000);
  tickBreaches().catch(() => {});
}

module.exports = {
  policyForTicket,
  applyPolicyOnCreate,
  pauseSla,
  resumeSla,
  onStatusChange,
  markResponded,
  tickBreaches,
  startScheduler,
};

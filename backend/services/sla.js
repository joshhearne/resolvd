// SLA tracker — per-priority response + resolve targets, with project
// overrides, pause-on-blocker semantics, optional business-hours clock,
// and pre-breach warnings (A2/A3 additions).
//
// Conceptual model:
//   - sla_policies row picks the (response, resolve) target minutes for
//     a (priority, project) pair. Project-specific row beats org default.
//     Policy may also pin business_hours_id (24/7 when NULL) and a
//     warning_threshold_percent (0 disables warnings).
//   - Ticket gets sla_response_due_at / sla_resolve_due_at AND
//     sla_response_warn_at / sla_resolve_warn_at stamped on create.
//     Warn = due_at - (response_minutes * (100 - threshold) / 100).
//     When business hours apply, both due_at and warn_at are computed by
//     addBusinessMinutes so the clock skips nights / weekends.
//   - sla_paused_at flips on for paused statuses; resume shifts all four
//     timestamps (due, warn × response, resolve) forward by elapsed pause
//     wall-clock duration. Pauses always count as wall-clock — once
//     paused, the clock is off regardless of business hours.
//   - tickWarnings() fires before tickBreaches() in the scheduler so a
//     ticket can warn → then breach on subsequent tick if still unfixed.

const { pool } = require('../db/pool');
const businessHours = require('./businessHours');

// Map semantic_tag → pause kind. awaiting_input is treated as vendor
// (the dominant case — waiting on external party). on_hold is internal
// (our team blocked itself: gathering info, scheduling, etc.). Admins
// who want different behavior can rename statuses; the tag set is
// fixed.
const PAUSE_KIND_BY_TAG = {
  awaiting_input: 'vendor',
  on_hold: 'internal',
};
const PAUSE_TAGS = new Set(Object.keys(PAUSE_KIND_BY_TAG));

// Look up the effective policy for a (priority, project_id) pair.
// Project-specific row beats org default. Returns the full row (incl.
// warning_threshold_percent + business_hours_id) or null when no policy
// is configured at all.
async function policyForTicket(client, priority, projectId) {
  const db = client || pool;
  if (projectId) {
    const r = await db.query(
      `SELECT * FROM sla_policies WHERE priority = $1 AND project_id = $2`,
      [priority, projectId]
    );
    if (r.rows[0]) return r.rows[0];
  }
  const def = await db.query(
    `SELECT * FROM sla_policies WHERE priority = $1 AND project_id IS NULL`,
    [priority]
  );
  return def.rows[0] || null;
}

// Compute warn_at given due_at, response/resolve minutes, threshold %.
// warn_at = due_at - ((100 - threshold) / 100) * targetMinutes (wall-clock).
// When business hours are set, this is close enough — exact "warn at
// X% of business minutes" would require running addBusinessMinutes
// backwards which isn't worth the complexity for an early-warning signal.
function warnAtFromDue(dueAt, targetMinutes, thresholdPercent) {
  if (!dueAt || !thresholdPercent || thresholdPercent <= 0 || thresholdPercent >= 100) return null;
  const remainingMinutes = targetMinutes * (100 - thresholdPercent) / 100;
  return new Date(dueAt.getTime() - remainingMinutes * 60_000);
}

// Stamp due-at + warn-at on a fresh ticket. Should be called from the
// same transaction as the INSERT.
async function applyPolicyOnCreate(client, { ticketId, priority, projectId, createdAt }) {
  const policy = await policyForTicket(client, priority, projectId);
  if (!policy) return;
  const bh = policy.business_hours_id
    ? await businessHours.policyById(client, policy.business_hours_id)
    : null;
  const base = createdAt ? new Date(createdAt) : new Date();
  const responseDue = businessHours.addBusinessMinutes(base, policy.response_target_minutes, bh);
  const resolveDue = businessHours.addBusinessMinutes(base, policy.resolve_target_minutes, bh);
  const threshold = policy.warning_threshold_percent ?? 80;
  const responseWarn = warnAtFromDue(responseDue, policy.response_target_minutes, threshold);
  const resolveWarn = warnAtFromDue(resolveDue, policy.resolve_target_minutes, threshold);
  await client.query(
    `UPDATE tickets
        SET sla_response_due_at  = $1,
            sla_resolve_due_at   = $2,
            sla_response_warn_at = $3,
            sla_resolve_warn_at  = $4
      WHERE id = $5`,
    [responseDue, resolveDue, responseWarn, resolveWarn, ticketId]
  );
}

// Returns null when the status isn't a pause status; otherwise returns
// the pause kind ('vendor' | 'internal') so callers can split the
// resulting wait time on the right counter.
async function pauseKindForStatus(client, statusName) {
  if (!statusName) return null;
  const r = await (client || pool).query(
    `SELECT semantic_tag FROM statuses WHERE name = $1 LIMIT 1`,
    [statusName]
  );
  const tag = r.rows[0]?.semantic_tag;
  return PAUSE_KIND_BY_TAG[tag] || null;
}

async function pauseSla(client, ticketId, kind = 'vendor') {
  await (client || pool).query(
    `UPDATE tickets
        SET sla_paused_at = NOW(),
            sla_pause_kind = $2
      WHERE id = $1 AND sla_paused_at IS NULL`,
    [ticketId, kind]
  );
}

// Resume: shift all four timestamps forward by wall-clock pause
// duration, AND increment either sla_vendor_wait_seconds or
// sla_internal_hold_seconds based on the kind stamped at pause time.
// sla_paused_seconds is still maintained as the total so legacy
// readers don't break.
async function resumeSla(client, ticketId) {
  await (client || pool).query(
    `UPDATE tickets
        SET sla_paused_seconds = sla_paused_seconds + GREATEST(0, EXTRACT(EPOCH FROM (NOW() - sla_paused_at))::int),
            sla_vendor_wait_seconds = sla_vendor_wait_seconds
              + CASE WHEN sla_pause_kind = 'vendor'
                     THEN GREATEST(0, EXTRACT(EPOCH FROM (NOW() - sla_paused_at))::int)
                     ELSE 0 END,
            sla_internal_hold_seconds = sla_internal_hold_seconds
              + CASE WHEN sla_pause_kind = 'internal'
                     THEN GREATEST(0, EXTRACT(EPOCH FROM (NOW() - sla_paused_at))::int)
                     ELSE 0 END,
            sla_response_due_at  = sla_response_due_at  + (NOW() - sla_paused_at),
            sla_resolve_due_at   = sla_resolve_due_at   + (NOW() - sla_paused_at),
            sla_response_warn_at = sla_response_warn_at + (NOW() - sla_paused_at),
            sla_resolve_warn_at  = sla_resolve_warn_at  + (NOW() - sla_paused_at),
            sla_paused_at = NULL,
            sla_pause_kind = NULL
      WHERE id = $1 AND sla_paused_at IS NOT NULL`,
    [ticketId]
  );
}

async function onStatusChange(client, { ticketId, oldStatus, newStatus }) {
  const oldKind = await pauseKindForStatus(client, oldStatus);
  const newKind = await pauseKindForStatus(client, newStatus);
  if (!oldKind && newKind) {
    await pauseSla(client, ticketId, newKind);
  } else if (oldKind && !newKind) {
    await resumeSla(client, ticketId);
  } else if (oldKind && newKind && oldKind !== newKind) {
    // Kind changed mid-pause (rare but legal — e.g. moving from
    // awaiting_input → on_hold). Close the old kind, open the new.
    await resumeSla(client, ticketId);
    await pauseSla(client, ticketId, newKind);
  }
}

async function markResponded(client, ticketId) {
  await (client || pool).query(
    `UPDATE tickets
        SET sla_first_response_at = NOW()
      WHERE id = $1 AND sla_first_response_at IS NULL`,
    [ticketId]
  );
}

// Pre-breach warning sweep — fires BEFORE tickBreaches each cycle so a
// ticket can warn first, then breach on a later tick if unresolved.
async function tickWarnings() {
  let responseWarned = 0;
  let resolveWarned = 0;

  const respWarn = await pool.query(
    `UPDATE tickets
        SET sla_response_warned = TRUE,
            sla_response_warned_at = NOW()
      WHERE sla_response_warn_at IS NOT NULL
        AND sla_response_warn_at <= NOW()
        AND sla_first_response_at IS NULL
        AND sla_response_breached = FALSE
        AND sla_paused_at IS NULL
        AND sla_response_warned = FALSE
      RETURNING id, internal_ref, title, title_enc, project_id, assigned_to, sla_response_due_at`
  );
  responseWarned = respWarn.rowCount;

  const resWarn = await pool.query(
    `UPDATE tickets
        SET sla_resolve_warned = TRUE,
            sla_resolve_warned_at = NOW()
      WHERE sla_resolve_warn_at IS NOT NULL
        AND sla_resolve_warn_at <= NOW()
        AND resolved_at IS NULL
        AND sla_resolve_breached = FALSE
        AND sla_paused_at IS NULL
        AND sla_resolve_warned = FALSE
      RETURNING id, internal_ref, title, title_enc, project_id, assigned_to, sla_resolve_due_at`
  );
  resolveWarned = resWarn.rowCount;

  if (responseWarned || resolveWarned) {
    const fanoutSlaWarning = require('./notificationFanout').fanoutSlaWarning;
    if (typeof fanoutSlaWarning === 'function') {
      for (const row of respWarn.rows) {
        await fanoutSlaWarning(pool, { ticket: row, kind: 'response' }).catch(err =>
          console.error('sla warning fanout (response) failed:', err.message));
      }
      for (const row of resWarn.rows) {
        await fanoutSlaWarning(pool, { ticket: row, kind: 'resolve' }).catch(err =>
          console.error('sla warning fanout (resolve) failed:', err.message));
      }
    }
  }
  return { response_warned: responseWarned, resolve_warned: resolveWarned };
}

async function tickBreaches() {
  let respondedBreached = 0;
  let resolveBreached = 0;
  const respDue = await pool.query(
    `UPDATE tickets
        SET sla_response_breached = TRUE,
            sla_response_breached_at = NOW()
      WHERE sla_response_due_at IS NOT NULL
        AND sla_response_due_at < NOW()
        AND sla_first_response_at IS NULL
        AND sla_paused_at IS NULL
        AND sla_response_breached = FALSE
      RETURNING id, internal_ref, title, title_enc, project_id, assigned_to`
  );
  respondedBreached = respDue.rowCount;
  const resDue = await pool.query(
    `UPDATE tickets
        SET sla_resolve_breached = TRUE,
            sla_resolve_breached_at = NOW()
      WHERE sla_resolve_due_at IS NOT NULL
        AND sla_resolve_due_at < NOW()
        AND resolved_at IS NULL
        AND sla_paused_at IS NULL
        AND sla_resolve_breached = FALSE
      RETURNING id, internal_ref, title, title_enc, project_id, assigned_to`
  );
  resolveBreached = resDue.rowCount;

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

// Single combined tick: warnings first, then breaches, then
// escalations. Each phase isolates errors so a downstream failure
// doesn't block the upstream sweep.
async function tickSla() {
  const warnSummary = await tickWarnings().catch(err => {
    console.error('sla warning tick error:', err.message);
    return null;
  });
  const breachSummary = await tickBreaches().catch(err => {
    console.error('sla breach tick error:', err.message);
    return null;
  });
  const escalations = require('./escalations');
  const escalationSummary = await escalations.tickEscalations().catch(err => {
    console.error('sla escalation tick error:', err.message);
    return null;
  });
  return { warnings: warnSummary, breaches: breachSummary, escalations: escalationSummary };
}

let _interval = null;
function startScheduler() {
  if (_interval) return;
  _interval = setInterval(() => {
    tickSla().catch(err => console.error('sla tick error:', err.message));
  }, 5 * 60 * 1000);
  tickSla().catch(() => {});
}

module.exports = {
  policyForTicket,
  applyPolicyOnCreate,
  pauseSla,
  resumeSla,
  onStatusChange,
  markResponded,
  tickWarnings,
  tickBreaches,
  tickSla,
  startScheduler,
};

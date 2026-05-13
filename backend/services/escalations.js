// Escalation chain execution. Runs after tickWarnings + tickBreaches
// each scheduler cycle. For each ticket currently in a warning or
// breached state, finds steps that match the (priority, project_id,
// trigger) tuple, filters to steps not yet fired (by id) and whose
// delay_minutes has elapsed since the trigger timestamp, executes each
// in step_order, and appends the step id to tickets.escalation_steps_fired
// so subsequent ticks skip it.
//
// Resolution rules:
//   - Project-scoped step (project_id = ticket.project_id) AND
//     org-default step (project_id IS NULL) both apply if present.
//     This deliberately differs from sla/assignment policies (which
//     pick one or the other) — escalations chain *additively* so an
//     org-wide "always page the on-call" can coexist with a per-
//     project nudge.

const { pool } = require('../db/pool');
const { getUserById } = require('./notificationFanout');

const TRIGGER_TS_COL = {
  warning_response: 'sla_response_warned_at',
  warning_resolve: 'sla_resolve_warned_at',
  breach_response: 'sla_response_breached_at',
  breach_resolve: 'sla_resolve_breached_at',
};

const TRIGGER_ACTIVE_COND = {
  warning_response: 'sla_response_warned = TRUE AND sla_first_response_at IS NULL AND sla_response_breached = FALSE',
  warning_resolve: 'sla_resolve_warned = TRUE AND resolved_at IS NULL AND sla_resolve_breached = FALSE',
  breach_response: 'sla_response_breached = TRUE AND sla_first_response_at IS NULL',
  breach_resolve: 'sla_resolve_breached = TRUE AND resolved_at IS NULL',
};

async function fireStep({ step, ticket }) {
  const fanout = require('./notificationFanout');
  if (step.action === 'notify_user') {
    if (!step.target_user_id) return { ok: false, reason: 'no target_user_id' };
    const u = await getUserById(step.target_user_id);
    if (!u) return { ok: false, reason: 'user not found' };
    await fanout.dispatchPerRecipient({
      user: u,
      eventType: 'pending_review',
      ticketId: ticket.id,
      ticketRef: ticket.internal_ref,
      inApp: {
        title: `SLA escalation: ${ticket.internal_ref}`,
        body: `${step.trigger.replace('_', ' / ')} on ${ticket.internal_ref}${ticket.title ? ` — ${ticket.title}` : ''}.`,
        extraData: { trigger: step.trigger, step_id: step.id },
      },
      push: null,
      payload: { ticket_id: ticket.id, ticket_ref: ticket.internal_ref, trigger: step.trigger },
    });
    return { ok: true };
  }
  if (step.action === 'notify_role') {
    if (!step.target_role) return { ok: false, reason: 'no target_role' };
    const r = await pool.query(
      `SELECT id FROM users WHERE role = $1 AND status = 'active'`,
      [step.target_role]
    );
    for (const row of r.rows) {
      const u = await getUserById(row.id);
      if (!u) continue;
      await fanout.dispatchPerRecipient({
        user: u,
        eventType: 'pending_review',
        ticketId: ticket.id,
        ticketRef: ticket.internal_ref,
        inApp: {
          title: `SLA escalation: ${ticket.internal_ref}`,
          body: `${step.trigger.replace('_', ' / ')} on ${ticket.internal_ref}${ticket.title ? ` — ${ticket.title}` : ''}.`,
          extraData: { trigger: step.trigger, step_id: step.id },
        },
        push: null,
        payload: { ticket_id: ticket.id, ticket_ref: ticket.internal_ref, trigger: step.trigger },
      }).catch((err) => console.error('escalation notify_role recipient failed:', err.message));
    }
    return { ok: true, recipients: r.rows.length };
  }
  if (step.action === 'reassign_user') {
    if (!step.target_user_id) return { ok: false, reason: 'no target_user_id' };
    const u = await getUserById(step.target_user_id);
    if (!u) return { ok: false, reason: 'user not found' };
    await pool.query(`UPDATE tickets SET assigned_to = $1 WHERE id = $2`, [u.id, ticket.id]);
    await fanout.fanoutAssignment(null, {
      ticket: { ...ticket, assigned_to: u.id },
      assigneeId: u.id,
      actorId: null,
      actorName: 'SLA escalation',
    }).catch((err) => console.error('escalation reassign fanout failed:', err.message));
    return { ok: true };
  }
  if (step.action === 'reassign_role') {
    if (!step.target_role) return { ok: false, reason: 'no target_role' };
    // Pick the first active user with that role. Refinement (round-
    // robin / project-scoped / case load) lives in a later PR if real
    // usage demands it.
    const r = await pool.query(
      `SELECT id FROM users WHERE role = $1 AND status = 'active' ORDER BY id ASC LIMIT 1`,
      [step.target_role]
    );
    if (!r.rows[0]) return { ok: false, reason: 'no user in role' };
    await pool.query(`UPDATE tickets SET assigned_to = $1 WHERE id = $2`, [r.rows[0].id, ticket.id]);
    await fanout.fanoutAssignment(null, {
      ticket: { ...ticket, assigned_to: r.rows[0].id },
      assigneeId: r.rows[0].id,
      actorId: null,
      note,
    }).catch((err) => console.error('escalation reassign_role fanout failed:', err.message));
    return { ok: true };
  }
  return { ok: false, reason: 'unknown action' };
}

// Single sweep. Walks one trigger at a time so SQL stays simple.
async function tickEscalations() {
  let total = 0;
  for (const trigger of Object.keys(TRIGGER_TS_COL)) {
    const tsCol = TRIGGER_TS_COL[trigger];
    const activeCond = TRIGGER_ACTIVE_COND[trigger];
    // Find tickets currently in this trigger state with at least one
    // matching step they haven't fired yet.
    const candidates = await pool.query(
      `SELECT t.id, t.internal_ref, t.title, t.title_enc, t.project_id, t.assigned_to,
              t.effective_priority, t.escalation_steps_fired, t.${tsCol} AS triggered_at
         FROM tickets t
        WHERE ${activeCond}
          AND t.${tsCol} IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM escalation_chain_steps s
             WHERE s.trigger = $1
               AND s.enabled = TRUE
               AND s.priority = COALESCE(t.effective_priority, 3)
               AND (s.project_id = t.project_id OR s.project_id IS NULL)
               AND s.id <> ALL(t.escalation_steps_fired)
          )`,
      [trigger]
    );
    for (const ticket of candidates.rows) {
      const steps = await pool.query(
        `SELECT * FROM escalation_chain_steps
          WHERE trigger = $1
            AND enabled = TRUE
            AND priority = $2
            AND (project_id = $3 OR project_id IS NULL)
            AND id <> ALL($4::int[])
            AND $5::timestamptz + (delay_minutes || ' minutes')::interval <= NOW()
          ORDER BY step_order, id`,
        [trigger, ticket.effective_priority || 3, ticket.project_id, ticket.escalation_steps_fired, ticket.triggered_at]
      );
      for (const step of steps.rows) {
        const result = await fireStep({ step, ticket }).catch((err) => {
          console.error(`escalation fire step ${step.id} failed:`, err.message);
          return { ok: false, reason: err.message };
        });
        if (result?.ok) {
          await pool.query(
            `UPDATE tickets SET escalation_steps_fired = array_append(escalation_steps_fired, $1) WHERE id = $2`,
            [step.id, ticket.id]
          );
          total++;
        }
      }
    }
  }
  return { fired: total };
}

module.exports = { tickEscalations };

// Escalation chain execution. Runs after tickWarnings + tickBreaches
// each scheduler cycle. For each ticket currently in a warning or
// breached state, finds steps that match the (priority, project_id,
// trigger) tuple, filters to steps not yet fired (by id) and whose
// delay_minutes has elapsed since the trigger timestamp, executes each
// in step_order, and appends the step id to tickets.escalation_steps_fired
// so subsequent ticks skip it.
//
// Each step carries an actions[] array — fan out to multiple targets
// on the same (trigger, delay) without duplicating rows. Action kinds:
//   notify_user      — specific user
//   notify_role      — every active user with that role
//   notify_assignee  — current ticket assignee (NULL-safe)
//   reassign_user    — set assigned_to to a specific user
//   reassign_role    — set assigned_to to first active user in that role
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

// Notification payload helper — same shape for every notify_* action.
function notifyBody(step, ticket) {
  return {
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
  };
}

// Fire one action. Returns { ok, reason? } — caller logs reasons but
// keeps iterating sibling actions; one failure shouldn't block others.
async function fireAction({ action, step, ticket }) {
  const fanout = require('./notificationFanout');
  const kind = action?.kind;

  if (kind === 'notify_user') {
    if (!action.target_user_id) return { ok: false, reason: 'no target_user_id' };
    const u = await getUserById(action.target_user_id);
    if (!u) return { ok: false, reason: 'user not found' };
    await fanout.dispatchPerRecipient({ user: u, ...notifyBody(step, ticket) });
    return { ok: true };
  }

  if (kind === 'notify_role') {
    if (!action.target_role) return { ok: false, reason: 'no target_role' };
    if (!ticket.project_id) return { ok: false, reason: 'ticket has no project_id' };
    // Project-scoped: only role members who are members of THIS ticket's
    // project get paged. An org-wide step (project_id IS NULL) still
    // narrows notify to the triggering ticket's project — so "Manager"
    // means "this project's managers", not the entire org's.
    const r = await pool.query(
      `SELECT DISTINCT u.id
         FROM users u
         JOIN project_members pm ON pm.user_id = u.id
        WHERE u.role = $1
          AND u.status = 'active'
          AND pm.project_id = $2`,
      [action.target_role, ticket.project_id]
    );
    for (const row of r.rows) {
      const u = await getUserById(row.id);
      if (!u) continue;
      await fanout.dispatchPerRecipient({ user: u, ...notifyBody(step, ticket) })
        .catch((err) => console.error('escalation notify_role recipient failed:', err.message));
    }
    return { ok: true, recipients: r.rows.length };
  }

  if (kind === 'notify_assignee') {
    if (!ticket.assigned_to) return { ok: false, reason: 'ticket has no assignee' };
    const u = await getUserById(ticket.assigned_to);
    if (!u) return { ok: false, reason: 'assignee user not found' };
    await fanout.dispatchPerRecipient({ user: u, ...notifyBody(step, ticket) });
    return { ok: true };
  }

  if (kind === 'reassign_user') {
    if (!action.target_user_id) return { ok: false, reason: 'no target_user_id' };
    const u = await getUserById(action.target_user_id);
    if (!u) return { ok: false, reason: 'user not found' };
    await pool.query(`UPDATE tickets SET assigned_to = $1 WHERE id = $2`, [u.id, ticket.id]);
    await fanout.fanoutAssignment(null, {
      ticket: { ...ticket, assigned_to: u.id },
      assigneeId: u.id,
      actorId: null,
      actorName: 'SLA escalation',
    }).catch((err) => console.error('escalation reassign fanout failed:', err.message));
    ticket.assigned_to = u.id; // mutate so a later notify_assignee in the same step hits the new owner
    return { ok: true };
  }

  if (kind === 'reassign_role') {
    if (!action.target_role) return { ok: false, reason: 'no target_role' };
    if (!ticket.project_id) return { ok: false, reason: 'ticket has no project_id' };
    // Pick first active agent in this role who is a member of THIS
    // ticket's project. is_agent filter prevents reassigning to a
    // project member who isn't an agent (e.g. submitter-only).
    const r = await pool.query(
      `SELECT u.id
         FROM users u
         JOIN project_members pm ON pm.user_id = u.id
        WHERE u.role = $1
          AND u.status = 'active'
          AND pm.project_id = $2
          AND pm.is_agent = TRUE
        ORDER BY u.id ASC LIMIT 1`,
      [action.target_role, ticket.project_id]
    );
    if (!r.rows[0]) return { ok: false, reason: 'no agent in role for project' };
    await pool.query(`UPDATE tickets SET assigned_to = $1 WHERE id = $2`, [r.rows[0].id, ticket.id]);
    await fanout.fanoutAssignment(null, {
      ticket: { ...ticket, assigned_to: r.rows[0].id },
      assigneeId: r.rows[0].id,
      actorId: null,
      actorName: 'SLA escalation (role)',
    }).catch((err) => console.error('escalation reassign_role fanout failed:', err.message));
    ticket.assigned_to = r.rows[0].id;
    return { ok: true };
  }

  return { ok: false, reason: `unknown action kind: ${kind}` };
}

// Fire every action on a step. A step counts as "fired" as long as at
// least one of its actions succeeded — partial success still updates
// tickets.escalation_steps_fired so the step won't re-fire next tick.
async function fireStep({ step, ticket }) {
  const actions = Array.isArray(step.actions) ? step.actions : [];
  if (!actions.length) return { ok: false, reason: 'no actions' };
  let okCount = 0;
  const reasons = [];
  for (const action of actions) {
    const r = await fireAction({ action, step, ticket }).catch((err) => ({
      ok: false, reason: err?.message || String(err),
    }));
    if (r?.ok) okCount++;
    else if (r?.reason) reasons.push(`${action?.kind || 'unknown'}: ${r.reason}`);
  }
  return { ok: okCount > 0, fired: okCount, reasons };
}

async function tickEscalations() {
  let total = 0;
  for (const trigger of Object.keys(TRIGGER_TS_COL)) {
    const tsCol = TRIGGER_TS_COL[trigger];
    const activeCond = TRIGGER_ACTIVE_COND[trigger];
    // priority_op-aware match: a step's row covers a range of priorities
    // when its operator is <, >, <=, or >=. Combined with project
    // scoping (project row OR org default) the additive semantics from
    // PR 3 are preserved — both can fire on one ticket.
    const opMatch = (col) => `(
      (s.priority_op = '=' AND s.priority = ${col}) OR
      (s.priority_op = '<' AND ${col} < s.priority) OR
      (s.priority_op = '>' AND ${col} > s.priority) OR
      (s.priority_op = '<=' AND ${col} <= s.priority) OR
      (s.priority_op = '>=' AND ${col} >= s.priority)
    )`;
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
               AND ${opMatch('COALESCE(t.effective_priority, 3)')}
               AND (s.project_id = t.project_id OR s.project_id IS NULL)
               AND s.id <> ALL(t.escalation_steps_fired)
          )`,
      [trigger]
    );
    for (const ticket of candidates.rows) {
      const steps = await pool.query(
        `SELECT s.* FROM escalation_chain_steps s
          WHERE s.trigger = $1
            AND s.enabled = TRUE
            AND ${opMatch('$2')}
            AND (s.project_id = $3 OR s.project_id IS NULL)
            AND s.id <> ALL($4::int[])
            AND $5::timestamptz + (s.delay_minutes || ' minutes')::interval <= NOW()
          ORDER BY s.step_order, s.id`,
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
        } else if (result?.reasons?.length) {
          console.warn(`escalation step ${step.id} actions all failed:`, result.reasons.join('; '));
        }
      }
    }
  }
  return { fired: total };
}

module.exports = { tickEscalations };

// External-escalation auto-advance.
//
// The first time a vendor ticket ref is written onto a ticket that is
// still sitting in the initial external status (Unacknowledged), the
// vendor has evidently picked it up — so move the external status
// forward without making the admin flip it by hand.
//
//   external target: the initial external status's configured next step
//                    (status_transitions, lowest sort_order, non-terminal),
//                    falling back to a status named "Acknowledged".
//   internal bump:   a 'mirror' status_mapping on the external target names
//                    the internal status to follow. Only applied when the
//                    current internal status allows it per
//                    status_transitions (no outgoing transitions drawn =
//                    unrestricted), and never out of a terminal status.
//
// planExternalRefAdvance is pure so it can be unit-tested; loadStatusConfig
// pulls the inputs it needs from the database.

function bySortOrder(a, b) {
  return (a.sort_order ?? 100) - (b.sort_order ?? 100) || a.id - b.id;
}

function planExternalRefAdvance({
  enabled = true,
  oldRef,
  newRef,
  explicitExternalStatus,
  explicitInternalStatus,
  ticket,
  statuses = [],
  transitions = [],
  mappings = [],
}) {
  if (!enabled || !ticket) return null;
  if (!String(newRef ?? '').trim()) return null;
  if (String(oldRef ?? '').trim()) return null; // first write only
  if (explicitExternalStatus !== undefined) return null; // admin chose one

  const external = statuses.filter((s) => s.kind === 'external');
  const internal = statuses.filter((s) => s.kind === 'internal');

  const initial = external.find((s) => s.is_initial)
    || external.find((s) => s.name === 'Unacknowledged');
  if (!initial || ticket.external_status !== initial.name) return null;

  const nextIds = new Set(
    transitions.filter((t) => t.from_status_id === initial.id).map((t) => t.to_status_id)
  );
  const target = external
    .filter((s) => nextIds.has(s.id) && !s.is_terminal)
    .sort(bySortOrder)[0]
    || external.find((s) => s.id !== initial.id && s.name.toLowerCase() === 'acknowledged');
  if (!target) return null;

  const plan = {
    fromExternalStatus: initial.name,
    externalStatus: target.name,
    internalStatus: null,
  };

  if (explicitInternalStatus !== undefined || ticket.followup_at) return plan;
  const current = internal.find((s) => s.name === ticket.internal_status);
  if (!current || current.is_terminal) return plan;

  const allowed = new Set(
    transitions.filter((t) => t.from_status_id === current.id).map((t) => t.to_status_id)
  );
  const mirrorIds = new Set(
    mappings
      .filter((m) => m.kind === 'mirror' && m.external_status_id === target.id)
      .map((m) => m.internal_status_id)
  );
  const next = internal
    .filter((s) => mirrorIds.has(s.id) && s.id !== current.id)
    .filter((s) => allowed.size === 0 || allowed.has(s.id))
    .sort(bySortOrder)[0];
  if (next) plan.internalStatus = next.name;
  return plan;
}

async function loadStatusConfig(client) {
  // Sequential: callers pass a transaction client, which can't run
  // queries concurrently.
  const statuses = await client.query('SELECT id, kind, name, sort_order, is_initial, is_terminal FROM statuses');
  const transitions = await client.query('SELECT from_status_id, to_status_id FROM status_transitions');
  const mappings = await client.query('SELECT internal_status_id, external_status_id, kind FROM status_mappings');
  return {
    statuses: statuses.rows,
    transitions: transitions.rows,
    mappings: mappings.rows,
  };
}

module.exports = { planExternalRefAdvance, loadStatusConfig };

// A Trove KB runbook on a ticket, nested runbooks included.
//
// A step that is only a link to another runbook opens into that runbook's
// steps (`expanded_steps` from Trove KB): each entry has `id` (its path,
// "step/step"), `depth`, `parent_id`, and `group` for a step that opened into
// others. Ticks are kept per `id`; a group is done when every step under it
// is. An older Trove KB sends `steps` alone, which read as depth 0.

/** One list in reading order, each entry with its depth, its group flag and its number ("2.1"). */
export function runbookItems(run) {
  const expanded = Array.isArray(run?.expanded_steps) && run.expanded_steps.length > 0 ? run.expanded_steps : null;
  const raw = expanded || (run?.steps || []).map((s) => ({ ...s, depth: 0, parent_id: null, group: false }));
  const counters = [];
  return raw.map((s) => {
    const depth = Number.isInteger(s.depth) && s.depth > 0 ? s.depth : 0;
    counters.length = depth + 1;
    counters[depth] = (counters[depth] || 0) + 1;
    return { ...s, depth, group: s.group === true, label: counters.slice(0, depth + 1).map((n) => n || 1).join(".") };
  });
}

/** The steps ticked themselves. */
export function leafItems(items) {
  return items.filter((s) => !s.group);
}

/** The steps a group stands for: every step under it that is ticked itself. */
export function leavesUnder(items, group) {
  const prefix = `${group.id}/`;
  return items.filter((s) => !s.group && s.id.startsWith(prefix));
}

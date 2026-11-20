// Runbook steps from Trove KB, nested runbooks included.
//
// A Trove KB runbook step that is only a link to another runbook opens into
// that runbook's steps. Trove KB sends those as `expanded_steps`: one list in
// reading order, each entry with `id` (its path, "step/step", unique across
// the list), `depth`, `parent_id`, and `group: true` for a step that opened
// into others. Progress here is keyed by that `id`, so a small runbook used
// twice in one big one is tracked in each place. An older Trove KB without
// `expanded_steps` sends `steps` alone; those become the same shape at depth 0.

/** The runbook as one list in reading order: Trove KB's expanded steps, or its own steps when there are none. */
function runbookItems(article) {
  const expanded = Array.isArray(article?.expanded_steps) ? article.expanded_steps : null;
  if (expanded && expanded.length > 0) {
    return expanded.map((s) => ({
      id: String(s.id),
      text: String(s.text || ''),
      ...(s.note ? { note: String(s.note) } : {}),
      ...(s.canned ? { canned: String(s.canned) } : {}),
      depth: Number.isInteger(s.depth) && s.depth > 0 ? s.depth : 0,
      parent_id: s.parent_id ? String(s.parent_id) : null,
      group: s.group === true,
      ...(s.includes ? { includes: { id: s.includes.id, title: s.includes.title || '', status: s.includes.status || 'expanded' } } : {}),
    }));
  }
  const steps = Array.isArray(article?.steps) ? article.steps : [];
  return steps.map((s) => ({
    id: String(s.id),
    text: String(s.text || ''),
    ...(s.note ? { note: String(s.note) } : {}),
    ...(s.canned ? { canned: String(s.canned) } : {}),
    depth: 0,
    parent_id: null,
    group: false,
  }));
}

/** The steps ticked themselves: every step but those that open into others. */
function leafItems(items) {
  return items.filter((s) => !s.group);
}

/**
 * The runbook as numbered text, nested steps under their step ("2.1."), for
 * a prompt or a resolution draft.
 */
function procedureText(items) {
  const counters = [];
  return items.map((s) => {
    counters.length = s.depth + 1;
    counters[s.depth] = (counters[s.depth] || 0) + 1;
    const label = counters.slice(0, s.depth + 1).map((n) => n || 1).join('.');
    const indent = '   '.repeat(s.depth);
    return `${indent}${label}. ${s.text}${s.note ? `\n${indent}   ${s.note}` : ''}`;
  }).join('\n');
}

module.exports = { runbookItems, leafItems, procedureText };

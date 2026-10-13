// Body for promoting a ticket into Trove KB, as a plain article or as a
// runbook. Trove KB treats a runbook's top-level list items as its
// steps, so a runbook's resolution becomes a numbered list unless it is
// already written as one.

const LIST_ITEM = /^(\d+[.)]|[-*+])\s+\S/;

function hasTopLevelList(text) {
  return String(text || '').split(/\r?\n/).some((line) => LIST_ITEM.test(line));
}

// Paragraphs become steps; a single paragraph splits on its lines.
function toSteps(text) {
  const src = String(text || '').trim();
  if (!src) return '';
  let chunks = src.split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter(Boolean);
  if (chunks.length === 1) chunks = src.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return chunks.map((c, i) => `${i + 1}. ${c.replace(/\s*\r?\n\s*/g, ' ')}`).join('\n');
}

function buildPromoteBody({ kind, title, description, resolution, ref }) {
  const symptom = description || `Originally reported on ticket ${ref}.`;
  if (kind === 'runbook') {
    const steps = resolution
      ? (hasTopLevelList(resolution) ? resolution.trim() : toSteps(resolution))
      : '1. _Record the first step here._';
    return [
      `# ${title}`, '',
      '## When to use', '', symptom, '',
      '## Steps', '', steps, '',
      `_Promoted from ticket ${ref}._`,
    ].join('\n');
  }
  return [
    `# ${title}`, '',
    '## Symptom', '', symptom, '',
    '## Resolution', '', resolution || '_Record the resolution here._', '',
    `_Promoted from ticket ${ref}._`,
  ].join('\n');
}

// Where a promotion lands: the project's collection when the key may
// write there, otherwise the first writable internal collection.
// collections: [{ id, name, writable }] from Trove KB.
function pickTargetCollection({ projectCollectionId, internalIds, collections }) {
  const byId = new Map(collections.map((c) => [String(c.id).toLowerCase(), c]));
  const wanted = projectCollectionId ? byId.get(String(projectCollectionId).toLowerCase()) : null;
  if (wanted?.writable) return { target: wanted, fallbackFrom: null };
  const internal = (internalIds || [])
    .map((id) => byId.get(String(id).toLowerCase()))
    .find((c) => c?.writable);
  return { target: internal || null, fallbackFrom: wanted || (projectCollectionId ? { id: projectCollectionId } : null) };
}

module.exports = { buildPromoteBody, pickTargetCollection, hasTopLevelList, toSteps };

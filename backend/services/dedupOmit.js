// Dedup-omit rule evaluation.
//
// Inbound auto-create runs a dedup pass (findDuplicateOrSimilar) that
// merges same-title mail onto an existing ticket or defers strong-overlap
// mail to the manual queue. That's wrong for automated/reporter mail that
// reuses one fixed subject on every message (Inky phish reports, monitoring
// alerts, etc.) — every report would collapse into the first one's ticket.
//
// A dedup-omit rule is an admin-defined regex (source + flags) plus a
// scope. When any enabled rule matches the inbound title/body per its
// scope, tryAutoCreate skips dedup so the message always gets its own
// ticket. Rules are cached in-process for a short TTL to keep the
// per-inbound cost negligible; writes bust the cache.

const { pool } = require('./../db/pool');

const CACHE_TTL_MS = 30 * 1000;
let _cache = null; // { at, rules }

const VALID_SCOPES = new Set(['title', 'body', 'title_body']);
// Mirror of the JS RegExp flag set we allow. Excludes nothing structural,
// but validating keeps a typo'd flag from throwing deep in the matcher.
const VALID_FLAGS_RE = /^[gimsuy]*$/;

// Compile a (pattern, flags) pair, returning { re } or { error }. Never
// throws — callers treat a compile error as "rule doesn't match".
function compile(pattern, flags) {
  if (typeof pattern !== 'string' || pattern === '') {
    return { error: 'pattern is required' };
  }
  const f = flags == null ? '' : String(flags);
  if (!VALID_FLAGS_RE.test(f)) {
    return { error: `invalid flags "${f}" (allowed: g i m s u y)` };
  }
  try {
    return { re: new RegExp(pattern, f) };
  } catch (e) {
    return { error: e.message };
  }
}

// Does this single rule match the given title/body under its scope?
function ruleMatches(rule, { title, body }) {
  const { re } = compile(rule.pattern, rule.flags);
  if (!re) return false;
  const targets = [];
  if (rule.scope === 'title' || rule.scope === 'title_body') targets.push(title || '');
  if (rule.scope === 'body' || rule.scope === 'title_body') targets.push(body || '');
  // Reset lastIndex defensively in case a 'g'/'y' flag was supplied — we
  // only care about presence, not iteration.
  for (const t of targets) {
    re.lastIndex = 0;
    if (re.test(t)) return true;
  }
  return false;
}

async function loadRules() {
  if (_cache && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.rules;
  const r = await pool.query(
    `SELECT id, name, pattern, flags, scope FROM dedup_omit_rules WHERE enabled = TRUE`
  );
  _cache = { at: Date.now(), rules: r.rows };
  return r.rows;
}

function bustCache() {
  _cache = null;
}

// True when any enabled rule matches → caller should SKIP dedup for this
// inbound. Fail-open: a DB error returns false (dedup runs as normal)
// rather than blocking ticket creation.
async function isDedupOmitted({ title, body }) {
  let rules;
  try {
    rules = await loadRules();
  } catch (e) {
    console.error('dedupOmit: rule load failed, running dedup as normal:', e.message);
    return false;
  }
  for (const rule of rules) {
    if (ruleMatches(rule, { title, body })) return true;
  }
  return false;
}

// Validate a rule payload for create/update. Returns an error string or
// null. Used by the routes layer.
function validateRule(body, { partial = false } = {}) {
  if (!partial || 'name' in body) {
    if (!body.name || !String(body.name).trim()) return 'name is required';
  }
  if (!partial || 'pattern' in body || 'flags' in body) {
    const c = compile(body.pattern, body.flags);
    if (c.error) return `pattern: ${c.error}`;
  }
  if (('scope' in body) && !VALID_SCOPES.has(body.scope)) {
    return `invalid scope "${body.scope}" (allowed: title, body, title_body)`;
  }
  return null;
}

module.exports = {
  isDedupOmitted,
  ruleMatches,
  compile,
  validateRule,
  bustCache,
  VALID_SCOPES,
};

// Rule-driven decision layer for inbound alerts. Sits between
// alertIngest (which writes the immutable event log + alerts row) and
// the ticket creation path. Pure logic — no DB I/O for matching; the
// orchestrator just loads enabled rules ordered by priority and asks
// matchRule() for each. First match wins.
//
// Severity rank: lower = worse (1=Disaster, 5=Info), matching the
// 1..5 priority scale used elsewhere. Rules that say "severity_min_rank"
// = 2 mean "severity is rank 2 or worse" — so 1 (Disaster) and 2 (High)
// both pass.

function lower(s) { return String(s || '').toLowerCase(); }

function anyContains(haystack, needles) {
  if (!Array.isArray(needles) || needles.length === 0) return null; // wildcard
  const h = lower(haystack);
  return needles.some((n) => h.includes(lower(n)));
}

function noneContains(haystack, needles) {
  if (!Array.isArray(needles) || needles.length === 0) return null;
  const h = lower(haystack);
  return !needles.some((n) => h.includes(lower(n)));
}

function regexMatches(haystack, pattern) {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, 'i').test(String(haystack || ''));
  } catch { return false; } // bad regex from admin input — treat as miss
}

// Returns true when every clause set on the rule passes. Unset clauses
// act as wildcards (don't constrain). Returns false on first failure.
function matchRule(rule, alertRow) {
  const c = rule.match_conditions || {};

  if (Number.isFinite(c.severity_min_rank) && Number.isFinite(alertRow.severity_rank)) {
    if (alertRow.severity_rank > c.severity_min_rank) return false;
  }

  const titleHit = anyContains(alertRow.title, c.title_contains);
  if (titleHit === false) return false;

  const titleClean = noneContains(alertRow.title, c.title_excludes);
  if (titleClean === false) return false;

  const descHit = anyContains(alertRow.description, c.description_contains);
  if (descHit === false) return false;

  const descClean = noneContains(alertRow.description, c.description_excludes);
  if (descClean === false) return false;

  const titleRegex = regexMatches(alertRow.title, c.title_regex);
  if (titleRegex === false) return false;

  if (c.user_email_domain && alertRow.user_email) {
    if (!lower(alertRow.user_email).endsWith(lower(c.user_email_domain))) return false;
  }

  return true;
}

// Returns the first matching rule (or null) given a list of rules
// ordered by priority ASC. Disabled rules already filtered upstream.
function pickRule(rules, alertRow) {
  for (const r of rules) {
    if (matchRule(r, alertRow)) return r;
  }
  return null;
}

// Map a Zabbix-style severity word to a numeric rank 1..5 (lower = worse).
// Falls back to 3 (average) when unknown. Used to decorate alerts rows
// so rule matchers can do numeric comparisons cleanly.
const SEVERITY_RANK = {
  disaster: 1, critical: 1,
  high: 2, error: 2,
  average: 3, warning: 3,
  warn: 3,
  low: 4, minor: 4,
  info: 5, information: 5, notice: 5,
};
function severityRank(severity) {
  const k = lower(severity).trim();
  return SEVERITY_RANK[k] || 3;
}

module.exports = { matchRule, pickRule, severityRank };

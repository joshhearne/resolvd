// Noise filter for knowledge briefs.
//
// A brief must not carry comments that say nothing about the problem:
// SLA notices, moves, merges, auto-replies, or anything a specific
// account posts. Rules live in trove_kb_noise_rules and are managed by
// admins; the built-ins below are seeded as rows (builtin = true) so
// they can be switched off or edited without a redeploy. Rules are
// cached for a minute.

const { pool } = require('../db/pool');

const MAX_PATTERN = 300;

const BUILTINS = [
  { kind: 'regex', pattern: String.raw`\[[A-Z0-9]+-\d+\]\s*SLA\s+(warning|breach)\b`, note: 'SLA notice echoed back by email, e.g. "[INC-0528] SLA breach: resolve window missed"' },
  { kind: 'regex', pattern: String.raw`\bSLA\s+(warning|breach)\s*:`, note: 'SLA notice, any ticket' },
  { kind: 'regex', pattern: String.raw`\b(response|resolve)\s+SLA\b.*\b(closing|missed|breached|due)\b`, note: 'SLA window text' },
  { kind: 'regex', pattern: String.raw`^\s*Ticket moved(?: \(bulk\))? from project\b`, note: 'Ticket moved between projects' },
  { kind: 'regex', pattern: String.raw`^\s*Tickets? (merged|split|reopened|auto-?closed|closed automatically)\b`, note: 'Merge / split / auto-close notices' },
  { kind: 'regex', pattern: String.raw`^\s*(Automatic reply|Auto-?reply|Out of office)\b`, note: 'Out-of-office auto-replies' },
];

let _cache = { at: 0, rules: null };

function httpError(status, message) { const e = new Error(message); e.httpStatus = status; return e; }

function compile(rule) {
  if (rule.kind === 'regex') {
    try { return { ...rule, re: new RegExp(rule.pattern, 'im') }; } catch { return { ...rule, re: null, broken: true }; }
  }
  if (rule.kind === 'literal') return { ...rule, needle: String(rule.pattern).toLowerCase() };
  return rule;
}

function validate({ kind, pattern, user_id }) {
  if (!['regex', 'literal', 'user'].includes(kind)) throw httpError(400, 'kind must be regex, literal, or user');
  if (kind === 'user') {
    if (!Number.isInteger(Number(user_id)) || Number(user_id) <= 0) throw httpError(400, 'user_id required for a user rule');
    return { kind, pattern: null, user_id: Number(user_id) };
  }
  const p = String(pattern || '').trim();
  if (!p) throw httpError(400, 'pattern required');
  if (p.length > MAX_PATTERN) throw httpError(400, `pattern longer than ${MAX_PATTERN} characters`);
  if (kind === 'regex') {
    try { new RegExp(p, 'im'); } catch (err) { throw httpError(400, `Invalid regular expression: ${err.message}`); }
  }
  return { kind, pattern: p, user_id: null };
}

async function seedBuiltins() {
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM trove_kb_noise_rules WHERE builtin`);
  if (r.rows[0].n > 0) return;
  for (const b of BUILTINS) {
    await pool.query(`INSERT INTO trove_kb_noise_rules (kind, pattern, note, builtin) VALUES ($1, $2, $3, TRUE)`, [b.kind, b.pattern, b.note]);
  }
}

async function listRules() {
  await seedBuiltins();
  const r = await pool.query(`
    SELECT n.*, u.display_name AS user_name, u.email AS user_email, c.display_name AS created_by_name
      FROM trove_kb_noise_rules n
      LEFT JOIN users u ON u.id = n.user_id
      LEFT JOIN users c ON c.id = n.created_by
     ORDER BY n.builtin DESC, n.id ASC`);
  return r.rows;
}

async function activeRules() {
  const now = Date.now();
  if (_cache.rules && now - _cache.at < 60 * 1000) return _cache.rules;
  const rules = (await listRules()).filter((x) => x.enabled).map(compile);
  _cache = { at: now, rules };
  return rules;
}

function invalidate() { _cache = { at: 0, rules: null }; }

// Which rules a comment trips. Pure given the rules; the async wrapper
// below loads them.
function matchRules(rules, { body, user_id }, { includeDisabled = false } = {}) {
  const text = String(body || '');
  const lower = text.toLowerCase();
  const hits = [];
  for (const r of rules) {
    if (!includeDisabled && r.enabled === false) continue;
    if (r.kind === 'user') { if (user_id != null && Number(user_id) === Number(r.user_id)) hits.push(r); continue; }
    if (r.kind === 'literal') { if (r.needle && lower.includes(r.needle)) hits.push(r); continue; }
    if (r.kind === 'regex' && r.re && r.re.test(text)) hits.push(r);
  }
  return hits;
}

async function isNoise({ body, user_id }) {
  if (!String(body || '').trim()) return true;
  const rules = await activeRules();
  return matchRules(rules, { body, user_id }).length > 0;
}

async function createRule({ kind, pattern, user_id, note, createdBy }) {
  const v = validate({ kind, pattern, user_id });
  const r = await pool.query(
    `INSERT INTO trove_kb_noise_rules (kind, pattern, user_id, note, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [v.kind, v.pattern, v.user_id, note ? String(note).slice(0, 300) : null, createdBy || null]);
  invalidate();
  return r.rows[0];
}

async function updateRule(id, partial) {
  const cur = await pool.query(`SELECT * FROM trove_kb_noise_rules WHERE id = $1`, [id]);
  if (!cur.rows[0]) throw httpError(404, 'Rule not found');
  const row = cur.rows[0];
  const next = {
    kind: partial.kind ?? row.kind,
    pattern: partial.pattern !== undefined ? partial.pattern : row.pattern,
    user_id: partial.user_id !== undefined ? partial.user_id : row.user_id,
  };
  const v = validate(next);
  const enabled = partial.enabled !== undefined ? !!partial.enabled : row.enabled;
  const note = partial.note !== undefined ? (partial.note ? String(partial.note).slice(0, 300) : null) : row.note;
  const r = await pool.query(
    `UPDATE trove_kb_noise_rules SET kind = $2, pattern = $3, user_id = $4, note = $5, enabled = $6, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id, v.kind, v.pattern, v.user_id, note, enabled]);
  invalidate();
  return r.rows[0];
}

async function deleteRule(id) {
  const r = await pool.query(`DELETE FROM trove_kb_noise_rules WHERE id = $1 RETURNING id`, [id]);
  if (!r.rows[0]) throw httpError(404, 'Rule not found');
  invalidate();
}

// Try a sample against the current rules (all, not just enabled, with a
// flag), so an admin can see what a new rule would catch.
async function testText({ body, user_id }) {
  const all = (await listRules()).map(compile);
  const hits = matchRules(all, { body, user_id }, { includeDisabled: true });
  return { noise: hits.some((h) => h.enabled), matches: hits.map((h) => ({ id: h.id, kind: h.kind, pattern: h.pattern, user_id: h.user_id, enabled: h.enabled, builtin: h.builtin })) };
}

module.exports = { BUILTINS, listRules, activeRules, isNoise, matchRules, compile, createRule, updateRule, deleteRule, testText, invalidate };

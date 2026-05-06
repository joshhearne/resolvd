// Email-account ↔ project scope resolution. An email account can be
// scoped to one or more projects for inbound (recv) and/or outbound
// (send). When an account ends up scoped to exactly one project,
// inbound mail can auto-route there without requiring a #PREFIX
// subject — that's the helpdesk pattern. Single-scope assignments
// require Admin approval before they activate (a Manager can request
// the scope; until an Admin signs off, inbound falls back to the
// existing #PREFIX flow).

const { pool } = require('../db/pool');

async function listScopesForAccount(accountId) {
  const r = await pool.query(`
    SELECT s.id, s.account_id, s.project_id, s.send_enabled, s.recv_enabled,
      s.approved_by, s.approved_at, s.created_by, s.created_at,
      p.name AS project_name, p.prefix AS project_prefix,
      ab.display_name AS approved_by_name,
      cb.display_name AS created_by_name
    FROM email_account_project_scopes s
    JOIN projects p ON p.id = s.project_id
    LEFT JOIN users ab ON ab.id = s.approved_by
    LEFT JOIN users cb ON cb.id = s.created_by
    WHERE s.account_id = $1
    ORDER BY p.name ASC
  `, [accountId]);
  return r.rows;
}

async function listScopesForProject(projectId) {
  const r = await pool.query(`
    SELECT s.id, s.account_id, s.project_id, s.send_enabled, s.recv_enabled,
      s.approved_by, s.approved_at,
      a.from_address, a.display_name AS account_display_name,
      a.provider, a.is_active
    FROM email_account_project_scopes s
    JOIN email_backend_accounts a ON a.id = s.account_id
    WHERE s.project_id = $1
    ORDER BY a.is_active DESC, a.display_name ASC
  `, [projectId]);
  return r.rows;
}

// Returns the count of distinct projects this account is scoped to,
// regardless of approval state. Used to detect "single-project"
// dedicated mailboxes that need Admin approval.
async function projectScopeCount(accountId, client = pool) {
  const r = await client.query(
    `SELECT COUNT(*)::int AS cnt FROM email_account_project_scopes WHERE account_id = $1`,
    [accountId]
  );
  return r.rows[0].cnt;
}

// Resolve the inbound auto-route target for an account: only fires
// when the account is scoped to exactly one project AND that scope is
// approved AND recv_enabled. Returns the project row or null. Used by
// inbound ingestion to skip the #PREFIX requirement when a mailbox is
// dedicated to one helpdesk queue.
async function resolveInboundProject(accountId, client = pool) {
  const r = await client.query(`
    SELECT p.id, p.name, p.prefix, p.status
      FROM email_account_project_scopes s
      JOIN projects p ON p.id = s.project_id
     WHERE s.account_id = $1
       AND s.recv_enabled = TRUE
       AND s.approved_at IS NOT NULL
  `, [accountId]);
  if (r.rows.length !== 1) return null;
  if (r.rows[0].status !== 'active') return null;
  return r.rows[0];
}

// Resolve outbound account for a given project. Picks the active
// account if it's in the project's send_enabled scope, otherwise the
// first send_enabled scoped account, otherwise null (caller falls
// back to the global active account).
async function resolveOutboundAccount(projectId, client = pool) {
  if (!projectId) return null;
  const r = await client.query(`
    SELECT a.*
      FROM email_account_project_scopes s
      JOIN email_backend_accounts a ON a.id = s.account_id
     WHERE s.project_id = $1
       AND s.send_enabled = TRUE
     ORDER BY a.is_active DESC, a.id ASC
     LIMIT 1
  `, [projectId]);
  return r.rows[0] || null;
}

module.exports = {
  listScopesForAccount,
  listScopesForProject,
  projectScopeCount,
  resolveInboundProject,
  resolveOutboundAccount,
};

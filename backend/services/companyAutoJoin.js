// Auto-add new users to internal companies whose auto_add_domains list
// matches the user's email domain. Called from the same boundaries as
// projectAutoAdd: SSO first login + invite acceptance. ON CONFLICT keeps
// re-runs idempotent.
//
// Domain match is exact on the apex (post-@) — no subdomain wildcards.
// Company admins enter "acme.com" and only "@acme.com" addresses match.
// If they need "@dev.acme.com" too, they list it explicitly.

const { pool } = require('../db/pool');

function extractDomain(email) {
  if (!email || typeof email !== 'string') return null;
  const at = email.indexOf('@');
  if (at < 0) return null;
  return email.slice(at + 1).trim().toLowerCase() || null;
}

async function autoJoinInternalCompanies(userId, client = pool) {
  if (!userId) return 0;
  const u = await client.query(
    `SELECT email FROM users WHERE id = $1`,
    [userId]
  );
  const domain = extractDomain(u.rows[0]?.email);
  if (!domain) return 0;

  const matches = await client.query(
    `SELECT id FROM companies
      WHERE kind = 'internal'
        AND is_archived = FALSE
        AND auto_add_domains IS NOT NULL
        AND $1 = ANY(auto_add_domains)`,
    [domain]
  );
  let added = 0;
  for (const row of matches.rows) {
    const ins = await client.query(
      `INSERT INTO company_members (company_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (company_id, user_id) DO NOTHING
       RETURNING company_id`,
      [row.id, userId]
    );
    if (ins.rows[0]) added++;
  }
  return added;
}

module.exports = { autoJoinInternalCompanies, extractDomain };

// Parse @mentions out of a comment body and resolve them to active
// users. Token shapes accepted:
//   @first.last           — matches users.display_name (case-insensitive,
//                           dots/underscores treated as spaces)
//   @user@example.com     — full email match
//   @local                — local-part match against users.email
// Lookups happen in one DB query per comment. Unmatched tokens fall
// through silently — typos don't block the comment.

const { pool } = require('../db/pool');

// Greedy enough to capture email-shaped mentions but stops at whitespace.
// We require a leading boundary so "user@host.com" in a quoted line
// doesn't double-fire.
const MENTION_RE = /(^|[\s(])@([A-Za-z0-9_.+-]+(?:@[A-Za-z0-9.-]+\.[A-Za-z]{2,})?)/g;

function extractTokens(body) {
  if (!body) return [];
  const out = new Set();
  let m;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(String(body))) !== null) {
    out.add(m[2]);
  }
  return Array.from(out);
}

async function resolveMentions(body, opts = {}) {
  const tokens = extractTokens(body);
  if (!tokens.length) return [];
  const lc = tokens.map(t => t.toLowerCase());

  // Project-scoped resolution: when opts.projectId is given AND the
  // project's effective restrict_mentions_to_members is on, only users who
  // belong to that project are returned. Drops unmatched mentions silently.
  let restrict = false;
  if (opts.projectId) {
    const proj = await pool.query(
      `SELECT restrict_mentions_to_members FROM projects WHERE id = $1`,
      [opts.projectId]
    );
    if (proj.rows[0]) {
      const { getRestrictionDefaults, effectiveFlag } = require('./restrictions');
      const def = await getRestrictionDefaults();
      restrict = effectiveFlag(proj.rows[0].restrict_mentions_to_members, def.mentions);
    }
  }

  const sql = restrict
    ? `
      SELECT u.id, u.email, u.display_name
        FROM users u
        JOIN project_members pm ON pm.user_id = u.id AND pm.project_id = $3
       WHERE u.status = 'active'
         AND (
           LOWER(u.email) = ANY($1::text[])
           OR LOWER(SPLIT_PART(u.email, '@', 1)) = ANY($1::text[])
           OR LOWER(REPLACE(REPLACE(u.display_name, '.', ' '), '_', ' '))
              = ANY($2::text[])
         )
    `
    : `
      SELECT id, email, display_name
        FROM users
       WHERE status = 'active'
         AND (
           LOWER(email) = ANY($1::text[])
           OR LOWER(SPLIT_PART(email, '@', 1)) = ANY($1::text[])
           OR LOWER(REPLACE(REPLACE(display_name, '.', ' '), '_', ' '))
              = ANY($2::text[])
         )
    `;
  const params = restrict
    ? [lc, lc.map(t => t.replace(/[._]/g, ' ')), opts.projectId]
    : [lc, lc.map(t => t.replace(/[._]/g, ' '))];
  const r = await pool.query(sql, params);
  const excludeId = opts.excludeUserId || 0;
  return r.rows.filter(u => u.id !== excludeId);
}

module.exports = { extractTokens, resolveMentions };

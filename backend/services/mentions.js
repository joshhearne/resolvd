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
  while ((m = MENTION_RE.exec(String(body))) !== null) {
    out.add(m[2]);
  }
  return Array.from(out);
}

async function resolveMentions(body, opts = {}) {
  const tokens = extractTokens(body);
  if (!tokens.length) return [];
  const lc = tokens.map(t => t.toLowerCase());
  // Build candidate match clauses. Postgres ILIKE on display_name handles
  // dot/underscore/space variants by collapsing them to spaces.
  const r = await pool.query(`
    SELECT id, email, display_name
      FROM users
     WHERE status = 'active'
       AND (
         LOWER(email) = ANY($1::text[])
         OR LOWER(SPLIT_PART(email, '@', 1)) = ANY($1::text[])
         OR LOWER(REPLACE(REPLACE(display_name, '.', ' '), '_', ' '))
            = ANY($2::text[])
       )
  `, [lc, lc.map(t => t.replace(/[._]/g, ' '))]);
  const excludeId = opts.excludeUserId || 0;
  return r.rows.filter(u => u.id !== excludeId);
}

module.exports = { extractTokens, resolveMentions };

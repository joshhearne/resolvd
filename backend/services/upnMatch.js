// Username-to-user matcher. RMM tools report a "user" for each endpoint
// — typically the Windows / Entra ID local account ("jhearne",
// "motadmin", etc.). This service generates plausible UPN candidates
// from each Resolvd user's display name + email local-part, then looks
// for a unique match against the asset's reported username.
//
// Matching is intentionally case-insensitive + ASCII-folded so a user
// stored as "Josh Hearne <josh@hearnetech.com>" still matches an asset
// reporting "JHEARNE", "joshh", or "josh_hearne".

const { pool } = require('../db/pool');

// Strip diacritics + non-alnum chars and lowercase. "José L." → "josel".
function normalize(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

// Plausible alias patterns from a display name + email local part.
//
//   Display "Josh Hearne" + email "josh.hearne@…" →
//     joshhearne, jhearne, joshh, josh, hearne, h.josh,
//     josh.hearne, joshhearne (dup-safe)
//
// All patterns are normalized (lowercase, alnum-only) so the match
// step doesn't worry about punctuation.
function candidatesForUser(user) {
  const candidates = new Set();
  const display = String(user.display_name || '').trim();
  const email = String(user.email || '').trim();

  if (email && email.includes('@')) {
    const local = email.split('@')[0];
    candidates.add(normalize(local));
    // local-part variants: drop dots/underscores
    candidates.add(normalize(local.replace(/[._-]/g, '')));
  }

  // Display name parsing. Split on whitespace; first token = firstname,
  // last token = lastname. Ignore middle tokens (initials etc.).
  const parts = display.split(/\s+/).filter(Boolean);
  if (parts.length >= 1) {
    const first = parts[0];
    const last = parts.length >= 2 ? parts[parts.length - 1] : '';
    const f = normalize(first);
    const l = normalize(last);
    if (f) candidates.add(f);
    if (l) candidates.add(l);
    if (f && l) {
      candidates.add(f + l);            // joshhearne
      candidates.add(f[0] + l);          // jhearne
      candidates.add(f + l[0]);          // joshh
      candidates.add(l + f);             // hearnejosh
      candidates.add(l + f[0]);          // hearnej
    }
  }

  // Drop empties + super-short candidates that would match anything.
  return Array.from(candidates).filter((c) => c.length >= 3);
}

// In-memory candidate index. Rebuilt on demand each sync — a tenant
// has tens to a few hundred users so the rebuild is cheap and avoids
// stale matches when users get renamed.
async function buildIndex(client) {
  const r = await (client || pool).query(
    `SELECT id, display_name, email FROM users WHERE status = 'active'`
  );
  const byPattern = new Map(); // pattern → [user_id] (track collisions)
  for (const u of r.rows) {
    for (const c of candidatesForUser(u)) {
      if (!byPattern.has(c)) byPattern.set(c, []);
      byPattern.get(c).push(u.id);
    }
  }
  return byPattern;
}

// Returns matched user_id or null. Refuses ambiguous matches: if the
// candidate maps to >1 user we leave the asset unlinked rather than
// guess. This is the safe default — admin can manually link via the
// asset detail UI when the matcher abstains.
function matchUsername(rawUsername, index) {
  const normalized = normalize(rawUsername);
  if (!normalized || normalized.length < 3) return null;
  const matches = index.get(normalized);
  if (!matches || matches.length === 0) return null;
  if (matches.length > 1) return null;
  return matches[0];
}

// Resolve an RMM org name to a Resolvd company by case-insensitive
// name match. NULL when no match or multiple matches (ambiguity safe).
async function resolveCompanyByName(client, orgName) {
  if (!orgName) return null;
  const r = await (client || pool).query(
    `SELECT id FROM companies WHERE LOWER(name) = LOWER($1)`,
    [String(orgName).trim()]
  );
  if (r.rows.length !== 1) return null;
  return r.rows[0].id;
}

module.exports = {
  buildIndex,
  matchUsername,
  resolveCompanyByName,
  // Exported for tests / introspection.
  normalize,
  candidatesForUser,
};

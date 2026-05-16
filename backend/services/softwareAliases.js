// Software-name normalization. Software-pull adapters call resolveSoftwareName
// at insert time to map "Adobe Acrobat Pro DC 64-bit" -> canonical
// "Adobe Acrobat" (or whatever the admin curates). Aliases are stored in
// software_aliases and cached in process to keep the per-row insert cheap.
//
// Match order is deterministic:
//   1. ORDER BY priority ASC (lower = checked first)
//   2. then ORDER BY id ASC
// First hit wins. Patterns are SQL LIKE by default (case-insensitive via
// LOWER), or a JS regex when is_regex=TRUE. Regex patterns are bounded
// to 1000 char inputs to keep ReDoS damage small even if an admin pastes
// a pathological pattern.

const { pool } = require('../db/pool');

const CACHE_TTL_MS = 30 * 1000; // 30s — admin edits propagate quickly without hammering the DB
let cache = null;
let cacheLoadedAt = 0;

async function loadAliases() {
  const r = await pool.query(`
    SELECT id, pattern, is_regex, canonical_name, canonical_vendor, priority
      FROM software_aliases
     ORDER BY priority ASC, id ASC
  `);
  cache = r.rows.map((row) => {
    let re = null;
    if (row.is_regex) {
      try { re = new RegExp(row.pattern, 'i'); }
      catch (err) { console.warn(`software alias ${row.id}: bad regex ${JSON.stringify(row.pattern)}: ${err.message}`); }
    }
    return { ...row, re };
  });
  cacheLoadedAt = Date.now();
}

function invalidateCache() {
  cacheLoadedAt = 0;
  cache = null;
}

// SQL LIKE -> JS test. Anchored as substring match (SQL LIKE without
// wildcards matches the whole string; ours allows substring so a bare
// pattern "Adobe Acrobat" matches "Adobe Acrobat Pro DC 64-bit"). The
// % wildcard is the only meta — _ stays literal, which is what most
// admins expect (software names have underscores).
function likeMatch(pattern, name) {
  if (!pattern) return false;
  const lowered = String(name).toLowerCase();
  const pat = String(pattern).toLowerCase();
  if (!pat.includes('%')) return lowered.includes(pat);
  // Build a RegExp from the LIKE pattern: % -> .*  (escape everything else)
  const escaped = pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*');
  try { return new RegExp(`^${escaped}$`).test(lowered); }
  catch { return false; }
}

// Returns { canonical_name, canonical_vendor, alias_id } when a row
// matches, or null when nothing in the alias table covers this software
// name. Vendor on the input is currently advisory — we don't gate on it
// today, but the signature leaves room for vendor-scoped aliases later.
async function resolveSoftwareName({ name /* , vendor */ }) {
  if (!name) return null;
  if (!cache || Date.now() - cacheLoadedAt > CACHE_TTL_MS) {
    await loadAliases().catch((err) => {
      console.warn('software alias load failed:', err.message);
      // On load failure keep the previous cache rather than blowing
      // up the software sync. Empty cache = no resolution; not fatal.
      if (!cache) cache = [];
    });
  }
  const trimmed = String(name).slice(0, 1000);
  for (const row of cache) {
    let hit = false;
    if (row.is_regex && row.re) {
      try { hit = row.re.test(trimmed); }
      catch { hit = false; }
    } else if (!row.is_regex) {
      hit = likeMatch(row.pattern, trimmed);
    }
    if (hit) {
      return {
        canonical_name: row.canonical_name,
        canonical_vendor: row.canonical_vendor || null,
        alias_id: row.id,
      };
    }
  }
  return null;
}

module.exports = { resolveSoftwareName, invalidateCache, loadAliases };

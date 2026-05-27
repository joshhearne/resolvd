// Microsoft Graph people lookup. Used to enrich a ticket's submitter
// with their display name + office location when those fields are
// missing or stale in the local users table. Requires a graph_user
// email backend account whose delegated token has User.Read.All
// granted (admin consent).
//
// All calls are cached in-process for 24h keyed by lowercased email.
// Network failures (token expired, 401/403, transient 5xx) degrade to
// null so callers fall back to local data without surfacing an error
// in the UI.

const fetch = require('node-fetch');
const { pool } = require('../db/pool');
const eb = require('./emailBackends');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const _cache = new Map(); // email_lc → { at, data }

function cacheGet(emailLc) {
  const hit = _cache.get(emailLc);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    _cache.delete(emailLc);
    return undefined;
  }
  return hit.data;
}

function cacheSet(emailLc, data) {
  _cache.set(emailLc, { at: Date.now(), data });
}

async function pickAccount() {
  const r = await pool.query(
    `SELECT * FROM email_backend_accounts
      WHERE provider = 'graph_user' AND is_active = TRUE
      ORDER BY id ASC
      LIMIT 1`
  );
  return r.rows[0] || null;
}

// Resolve an email to { displayName, officeLocation, department, mail,
// userPrincipalName } via Graph. Returns null when:
//   - no graph_user account is configured / active
//   - Graph returns 401/403/404 (token lacks scope, user not in tenant)
//   - any network error
async function lookupUserByEmail(email) {
  if (!email) return null;
  const emailLc = String(email).trim().toLowerCase();
  if (!emailLc) return null;
  const cached = cacheGet(emailLc);
  if (cached !== undefined) return cached;

  const account = await pickAccount();
  if (!account) {
    cacheSet(emailLc, null);
    return null;
  }
  let token;
  try {
    const fresh = await eb.refreshIfNeeded(account);
    token = fresh.oauth_access_token;
  } catch (err) {
    console.warn('graphUsers: token refresh failed:', err.message);
    cacheSet(emailLc, null);
    return null;
  }

  const select = '$select=id,displayName,officeLocation,department,mail,userPrincipalName,jobTitle';
  const url = `${GRAPH}/users/${encodeURIComponent(emailLc)}?${select}`;
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 404) {
      cacheSet(emailLc, null);
      return null;
    }
    if (r.status === 401 || r.status === 403) {
      console.warn(`graphUsers: ${r.status} on /users lookup — token likely missing User.Read.All scope`);
      cacheSet(emailLc, null);
      return null;
    }
    if (!r.ok) {
      console.warn(`graphUsers: /users ${emailLc} ${r.status} ${await r.text().catch(() => '')}`);
      return null;
    }
    const body = await r.json();
    const data = {
      id: body.id || null,
      displayName: body.displayName || null,
      officeLocation: body.officeLocation || null,
      department: body.department || null,
      jobTitle: body.jobTitle || null,
      mail: body.mail || null,
      userPrincipalName: body.userPrincipalName || null,
    };
    cacheSet(emailLc, data);
    return data;
  } catch (err) {
    console.warn('graphUsers: fetch failed:', err.message);
    return null;
  }
}

// Test-only: drop the cache. Used by integration tests that mock fetch.
function _clearCache() {
  _cache.clear();
}

module.exports = { lookupUserByEmail, _clearCache };

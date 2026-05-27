// Google Workspace directory lookup. Mirrors services/graphUsers.js for
// Google-side tenants. Resolves an email to displayName / org info via
// the Admin SDK Directory API. Requires a gmail_user email backend
// account whose token has admin.directory.user.readonly granted by a
// workspace admin. Tokens without the scope (e.g. existing gmail.send-
// only connections) return null gracefully — caller falls back to the
// raw email.
//
// In-process 24h cache keyed by lowercased email. Network failures /
// 401/403/404 degrade to null so the UI never surfaces a Google error.

const fetch = require('node-fetch');
const { pool } = require('../db/pool');
const eb = require('./emailBackends');

const DIRECTORY = 'https://admin.googleapis.com/admin/directory/v1';
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
      WHERE provider = 'gmail_user' AND is_active = TRUE
      ORDER BY id ASC
      LIMIT 1`
  );
  return r.rows[0] || null;
}

// Resolve an email to { displayName, officeLocation, department,
// jobTitle, mail }. Returns null on any failure (no account, missing
// scope, user outside the workspace, transient error).
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
    console.warn('googleUsers: token refresh failed:', err.message);
    cacheSet(emailLc, null);
    return null;
  }

  // projection=full pulls organizations[] (title/department) and
  // locations[] (buildingId/floorName). basic omits both; full is the
  // only useful projection for our enrichment.
  const url = `${DIRECTORY}/users/${encodeURIComponent(emailLc)}?projection=full`;
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 404) {
      cacheSet(emailLc, null);
      return null;
    }
    if (r.status === 401 || r.status === 403) {
      console.warn(`googleUsers: ${r.status} on /users lookup — token likely missing admin.directory.user.readonly scope`);
      cacheSet(emailLc, null);
      return null;
    }
    if (!r.ok) {
      console.warn(`googleUsers: /users ${emailLc} ${r.status} ${await r.text().catch(() => '')}`);
      return null;
    }
    const body = await r.json();
    const org = Array.isArray(body.organizations) ? body.organizations[0] : null;
    const loc = Array.isArray(body.locations) ? body.locations[0] : null;
    const officeLocation = loc?.buildingId || loc?.area || loc?.floorName || null;
    const data = {
      displayName: body.name?.fullName || null,
      officeLocation,
      department: org?.department || null,
      jobTitle: org?.title || null,
      mail: body.primaryEmail || null,
      userPrincipalName: body.primaryEmail || null,
    };
    cacheSet(emailLc, data);
    return data;
  } catch (err) {
    console.warn('googleUsers: fetch failed:', err.message);
    return null;
  }
}

function _clearCache() {
  _cache.clear();
}

module.exports = { lookupUserByEmail, _clearCache };

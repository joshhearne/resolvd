// Email backend account store. Wraps email_backend_accounts CRUD,
// transparent encryption of tokens/passwords via services/fields, and
// access-token refresh against the provider when expired.
//
// Microsoft 365 (graph_user): refresh against
//   https://login.microsoftonline.com/{tenant|common}/oauth2/v2.0/token
// Gmail (gmail_user): refresh via google-auth-library OAuth2Client.
// SMTP: no token refresh.

const fetch = require('node-fetch');
const { OAuth2Client } = require('google-auth-library');
const { pool } = require('../db/pool');
const { buildWritePatch, decryptRow, decryptRows } = require('./fields');

const REFRESH_SKEW_MS = 60_000; // refresh 1 min before nominal expiry

const MS_TENANT = () => process.env.AZURE_TENANT_ID || 'common';
const MS_TOKEN_URL = () => `https://login.microsoftonline.com/${MS_TENANT()}/oauth2/v2.0/token`;
const MS_AUTHORIZE_URL = () => `https://login.microsoftonline.com/${MS_TENANT()}/oauth2/v2.0/authorize`;

const MS_SCOPES = ['offline_access', 'openid', 'profile', 'email', 'User.Read', 'Mail.Send'];
const G_SCOPES  = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.send'];

function redirectUri(req) {
  const base = process.env.FRONTEND_URL || `${req.protocol}://${req.hostname}`;
  return `${base.replace(/\/$/, '')}/api/email-backends/oauth/callback`;
}

function buildMsAuthUrl(state, req) {
  const params = new URLSearchParams({
    client_id: process.env.AZURE_CLIENT_ID || '',
    response_type: 'code',
    redirect_uri: redirectUri(req),
    response_mode: 'query',
    scope: MS_SCOPES.join(' '),
    state,
  });
  return `${MS_AUTHORIZE_URL()}?${params.toString()}`;
}

function googleClient(req) {
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri(req),
  );
}

function buildGoogleAuthUrl(state, req) {
  return googleClient(req).generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: G_SCOPES,
    state,
    include_granted_scopes: true,
  });
}

async function exchangeMsCode(code, req) {
  const body = new URLSearchParams({
    client_id: process.env.AZURE_CLIENT_ID || '',
    client_secret: process.env.AZURE_CLIENT_SECRET || '',
    code,
    redirect_uri: redirectUri(req),
    grant_type: 'authorization_code',
    scope: MS_SCOPES.join(' '),
  });
  const r = await fetch(MS_TOKEN_URL(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Microsoft token exchange failed: ${r.status} ${text}`);
  }
  const t = await r.json();
  // Pull the user's primary email via /me to anchor the from_address.
  const me = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: `Bearer ${t.access_token}` },
  });
  if (!me.ok) throw new Error(`Microsoft /me lookup failed: ${me.status}`);
  const profile = await me.json();
  return {
    provider: 'graph_user',
    oauth_access_token: t.access_token,
    oauth_refresh_token: t.refresh_token || null,
    oauth_expires_at: new Date(Date.now() + (t.expires_in || 3600) * 1000),
    oauth_scope: t.scope || MS_SCOPES.join(' '),
    oauth_provider_user_id: profile.id || null,
    from_address: profile.mail || profile.userPrincipalName,
    display_name: profile.displayName || profile.userPrincipalName,
  };
}

async function exchangeGoogleCode(code, req) {
  const client = googleClient(req);
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  // Verify id_token to pull email + sub.
  let email = null;
  let sub = null;
  let displayName = null;
  if (tokens.id_token) {
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const p = ticket.getPayload();
    email = p.email;
    sub = p.sub;
    displayName = p.name;
  }
  return {
    provider: 'gmail_user',
    oauth_access_token: tokens.access_token,
    oauth_refresh_token: tokens.refresh_token || null,
    oauth_expires_at: tokens.expiry_date ? new Date(tokens.expiry_date) : new Date(Date.now() + 3600_000),
    oauth_scope: tokens.scope || G_SCOPES.join(' '),
    oauth_provider_user_id: sub,
    from_address: email,
    display_name: displayName || email,
  };
}

// Insert or update a row. If oauth_provider_user_id matches an existing
// row, update it; otherwise INSERT. Encrypts the secrets via the shared
// FIELD_MAP-driven helper.
async function upsertOAuthAccount({ provider, profile, createdByUserId }) {
  if (!profile.from_address) throw new Error('OAuth profile missing from_address');
  const existing = await pool.query(
    `SELECT id FROM email_backend_accounts
      WHERE provider = $1 AND oauth_provider_user_id = $2`,
    [provider, profile.oauth_provider_user_id || null]
  );
  const sensitive = await buildWritePatch(pool, 'email_backend_accounts', {
    oauth_access_token: profile.oauth_access_token,
    oauth_refresh_token: profile.oauth_refresh_token,
  });
  const passthrough = {
    provider,
    display_name: profile.display_name,
    from_address: profile.from_address,
    oauth_provider_user_id: profile.oauth_provider_user_id,
    oauth_expires_at: profile.oauth_expires_at,
    oauth_scope: profile.oauth_scope,
    updated_at: new Date(),
  };
  if (existing.rows[0]) {
    const cols = [...Object.keys(passthrough), ...sensitive.cols];
    const vals = [...Object.values(passthrough), ...sensitive.values];
    const setClauses = cols.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const r = await pool.query(
      `UPDATE email_backend_accounts SET ${setClauses} WHERE id = $${cols.length + 1} RETURNING *`,
      [...vals, existing.rows[0].id]
    );
    return r.rows[0];
  }
  const cols = ['created_by_user_id', ...Object.keys(passthrough), ...sensitive.cols];
  const vals = [createdByUserId || null, ...Object.values(passthrough), ...sensitive.values];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const r = await pool.query(
    `INSERT INTO email_backend_accounts (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    vals
  );
  return r.rows[0];
}

async function listAccounts() {
  const r = await pool.query(`
    SELECT id, provider, display_name, from_address, oauth_expires_at,
           is_active, last_test_at, last_test_status, last_test_error,
           smtp_host, smtp_port, smtp_user, smtp_secure,
           inbox_monitor_enabled, inbox_subscription_expires_at,
           inbox_last_renewed_at, send_as_submitter,
           created_at, updated_at
      FROM email_backend_accounts
     ORDER BY is_active DESC, updated_at DESC
  `);
  return r.rows;
}

async function activateAccount(id) {
  // Single-active enforced by partial unique index. Clear old, set new
  // in one transaction.
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`UPDATE email_backend_accounts SET is_active = FALSE WHERE is_active = TRUE`);
    const r = await c.query(
      `UPDATE email_backend_accounts SET is_active = TRUE, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id]
    );
    if (!r.rows[0]) throw new Error('Account not found');
    await c.query('COMMIT');
    return r.rows[0];
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

async function deleteAccount(id) {
  await pool.query(`DELETE FROM email_backend_accounts WHERE id = $1`, [id]);
}

async function getActiveAccount() {
  const r = await pool.query(
    `SELECT * FROM email_backend_accounts WHERE is_active = TRUE LIMIT 1`
  );
  if (!r.rows[0]) return null;
  await decryptRow('email_backend_accounts', r.rows[0]);
  return r.rows[0];
}

// Refresh the OAuth access token if it's within REFRESH_SKEW_MS of expiry,
// and persist the new token. Returns the (possibly refreshed) account.
async function refreshIfNeeded(account, req) {
  if (account.provider === 'smtp') return account;
  if (!account.oauth_expires_at) return account;
  const expMs = new Date(account.oauth_expires_at).getTime();
  if (expMs - Date.now() > REFRESH_SKEW_MS) return account;
  if (!account.oauth_refresh_token) {
    throw new Error(`No refresh token on backend ${account.id} — reconnect required`);
  }

  let next;
  if (account.provider === 'graph_user') {
    const body = new URLSearchParams({
      client_id: process.env.AZURE_CLIENT_ID || '',
      client_secret: process.env.AZURE_CLIENT_SECRET || '',
      grant_type: 'refresh_token',
      refresh_token: account.oauth_refresh_token,
      scope: MS_SCOPES.join(' '),
    });
    const r = await fetch(MS_TOKEN_URL(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`Microsoft token refresh failed: ${r.status} ${text}`);
    }
    const t = await r.json();
    next = {
      oauth_access_token: t.access_token,
      // MS may rotate the refresh token; if absent keep the old one.
      oauth_refresh_token: t.refresh_token || account.oauth_refresh_token,
      oauth_expires_at: new Date(Date.now() + (t.expires_in || 3600) * 1000),
      oauth_scope: t.scope || account.oauth_scope,
    };
  } else if (account.provider === 'gmail_user') {
    const client = googleClient(req || { protocol: 'https', hostname: 'localhost' });
    client.setCredentials({ refresh_token: account.oauth_refresh_token });
    const { credentials } = await client.refreshAccessToken();
    next = {
      oauth_access_token: credentials.access_token,
      oauth_refresh_token: credentials.refresh_token || account.oauth_refresh_token,
      oauth_expires_at: credentials.expiry_date ? new Date(credentials.expiry_date) : new Date(Date.now() + 3600_000),
      oauth_scope: credentials.scope || account.oauth_scope,
    };
  }

  // Persist refreshed tokens (encrypted under standard mode).
  const sensitive = await buildWritePatch(pool, 'email_backend_accounts', {
    oauth_access_token: next.oauth_access_token,
    oauth_refresh_token: next.oauth_refresh_token,
  });
  const passthrough = {
    oauth_expires_at: next.oauth_expires_at,
    oauth_scope: next.oauth_scope,
    updated_at: new Date(),
  };
  const cols = [...Object.keys(passthrough), ...sensitive.cols];
  const vals = [...Object.values(passthrough), ...sensitive.values];
  const setClauses = cols.map((k, i) => `${k} = $${i + 1}`).join(', ');
  await pool.query(
    `UPDATE email_backend_accounts SET ${setClauses} WHERE id = $${cols.length + 1}`,
    [...vals, account.id]
  );
  return { ...account, ...next };
}

async function recordTest(id, ok, error) {
  await pool.query(
    `UPDATE email_backend_accounts
        SET last_test_at = NOW(), last_test_status = $1, last_test_error = $2
      WHERE id = $3`,
    [ok ? 'ok' : 'fail', error ? String(error).slice(0, 500) : null, id]
  );
}

module.exports = {
  buildMsAuthUrl,
  buildGoogleAuthUrl,
  exchangeMsCode,
  exchangeGoogleCode,
  upsertOAuthAccount,
  listAccounts,
  activateAccount,
  deleteAccount,
  getActiveAccount,
  refreshIfNeeded,
  recordTest,
};

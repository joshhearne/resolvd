const express = require('express');
const msal = require('@azure/msal-node');
const fetch = require('node-fetch');
const { pool } = require('../db/pool');

const router = express.Router();

function getMsalClient() {
  return new msal.ConfidentialClientApplication({
    auth: {
      clientId: process.env.AZURE_CLIENT_ID,
      authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
      clientSecret: process.env.AZURE_CLIENT_SECRET,
    },
  });
}

const SCOPES = ['https://graph.microsoft.com/User.Read', 'offline_access'];

const ALLOWED_REDIRECT_ORIGINS = new Set(
  (process.env.AZURE_ALLOWED_ORIGINS || process.env.AZURE_REDIRECT_URI?.replace('/auth/callback', '') || '')
    .split(',').map(s => s.trim()).filter(Boolean)
);

function getRedirectUri(req) {
  const proto = req.protocol;
  const host = req.hostname;
  const origin = `${proto}://${host}`;
  if (ALLOWED_REDIRECT_ORIGINS.has(origin)) return `${origin}/auth/callback`;
  return process.env.AZURE_REDIRECT_URI;
}

// GET /auth/login — redirect to Microsoft login
router.get('/login', (req, res) => {
  const msalClient = getMsalClient();
  const redirectUri = getRedirectUri(req);
  msalClient.getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri,
  }).then(url => {
    res.redirect(url);
  }).catch(err => {
    console.error('MSAL getAuthCodeUrl error:', err);
    res.status(500).json({ error: 'Failed to initiate login' });
  });
});

// GET /auth/callback — handle OAuth callback
router.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).json({ error: 'Missing auth code' });
  }

  const msalClient = getMsalClient();
  try {
    const tokenResponse = await msalClient.acquireTokenByCode({
      code,
      scopes: SCOPES,
      redirectUri: getRedirectUri(req),
    });

    // Fetch user profile from Graph API
    const graphRes = await fetch('https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName', {
      headers: { Authorization: `Bearer ${tokenResponse.accessToken}` },
    });
    const profile = await graphRes.json();

    // TODO: Scaffold for group membership sync (not wired to roles yet)
    // const groupsRes = await fetch('https://graph.microsoft.com/v1.0/me/memberOf', {
    //   headers: { Authorization: `Bearer ${tokenResponse.accessToken}` },
    // });
    // const groups = await groupsRes.json();
    // Future: map Entra group IDs to local roles

    const entraOid = profile.id;
    const displayName = profile.displayName || '';
    const email = profile.mail || profile.userPrincipalName || '';
    const upn = profile.userPrincipalName || '';

    // Check if this is the very first user (bootstrap: assign Admin)
    const countResult = await pool.query('SELECT COUNT(*) as cnt FROM users');
    const isFirstUser = parseInt(countResult.rows[0].cnt, 10) === 0;

    // Upsert user
    const existingResult = await pool.query('SELECT * FROM users WHERE entra_oid = $1', [entraOid]);
    const existing = existingResult.rows[0];
    let user;

    if (existing) {
      const updateResult = await pool.query(
        'UPDATE users SET display_name = $1, email = $2, upn = $3, last_login = NOW() WHERE entra_oid = $4 RETURNING *',
        [displayName, email, upn, entraOid]
      );
      user = updateResult.rows[0];
    } else {
      const role = isFirstUser ? 'Admin' : 'Viewer';
      const insertResult = await pool.query(
        'INSERT INTO users (entra_oid, display_name, email, upn, role, last_login) VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *',
        [entraOid, displayName, email, upn, role]
      );
      user = insertResult.rows[0];
    }

    // Store in session — explicitly save before redirect so pg store
    // flushes before the browser follows the redirect and hits /auth/me
    req.session.user = {
      id: user.id,
      entraOid: user.entra_oid,
      displayName: user.display_name,
      email: user.email,
      upn: user.upn,
      role: user.role,
      defaultProjectId: user.default_project_id || null,
    };

    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.status(500).json({ error: 'Session save failed' });
      }
      res.redirect('/');
    });
  } catch (err) {
    console.error('Auth callback error:', err);
    res.status(500).json({ error: 'Authentication failed', detail: err.message });
  }
});

// GET /auth/logout
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    const base = getRedirectUri(req).replace('/auth/callback', '/');
    const logoutUrl = `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(base)}`;
    res.redirect(logoutUrl);
  });
});

// GET /auth/me — return current session user
router.get('/me', (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Unauthenticated' });
  }
  res.json(req.session.user);
});

module.exports = router;

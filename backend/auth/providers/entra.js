const msal = require('@azure/msal-node');
const fetch = require('node-fetch');
const { getAuthSettings } = require('../../services/authSettings');

const SCOPES = ['https://graph.microsoft.com/User.Read', 'offline_access'];

function tenantAuthority(allowPersonal) {
  if (allowPersonal) return 'https://login.microsoftonline.com/common';
  return `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`;
}

function getMsalClient(allowPersonal) {
  return new msal.ConfidentialClientApplication({
    auth: {
      clientId: process.env.AZURE_CLIENT_ID,
      authority: tenantAuthority(allowPersonal),
      clientSecret: process.env.AZURE_CLIENT_SECRET,
    },
  });
}

const ALLOWED_REDIRECT_ORIGINS = new Set(
  (process.env.AZURE_ALLOWED_ORIGINS || process.env.AZURE_REDIRECT_URI?.replace('/auth/callback', '') || '')
    .split(',').map(s => s.trim()).filter(Boolean)
);

function getRedirectUri(req) {
  const origin = `${req.protocol}://${req.hostname}`;
  if (ALLOWED_REDIRECT_ORIGINS.has(origin)) return `${origin}/auth/callback`;
  return process.env.AZURE_REDIRECT_URI;
}

async function isEnabled() {
  const s = await getAuthSettings();
  return !!s?.entra_enabled && !!process.env.AZURE_CLIENT_ID;
}

async function getAuthUrl(req) {
  const settings = await getAuthSettings();
  const client = getMsalClient(settings?.entra_allow_personal);
  return client.getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: getRedirectUri(req),
  });
}

async function handleCallback(req) {
  const { code } = req.query;
  if (!code) throw new Error('Missing auth code');
  const settings = await getAuthSettings();
  const client = getMsalClient(settings?.entra_allow_personal);
  const tokenResponse = await client.acquireTokenByCode({
    code,
    scopes: SCOPES,
    redirectUri: getRedirectUri(req),
  });

  const graphRes = await fetch(
    'https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName',
    { headers: { Authorization: `Bearer ${tokenResponse.accessToken}` } }
  );
  const profile = await graphRes.json();
  if (!profile.id) throw new Error(`Graph profile fetch failed: ${JSON.stringify(profile)}`);

  // Best-effort photo fetch — Graph returns 404 if user has no photo or
  // tenant blocks the endpoint. Both are non-fatal.
  let pictureBytes = null;
  let pictureMime = null;
  try {
    const photoRes = await fetch('https://graph.microsoft.com/v1.0/me/photo/$value', {
      headers: { Authorization: `Bearer ${tokenResponse.accessToken}` },
    });
    if (photoRes.ok) {
      pictureMime = photoRes.headers.get('content-type') || 'image/jpeg';
      pictureBytes = await photoRes.buffer();
    }
  } catch { /* ignore */ }

  return {
    provider: 'entra',
    providerKey: 'entra_oid',
    providerValue: profile.id,
    email: profile.mail || profile.userPrincipalName || '',
    displayName: profile.displayName || '',
    upn: profile.userPrincipalName || '',
    pictureBytes,
    pictureMime,
  };
}

function logoutRedirect(baseUrl) {
  return `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(baseUrl)}`;
}

module.exports = { isEnabled, getAuthUrl, handleCallback, getRedirectUri, logoutRedirect };

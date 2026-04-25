const { OAuth2Client } = require('google-auth-library');
const { getAuthSettings } = require('../../services/authSettings');

const SCOPES = [
  'openid',
  'email',
  'profile',
  // gmail.send is requested so admins who choose the Gmail email backend
  // get the consent in the same pass. Harmless if backend stays SMTP/Graph.
  'https://www.googleapis.com/auth/gmail.send',
];

function getClient(req) {
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || `${req.protocol}://${req.hostname}/auth/google/callback`
  );
}

async function isEnabled() {
  const s = await getAuthSettings();
  return !!s?.google_enabled && !!process.env.GOOGLE_CLIENT_ID;
}

async function getAuthUrl(req) {
  const settings = await getAuthSettings();
  const client = getClient(req);
  const params = {
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    include_granted_scopes: true,
  };
  if (settings?.google_workspace_domain) {
    params.hd = settings.google_workspace_domain;
  }
  return client.generateAuthUrl(params);
}

async function handleCallback(req) {
  const { code } = req.query;
  if (!code) throw new Error('Missing auth code');
  const client = getClient(req);
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  if (!tokens.id_token) throw new Error('No id_token returned from Google');
  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();

  const settings = await getAuthSettings();
  // Domain enforcement: when admin sets a workspace_domain, reject any account
  // whose hd claim does not match — UNLESS google_allow_consumer is true (in
  // which case mismatched hd is allowed and treated as a consumer login).
  if (settings?.google_workspace_domain && !settings?.google_allow_consumer) {
    if (payload.hd !== settings.google_workspace_domain) {
      const err = new Error(`Google account must belong to ${settings.google_workspace_domain}`);
      err.code = 'WRONG_DOMAIN';
      throw err;
    }
  }

  return {
    provider: 'google',
    providerKey: 'google_sub',
    providerValue: payload.sub,
    email: payload.email || '',
    displayName: payload.name || '',
    upn: payload.email || '',
    pictureUrl: payload.picture || null,
  };
}

module.exports = { isEnabled, getAuthUrl, handleCallback };

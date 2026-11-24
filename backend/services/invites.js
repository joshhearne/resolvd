// Issue an invite for an existing user row (status 'invited'): store a
// hashed one-time token and email the accept link. Used by POST
// /api/invites and the user CSV import.

const { pool } = require('../db/pool');
const { getAuthSettings } = require('./authSettings');
const { sendInviteEmail } = require('./email');
const { generateToken, hashToken } = require('../auth/tokens');

async function issueInvite({ email, role, provider, invitedById, invitedByName, baseUrl }) {
  const settings = await getAuthSettings();
  const ttlHours = settings?.invite_ttl_hours || 168;
  const token = generateToken();
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO invite_tokens (token_hash, email, role, invited_by, intended_provider, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [hashToken(token), email, role, invitedById, provider, expiresAt]
  );
  const inviteUrl = `${baseUrl.replace(/\/$/, '')}/accept-invite/${token}`;
  await sendInviteEmail({ to: email, inviteUrl, invitedByName, role });
  return { expiresAt };
}

function inviteBaseUrl(req) {
  return (process.env.FRONTEND_URL || `${req.protocol}://${req.hostname}`).replace(/\/$/, '');
}

module.exports = { issueInvite, inviteBaseUrl };

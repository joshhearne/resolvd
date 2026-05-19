// Auto-provision Submitter accounts for unrecognised email senders.
//
// Inbound email and external alert integrations both ingest tickets on
// behalf of senders identified only by email address. When that address
// doesn't match an existing user we mint a default-Submitter account so
// the ticket has a real submitter and a notification target. If Entra
// (Microsoft Graph) is configured, we look the address up and copy
// displayName + entra_oid so the user can sign in via SSO with no admin
// touch. Otherwise the user lands with name = email and no credentials —
// the alert to admins includes a link so they can populate the profile.

const fetch = require('node-fetch');
const { pool } = require('../db/pool');
const { notifyAdmins } = require('./notifications');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function entraConfigured() {
  return !!(process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_SECRET && process.env.AZURE_TENANT_ID);
}

async function lookupEntraByEmail(email) {
  if (!entraConfigured()) return null;
  try {
    const { getGraphAppToken } = require('./email');
    const token = await getGraphAppToken();
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}?$select=id,displayName,mail,userPrincipalName`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const profile = await res.json();
    if (!profile?.id) return null;
    return {
      entraOid: profile.id,
      displayName: profile.displayName || '',
      upn: profile.userPrincipalName || '',
    };
  } catch (err) {
    console.error('entra lookup failed for', email, err.message);
    return null;
  }
}

// Look up an existing active user (case-insensitive) regardless of role.
async function findExistingUserByEmail(client, email) {
  const r = await (client || pool).query(
    `SELECT id, role, status, email, display_name, auth_provider
       FROM users
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1`,
    [String(email).trim()]
  );
  return r.rows[0] || null;
}

// Mint a Submitter account for an email address. Returns the new user
// row, or null if email is missing/malformed. Idempotent: existing
// (active or otherwise) user takes precedence and is returned as-is.
//
// source: short label (e.g. 'inbound_email', 'alert:zabbix') used in the
//   admin notification so they can tell where the user came from.
async function autoProvisionSubmitter({ email, source }, client) {
  const db = client || pool;
  if (!email || !EMAIL_RE.test(String(email).trim())) return null;
  const cleanEmail = String(email).trim();

  const existing = await findExistingUserByEmail(db, cleanEmail);
  if (existing) return existing;

  const directory = await lookupEntraByEmail(cleanEmail);
  const displayName = directory?.displayName || null;
  const entraOid = directory?.entraOid || null;
  const upn = directory?.upn || null;
  const authProvider = entraOid ? 'entra' : 'local';

  const ins = await db.query(
    `INSERT INTO users (email, display_name, role, status, auth_provider, entra_oid, upn)
     VALUES ($1, $2, 'Submitter', 'active', $3, $4, $5)
     RETURNING id, role, status, email, display_name, auth_provider`,
    [cleanEmail, displayName, authProvider, entraOid, upn]
  );
  const user = ins.rows[0];

  // Best-effort admin alert. Notification failures must not block the
  // ticket pipeline — swallow and log.
  try {
    const sourceLabel = source ? ` from ${source}` : '';
    const nameForBody = displayName || cleanEmail;
    await notifyAdmins(db, {
      type: 'user_auto_provisioned',
      title: `New user auto-created: ${nameForBody}`,
      body: directory
        ? `Provisioned via Entra directory match${sourceLabel}. Review role / project membership.`
        : `Provisioned without directory match${sourceLabel}. Populate name and assign role.`,
      data: {
        user_id: user.id,
        email: cleanEmail,
        directory_matched: !!directory,
        source: source || null,
      },
    });
  } catch (err) {
    console.error('notify admins (user_auto_provisioned) failed:', err.message);
  }

  return user;
}

module.exports = {
  autoProvisionSubmitter,
  findExistingUserByEmail,
  lookupEntraByEmail,
};

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
const directoryLookup = require('./directoryLookup');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function entraConfigured() {
  return !!(process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_SECRET && process.env.AZURE_TENANT_ID);
}

// Legacy app-token Entra lookup. Kept as a fallback for tenants that
// configured the env-var auth_provider but never connected an email
// backend account. New deployments rely on the unified directoryLookup
// (Graph delegated tokens via email_backend_accounts, plus Google).
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

// Resolve via the unified directoryLookup (Graph then Google) and shape
// the result for autoProvisionSubmitter: { displayName, entraOid?, upn?,
// jobTitle, department, officeLocation, source }. entraOid is only set
// when Graph wins (it's the source-of-truth for SSO sub binding).
async function lookupDirectory(email) {
  const dir = await directoryLookup.lookupByEmail(email);
  if (!dir) return null;
  return {
    displayName: dir.displayName || '',
    upn: dir.userPrincipalName || dir.mail || '',
    jobTitle: dir.jobTitle || null,
    department: dir.department || null,
    officeLocation: dir.officeLocation || null,
    // Only Graph hits carry a tenant-stable id we can store as entra_oid;
    // Google directory hits leave this null and the user stays on local
    // auth until they actually sign in via Google SSO.
    entraOid: dir.source === 'graph' ? (dir.id || null) : null,
    source: dir.source,
  };
}

// Decline auto-provisioning when the sender's domain belongs to a
// vendor company. Vendor reps shouldn't become Submitter accounts on
// our org — they reply to tickets as contacts. Internal / customer
// companies are still allowed (in MSP setups customers do submit), and
// unknown domains fall through to "allow" so internal staff onboarding
// via inbound email still works.
async function isVendorDomain(client, email) {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase().trim();
  if (!domain) return false;
  const r = await client.query(
    `SELECT 1 FROM companies
      WHERE LOWER(domain) = $1
        AND kind = 'vendor'
        AND is_archived = FALSE
      LIMIT 1`,
    [domain]
  );
  return r.rows.length > 0;
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
async function autoProvisionSubmitter({ email, source, silent = false }, client) {
  const db = client || pool;
  if (!email || !EMAIL_RE.test(String(email).trim())) return null;
  const cleanEmail = String(email).trim();

  const existing = await findExistingUserByEmail(db, cleanEmail);
  if (existing) return existing;

  if (await isVendorDomain(db, cleanEmail)) {
    // Email belongs to a known vendor domain — they reply as contacts,
    // not users. Skip provisioning silently; the inbound queue / alert
    // ingest still records the underlying event.
    return null;
  }

  // Provisioning policy:
  //   1. Lookup via the unified directory (Graph delegated -> Google
  //      admin). If either tenant recognises the address, mint the
  //      account with the matching auth_provider so the user can SSO
  //      on their first login.
  //   2. If neither directory matches AND the env-var Entra app-token
  //      path is configured, try it as a legacy fallback.
  //   3. If still no match, consult auth_settings.allow_email_unknown_users.
  //      When FALSE (default) we refuse to mint anything — keeps the
  //      ingestion mailbox from being a spam-onboarding vector. When
  //      TRUE we create a local Submitter so the ticket has an owner.
  let directory = await lookupDirectory(cleanEmail);
  let entraOid = directory?.entraOid || null;
  if (!directory) {
    const legacy = await lookupEntraByEmail(cleanEmail);
    if (legacy) {
      directory = {
        displayName: legacy.displayName,
        upn: legacy.upn,
        source: 'graph',
      };
      entraOid = legacy.entraOid;
    }
  }

  if (!directory) {
    const gate = await db.query(
      `SELECT allow_email_unknown_users FROM auth_settings WHERE id = 1`
    );
    const allow = gate.rows[0]?.allow_email_unknown_users === true;
    if (!allow) {
      // Surface a one-shot admin alert so they can see the bounce. The
      // inbound queue keeps the raw message, so a human can still
      // recover it later by toggling the setting + re-running.
      try {
        await notifyAdmins(db, {
          type: 'user_auto_provision_blocked',
          title: `Inbound from unknown sender ${cleanEmail} rejected`,
          body: `No Graph / Google directory match and allow_email_unknown_users is OFF.`
              + ` Enable it in Auth Settings to accept submissions from arbitrary senders.`,
          data: { email: cleanEmail, source: source || null },
        });
      } catch (err) {
        console.error('notify admins (blocked auto-provision) failed:', err.message);
      }
      return null;
    }
  }

  const displayName = directory?.displayName || null;
  const upn = directory?.upn || null;
  let authProvider = 'local';
  if (entraOid) authProvider = 'entra';
  else if (directory?.source === 'google') authProvider = 'google';

  const ins = await db.query(
    `INSERT INTO users (email, display_name, role, status, auth_provider, entra_oid, upn)
     VALUES ($1, $2, 'Submitter', 'active', $3, $4, $5)
     RETURNING id, role, status, email, display_name, auth_provider`,
    [cleanEmail, displayName, authProvider, entraOid, upn]
  );
  const user = ins.rows[0];

  // Best-effort location bind. If the directory returned an office
  // string and it matches an internal location, link the user via
  // company_members so the consumable label / ticket dispatch path can
  // resolve a location without an explicit override.
  if (directory?.officeLocation) {
    try {
      await bindUserLocation(db, user.id, directory.officeLocation);
    } catch (err) {
      console.warn('bindUserLocation failed:', err.message);
    }
  }

  // Best-effort admin alert. Notification failures must not block the
  // ticket pipeline — swallow and log. Bulk import paths pass silent
  // to avoid flooding admins with one notification per imported user.
  if (silent) return user;
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

// Backfill an existing user from the configured directory. Used when an
// admin reassigns a ticket's submitter to an auto-provisioned account
// that still has a NULL display_name (or when they hit the per-user
// "refresh from directory" action). Updates display_name + upn when the
// lookup hits; binds a location if the office string matches an
// internal locations row. Returns the (possibly updated) user row.
async function enrichExistingUser(userId, { force = false } = {}) {
  const r = await pool.query(
    `SELECT id, email, display_name, upn, entra_oid, auth_provider FROM users WHERE id = $1`,
    [userId]
  );
  const u = r.rows[0];
  if (!u || !u.email) return u || null;
  if (!force && u.display_name && u.display_name.trim() && u.entra_oid) return u;

  let directory = await lookupDirectory(u.email);
  if (!directory) {
    const legacy = await lookupEntraByEmail(u.email);
    if (legacy) {
      directory = {
        displayName: legacy.displayName,
        upn: legacy.upn,
        entraOid: legacy.entraOid,
        source: 'graph',
      };
    }
  }
  if (!directory) return u;

  const updates = [];
  const params = [];
  if (directory.displayName) {
    params.push(directory.displayName);
    updates.push(`display_name = $${params.length}`);
  }
  if (directory.upn && !u.upn) {
    params.push(directory.upn);
    updates.push(`upn = $${params.length}`);
  }
  // Promote local → entra when a Graph lookup yields a tenant id. We
  // only upgrade local accounts: deliberately-local password users keep
  // their provider, and a user already bound to a different entra_oid
  // is left alone (clobbering would break their SSO link).
  if (directory.entraOid && !u.entra_oid && u.auth_provider === 'local') {
    params.push(directory.entraOid);
    updates.push(`entra_oid = $${params.length}`);
    params.push('entra');
    updates.push(`auth_provider = $${params.length}`);
  }
  if (updates.length) {
    params.push(u.id);
    await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${params.length}`,
      params
    );
  }

  if (directory.officeLocation) {
    try {
      await bindUserLocation(pool, u.id, directory.officeLocation);
    } catch (err) {
      console.warn('bindUserLocation failed:', err.message);
    }
  }

  const fresh = await pool.query(
    `SELECT id, email, display_name, upn, role, status FROM users WHERE id = $1`,
    [u.id]
  );
  return fresh.rows[0];
}

// Attach the user to a company_members row carrying the matched
// location, picking the user's existing company when present, or the
// location's company as a fallback. Idempotent: no-op when the user is
// already a member of the resolved company with a location set.
async function bindUserLocation(client, userId, locationString) {
  const s = String(locationString).trim();
  if (!s) return;
  const lr = await client.query(
    `SELECT l.id, l.company_id
       FROM locations l
      WHERE l.is_archived = FALSE
        AND (l.name ILIKE $1 OR l.location_code ILIKE $1)
      ORDER BY (CASE WHEN l.location_code ILIKE $1 THEN 0 ELSE 1 END)
      LIMIT 1`,
    [s]
  );
  const loc = lr.rows[0];
  if (!loc) return;

  const existing = await client.query(
    `SELECT company_id, location_id FROM company_members
      WHERE user_id = $1 ORDER BY added_at ASC LIMIT 1`,
    [userId]
  );
  if (existing.rows[0]) {
    if (!existing.rows[0].location_id) {
      await client.query(
        `UPDATE company_members SET location_id = $1
          WHERE company_id = $2 AND user_id = $3`,
        [loc.id, existing.rows[0].company_id, userId]
      );
    }
    return;
  }
  await client.query(
    `INSERT INTO company_members (company_id, user_id, location_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (company_id, user_id) DO UPDATE SET location_id = EXCLUDED.location_id`,
    [loc.company_id, userId, loc.id]
  );
}

module.exports = {
  autoProvisionSubmitter,
  findExistingUserByEmail,
  lookupEntraByEmail,
  lookupDirectory,
  enrichExistingUser,
  isVendorDomain,
};

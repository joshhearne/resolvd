// One-shot bulk onboarding of every user in the connected Entra tenant.
//
// Uses the existing graph_user delegated token (User.Read.All scope)
// to page /users from Microsoft Graph and mint a Submitter for each
// address that isn't already on file. No invite emails are sent —
// autoProvisionSubmitter is called with silent=true so the admin
// notification fanout is suppressed.
//
// Skips:
//   - empty mail + userPrincipalName combinations (room/equipment
//     resource mailboxes sometimes lack mail; we use UPN as fallback
//     but still require an @ in it).
//   - existing rows (idempotent — re-running this is safe).
//   - vendor-domain addresses (isVendorDomain in userAutoProvision).
//
// Resource accounts (rooms, equipment, shared mailboxes) tend to land
// here too. The user said they'd disable them by hand after the sweep.
//
// Usage (inside the backend container):
//   node scripts/bulk-import-entra.js
//
// Output: per-user status line + a final summary { created, skipped,
// errors, total }.

const fetch = require('node-fetch');
const { pool } = require('../db/pool');
const eb = require('../services/emailBackends');
const { autoProvisionSubmitter, findExistingUserByEmail } = require('../services/userAutoProvision');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const PAGE_SIZE = 100;

async function pickGraphAccount() {
  const r = await pool.query(
    `SELECT * FROM email_backend_accounts
      WHERE provider = 'graph_user' AND is_active = TRUE
      ORDER BY id ASC LIMIT 1`
  );
  return r.rows[0] || null;
}

async function* listEntraUsers(token) {
  // assignedLicenses[] is the cheapest signal for "real human with
  // an M365 seat" vs "shared mailbox / resource account / room /
  // unlicensed automation principal". We page it alongside the core
  // identity fields so we can filter at the source without a second
  // round-trip per user.
  const select = '$select=id,displayName,mail,userPrincipalName,accountEnabled,assignedLicenses';
  let url = `${GRAPH}/users?${select}&$top=${PAGE_SIZE}`;
  while (url) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`Graph /users ${r.status}: ${body}`);
    }
    const json = await r.json();
    for (const u of (json.value || [])) yield u;
    url = json['@odata.nextLink'] || null;
  }
}

function isLicensed(u) {
  return Array.isArray(u.assignedLicenses) && u.assignedLicenses.length > 0;
}

(async () => {
  const acct = await pickGraphAccount();
  if (!acct) { console.error('no active graph_user backend'); process.exit(2); }
  const fresh = await eb.refreshIfNeeded(acct);
  const token = fresh.oauth_access_token;
  if (!token) { console.error('no access token after refresh'); process.exit(3); }

  let created = 0;
  let skipped = 0;
  let errors = 0;
  let total = 0;

  let unlicensed = 0;
  for await (const u of listEntraUsers(token)) {
    total++;
    const email = (u.mail || u.userPrincipalName || '').trim();
    if (!email || !email.includes('@')) {
      skipped++;
      console.log(`SKIP   no-mail    ${u.displayName || u.id}`);
      continue;
    }
    if (!isLicensed(u)) {
      unlicensed++;
      skipped++;
      console.log(`SKIP   unlicensed ${email}`);
      continue;
    }
    try {
      const existing = await findExistingUserByEmail(pool, email);
      if (existing) {
        skipped++;
        console.log(`SKIP   exists    ${email}`);
        continue;
      }
      const out = await autoProvisionSubmitter(
        { email, source: 'bulk_entra_import', silent: true },
        pool
      );
      if (out) {
        created++;
        console.log(`OK     #${out.id.toString().padEnd(4)} ${email} (${out.auth_provider})`);
      } else {
        skipped++;
        console.log(`SKIP   no-match  ${email}`);
      }
    } catch (err) {
      errors++;
      console.error(`ERR    ${email}: ${err.message}`);
    }
  }

  console.log('---');
  console.log(JSON.stringify({ total, created, skipped, unlicensed, errors }, null, 2));
  process.exit(errors > 0 && created === 0 ? 1 : 0);
})().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});

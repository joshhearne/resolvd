// Read-only sweep: licensed Entra users NOT yet on file. No writes.
//
// Same source + filters as bulk-import-entra.js (graph_user delegated
// token, User.Read.All), but provisions nothing — it only reports who
// a bulk import *would* create. Use it to preview new M365 seats.
//
// Usage (inside the backend container):
//   node scripts/check-entra-new.js
//
// Output: one line per new licensed user + a final summary.

const { pool } = require('../db/pool');
const eb = require('../services/emailBackends');
const { findExistingUserByEmail } = require('../services/userAutoProvision');

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

  let total = 0;
  let licensed = 0;
  let onFile = 0;
  let newUsers = 0;
  const newList = [];

  for await (const u of listEntraUsers(token)) {
    total++;
    const email = (u.mail || u.userPrincipalName || '').trim();
    if (!email || !email.includes('@')) continue;
    if (!isLicensed(u)) continue;
    licensed++;
    const existing = await findExistingUserByEmail(pool, email);
    if (existing) { onFile++; continue; }
    newUsers++;
    newList.push({ email, displayName: u.displayName || null, enabled: u.accountEnabled !== false });
    console.log(`NEW    ${email}${u.accountEnabled === false ? ' (disabled)' : ''}  ${u.displayName || ''}`);
  }

  console.log('---');
  console.log(JSON.stringify({ total, licensed, onFile, newUsers, newList }, null, 2));
  process.exit(0);
})().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});

// Re-feed one already-delivered mailbox message through /api/inbound/generic.
// For messages Graph notified us about once and we dropped — there is no
// retry from Graph, so the only way back in is to replay it.
//
// Usage: node scripts/reingest-message.js '<internetMessageId>' [accountId]
const fetch = require('node-fetch');
const { pool } = require('../db/pool');
const { decryptRow } = require('../services/fields');
const eb = require('../services/emailBackends');
const graphInbox = require('../services/graphInbox');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const TARGET = process.argv[2];
const ACCT_ID = Number(process.argv[3] || 1);
const BASE = process.env.SELF_URL || 'http://127.0.0.1:3001';

(async () => {
  if (!TARGET) throw new Error('pass an internetMessageId');
  const secret = process.env.INBOUND_WEBHOOK_SECRET;
  if (!secret) throw new Error('INBOUND_WEBHOOK_SECRET not set in this env');

  const r0 = await pool.query(`SELECT * FROM email_backend_accounts WHERE id = $1`, [ACCT_ID]);
  if (!r0.rows[0]) throw new Error(`no account ${ACCT_ID}`);
  await decryptRow('email_backend_accounts', r0.rows[0]);
  const acct = await eb.refreshIfNeeded(r0.rows[0]);

  const filt = encodeURIComponent(`internetMessageId eq '${TARGET}'`);
  const res = await fetch(`${GRAPH}/me/mailFolders/inbox/messages?$filter=${filt}&$select=id,subject`,
    { headers: { Authorization: `Bearer ${acct.oauth_access_token}` } });
  const found = ((await res.json()).value || [])[0];
  if (!found) throw new Error('message not in inbox');
  console.log(`found: ${found.subject}`);

  const payload = await graphInbox.fetchMessageAsPayload(acct, found.id);
  console.log(`from=${payload.from} ref-candidate-subject="${payload.subject}"`);
  console.log(`headers: Auto-Submitted=${payload.headers['Auto-Submitted'] || '(none)'}`);

  const post = await fetch(`${BASE}/api/inbound/generic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Inbound-Secret': secret },
    body: JSON.stringify(payload),
  });
  console.log(`\nPOST /api/inbound/generic -> ${post.status}`);
  console.log(JSON.stringify(await post.json(), null, 2));
  await pool.end();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });

// Read-only: hunt a specific internetMessageId across every folder of every
// monitored mailbox, and list recent Inbox arrivals that never produced an
// inbound_email_queue row. Answers "did Graph never deliver it, or did we
// drop it on ingest?"
//
// Usage: node scripts/find-missing-inbound.js '<message-id>' [sinceISO]
const fetch = require('node-fetch');
const { pool } = require('../db/pool');
const { decryptRow } = require('../services/fields');
const eb = require('../services/emailBackends');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const TARGET = process.argv[2] || null;
const SINCE = process.argv[3] || '2026-07-28T00:00:00Z';

async function g(token, url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Graph ${r.status} ${url}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

async function allFolders(token) {
  const out = [];
  let url = `${GRAPH}/me/mailFolders/delta?$select=displayName,parentFolderId`;
  // simple non-delta walk incl. children
  url = `${GRAPH}/me/mailFolders?$top=100&$select=displayName,totalItemCount`;
  let page = await g(token, url);
  out.push(...(page.value || []));
  while (page['@odata.nextLink']) {
    page = await g(token, page['@odata.nextLink']);
    out.push(...(page.value || []));
  }
  // include well-known folders that may not enumerate at top level
  for (const wk of ['junkemail', 'deleteditems', 'recoverableitemsdeletions', 'archive']) {
    if (!out.some(f => (f.displayName || '').toLowerCase().replace(/\s/g, '') === wk)) {
      out.push({ id: wk, displayName: `(wellknown:${wk})` });
    }
  }
  return out;
}

(async () => {
  const accounts = await pool.query(
    `SELECT * FROM email_backend_accounts WHERE inbox_monitor_enabled = TRUE ORDER BY id`
  );

  const queued = await pool.query(
    `SELECT external_message_id, message_id, id, status, subject, received_at
       FROM inbound_email_queue WHERE received_at > $1`, [SINCE]
  );
  const seen = new Set();
  for (const r of queued.rows) {
    if (r.external_message_id) seen.add(r.external_message_id);
    if (r.message_id) seen.add(r.message_id);
  }

  for (const raw of accounts.rows) {
    await decryptRow('email_backend_accounts', raw);
    const acct = await eb.refreshIfNeeded(raw);
    const token = acct.oauth_access_token;
    console.log(`\n================ ${acct.from_address} (id ${acct.id}) ================`);

    if (TARGET) {
      const folders = await allFolders(token);
      let hits = 0;
      for (const f of folders) {
        const fid = f.id;
        try {
          const filt = encodeURIComponent(`internetMessageId eq '${TARGET}'`);
          const res = await g(token,
            `${GRAPH}/me/mailFolders/${encodeURIComponent(fid)}/messages?$filter=${filt}&$select=id,subject,from,receivedDateTime,sentDateTime,isRead,internetMessageId,parentFolderId`);
          for (const m of res.value || []) {
            hits++;
            console.log(`  FOUND in "${f.displayName}": ${m.receivedDateTime} | ${m.from?.emailAddress?.address} | ${m.subject}`);
          }
        } catch (e) {
          // folders that reject $filter or are inaccessible
          if (!/404|ErrorInvalidIdMalformed/.test(e.message)) console.log(`  (skip ${f.displayName}: ${e.message.slice(0, 90)})`);
        }
      }
      if (!hits) console.log(`  TARGET NOT PRESENT anywhere in this mailbox.`);
    }

    // Recent Inbox arrivals vs queue
    const filt = encodeURIComponent(`receivedDateTime ge ${SINCE}`);
    const inbox = await g(token,
      `${GRAPH}/me/mailFolders/inbox/messages?$top=100&$orderby=receivedDateTime desc&$filter=${filt}&$select=id,subject,from,receivedDateTime,internetMessageId,isRead`);
    const msgs = inbox.value || [];
    console.log(`  Inbox messages since ${SINCE}: ${msgs.length}`);
    for (const m of msgs) {
      const inQueue = seen.has(m.internetMessageId) || seen.has(m.id);
      console.log(`   ${inQueue ? 'QUEUED  ' : 'MISSING '} ${m.receivedDateTime} | ${(m.from?.emailAddress?.address || '?').padEnd(38)} | ${(m.subject || '').slice(0, 70)}`);
    }
  }
  await pool.end();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });

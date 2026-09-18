// Read-only: dump internet headers + the ingest-relevant decision inputs for
// one message in a monitored mailbox, and replay the isAutoLoop() check.
const fetch = require('node-fetch');
const { pool } = require('../db/pool');
const { decryptRow } = require('../services/fields');
const eb = require('../services/emailBackends');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const TARGET = process.argv[2];
const ACCT_ID = Number(process.argv[3] || 1);

function isAutoLoop(headers) {
  if (!headers || typeof headers !== 'object') return false;
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === 'x-resolvd-no-reply' && String(v).trim() === '1') return `x-resolvd-no-reply=${v}`;
    if (lk === 'auto-submitted' && /auto-(replied|generated)/i.test(String(v))) return `auto-submitted=${v}`;
    if (lk === 'precedence' && /^bulk$/i.test(String(v).trim())) return `precedence=${v}`;
  }
  return false;
}

(async () => {
  const r0 = await pool.query(`SELECT * FROM email_backend_accounts WHERE id = $1`, [ACCT_ID]);
  await decryptRow('email_backend_accounts', r0.rows[0]);
  const acct = await eb.refreshIfNeeded(r0.rows[0]);
  const token = acct.oauth_access_token;

  const filt = encodeURIComponent(`internetMessageId eq '${TARGET}'`);
  const res = await fetch(`${GRAPH}/me/mailFolders/inbox/messages?$filter=${filt}&$select=id,subject,from,receivedDateTime,internetMessageId,internetMessageHeaders,parentFolderId`,
    { headers: { Authorization: `Bearer ${token}` } });
  const j = await res.json();
  const m = (j.value || [])[0];
  if (!m) { console.log('not found in inbox'); await pool.end(); return; }

  console.log(`subject : ${m.subject}`);
  console.log(`from    : ${m.from?.emailAddress?.address}`);
  console.log(`received: ${m.receivedDateTime}`);
  console.log(`graph id: ${m.id}`);

  const headers = {};
  for (const h of (m.internetMessageHeaders || [])) if (h?.name) headers[h.name] = h.value;
  console.log(`\nheader count: ${Object.keys(headers).length}`);
  const interesting = Object.entries(headers).filter(([k]) =>
    /^(precedence|auto-submitted|x-resolvd|in-reply-to|references|message-id|x-auto|list-|return-path|x-ms-exchange-organization-(scl|authas)|x-forefront|x-microsoft-antispam)/i.test(k));
  for (const [k, v] of interesting) console.log(`  ${k}: ${String(v).slice(0, 160)}`);

  const verdict = isAutoLoop(headers);
  console.log(`\nisAutoLoop() => ${verdict ? 'DROP (' + verdict + ')' : 'pass'}`);

  const TICKET_REF_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/;
  console.log(`subject ref match => ${(m.subject || '').match(TICKET_REF_RE)?.[1] || 'none'}`);

  const q = await pool.query(
    `SELECT id, status, matched_ticket_id, reject_reason FROM inbound_email_queue
      WHERE external_message_id = $1 OR message_id = $1`, [m.internetMessageId]);
  console.log(`queue rows for this message: ${q.rowCount}`, q.rows);
  await pool.end();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });

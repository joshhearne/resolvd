// One-shot backfill: refetch attachments for a previously-matched inbound
// queue row and link them to the existing comment that was created from it.
// Used to recover attachments that were dropped on the floor before
// d734ad1 added vendor-reply attachment persistence.
//
// Usage: node scripts/refetch-attachments.js <queue_row_id>

const path = require('path');
const fsp = require('fs').promises;
const { randomUUID } = require('crypto');
const { pool } = require('../db/pool');
const { buildWritePatch, getMode } = require('../services/fields');
const { encrypt } = require('../services/crypto');
const { fetchMessageAsPayload } = require('../services/graphInbox');
const fetch = require('node-fetch');
const eb = require('../services/emailBackends');

const GRAPH = 'https://graph.microsoft.com/v1.0';

async function resolveGraphIdByInternetMessageId(account, internetMessageId) {
  const fresh = await eb.refreshIfNeeded(account);
  // Quote single-quotes in the value for OData
  const safe = String(internetMessageId).replace(/'/g, "''");
  const url = `${GRAPH}/me/messages?$filter=${encodeURIComponent(`internetMessageId eq '${safe}'`)}&$select=id,internetMessageId&$top=1`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${fresh.oauth_access_token}` },
  });
  if (!r.ok) throw new Error(`Graph filter ${r.status}: ${await r.text()}`);
  const body = await r.json();
  return body.value?.[0]?.id || null;
}

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';

async function persistAttachment({ ticketId, userId, commentId, filename, mimetype, contentBuffer }) {
  const ext = filename.includes('.') ? path.extname(filename) : '';
  const onDiskName = `${randomUUID()}${ext}`;
  const filePath = path.join(UPLOADS_DIR, onDiskName);
  const mode = await getMode(pool);
  const encryptedAtRest = mode === 'standard';
  const onDisk = encryptedAtRest
    ? await encrypt(contentBuffer, `attachments.file:${onDiskName}`)
    : contentBuffer;
  await fsp.writeFile(filePath, onDisk);
  const patch = await buildWritePatch(pool, 'attachments', { original_name: filename });
  const cols = ['ticket_id', 'user_id', 'comment_id', 'filename', 'mimetype', 'size', 'encrypted_at_rest', ...patch.cols];
  const values = [ticketId, userId, commentId, onDiskName, mimetype || 'application/octet-stream',
    contentBuffer.length, encryptedAtRest, ...patch.values];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  await pool.query(
    `INSERT INTO attachments (${cols.join(', ')}) VALUES (${placeholders})`,
    values
  );
  return onDiskName;
}

async function main() {
  const queueId = Number(process.argv[2]);
  if (!queueId) {
    console.error('Usage: node scripts/refetch-attachments.js <queue_row_id>');
    process.exit(1);
  }

  const q = await pool.query(
    `SELECT id, source, external_message_id, matched_ticket_id, status
       FROM inbound_email_queue WHERE id = $1`,
    [queueId]
  );
  if (!q.rows[0]) { console.error(`queue row ${queueId} not found`); process.exit(2); }
  const row = q.rows[0];
  if (row.source !== 'graph') { console.error(`source=${row.source}, only graph supported`); process.exit(3); }
  if (!row.external_message_id) { console.error('no external_message_id'); process.exit(4); }
  if (!row.matched_ticket_id) { console.error('not matched to a ticket'); process.exit(5); }

  const c = await pool.query(
    `SELECT id, user_id FROM comments WHERE source_inbound_email_id = $1 ORDER BY id ASC LIMIT 1`,
    [queueId]
  );
  if (!c.rows[0]) { console.error('no comment found for this queue row'); process.exit(6); }
  const commentId = c.rows[0].id;
  const commentUserId = c.rows[0].user_id;

  // Try every graph_user account with monitoring on, regardless of is_active —
  // a deactivated account may still hold the historical message we need to
  // refetch (subscription was alive when the message landed).
  const acct = await pool.query(
    `SELECT * FROM email_backend_accounts
      WHERE provider = 'graph_user' AND inbox_monitor_enabled = TRUE
      ORDER BY id ASC`
  );
  if (!acct.rows.length) { console.error('no active graph_user account'); process.exit(7); }

  // external_message_id is the RFC-822 Message-ID header (e.g. <...@mail.gmail.com>),
  // not Graph's internal id. Resolve it via $filter on internetMessageId first.
  let payload = null;
  let lastErr = null;
  for (const a of acct.rows) {
    try {
      const graphId = await resolveGraphIdByInternetMessageId(a, row.external_message_id);
      if (!graphId) {
        console.warn(`account ${a.id}: no Graph message matches internetMessageId`);
        continue;
      }
      payload = await fetchMessageAsPayload(a, graphId);
      console.log(`fetched via account ${a.id} (${a.display_name}), graphId=${graphId}`);
      break;
    } catch (e) {
      lastErr = e;
      console.warn(`account ${a.id} fetch failed: ${e.message}`);
    }
  }
  if (!payload) { console.error(`could not fetch message: ${lastErr?.message || 'no match in any account'}`); process.exit(8); }

  const atts = payload.attachments || [];
  console.log(`message has ${atts.length} file attachment(s)`);
  let saved = 0;
  for (const att of atts) {
    try {
      const buf = Buffer.from(att.content_base64 || '', 'base64');
      if (!buf.length) { console.warn(`skip empty: ${att.filename}`); continue; }
      const onDisk = await persistAttachment({
        ticketId: row.matched_ticket_id,
        userId: commentUserId,
        commentId,
        filename: att.filename,
        mimetype: att.mimetype,
        contentBuffer: buf,
      });
      console.log(`  saved ${att.filename} -> ${onDisk} (${buf.length} bytes)`);
      saved += 1;
    } catch (e) {
      console.error(`  failed ${att?.filename}: ${e.message}`);
    }
  }
  console.log(`done. ticket_id=${row.matched_ticket_id} comment_id=${commentId} saved=${saved}/${atts.length}`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(99); });

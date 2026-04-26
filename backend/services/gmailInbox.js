// Gmail inbox watch adapter.
//
// Lifecycle:
//   1. Admin toggles "Monitor inbox" on a gmail_user backend.
//   2. createWatch calls users.watch with topicName and labelIds INBOX.
//      The Pub/Sub topic must already exist; the connected Google
//      account needs Publisher permission on it. We store the response
//      historyId so we know where to resume from on the next push.
//   3. Pub/Sub Push subscription forwards JSON payloads to
//      /api/inbound/gmail. Payload contains {emailAddress, historyId}.
//   4. Handler runs users.history.list since our stored historyId,
//      pulls each new message via users.messages.get, builds the
//      inbound payload, and feeds the existing pipeline.
//   5. Watches expire every 7 days; renewal scheduler re-issues watch
//      before expiry (idempotent — Google extends the existing watch
//      when called again from the same account).

const { google } = require('googleapis');
const { pool } = require('../db/pool');
const eb = require('./emailBackends');

const WATCH_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const RENEWAL_THRESHOLD_MS = 12 * 60 * 60 * 1000;

function gmailClient(account) {
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
  oauth2.setCredentials({ access_token: account.oauth_access_token });
  return google.gmail({ version: 'v1', auth: oauth2 });
}

async function createWatch(account) {
  const topicName = process.env.GMAIL_PUBSUB_TOPIC;
  if (!topicName) {
    throw new Error('GMAIL_PUBSUB_TOPIC env var required (e.g. projects/your-project/topics/gmail-watch)');
  }
  const fresh = await eb.refreshIfNeeded(account);
  const gmail = gmailClient(fresh);
  const r = await gmail.users.watch({
    userId: 'me',
    requestBody: {
      labelIds: ['INBOX'],
      labelFilterAction: 'include',
      topicName,
    },
  });
  const expiresAt = r.data?.expiration ? new Date(parseInt(r.data.expiration, 10)) : new Date(Date.now() + WATCH_LIFETIME_MS);
  await pool.query(
    `UPDATE email_backend_accounts
        SET inbox_monitor_enabled = TRUE,
            inbox_subscription_id = $1,
            inbox_subscription_state = $2,
            inbox_subscription_expires_at = $3,
            inbox_last_renewed_at = NOW(),
            updated_at = NOW()
      WHERE id = $4`,
    [topicName, String(r.data?.historyId || ''), expiresAt, account.id]
  );
  return r.data;
}

async function renewWatch(account) {
  // users.watch is idempotent — calling again extends the existing watch.
  return createWatch(account);
}

async function stopWatch(account) {
  try {
    const fresh = await eb.refreshIfNeeded(account);
    const gmail = gmailClient(fresh);
    await gmail.users.stop({ userId: 'me' });
  } catch (e) {
    console.error(`Gmail watch stop failed (continuing): ${e.message}`);
  }
  await pool.query(
    `UPDATE email_backend_accounts
        SET inbox_monitor_enabled = FALSE,
            inbox_subscription_id = NULL,
            inbox_subscription_state = NULL,
            inbox_subscription_expires_at = NULL,
            updated_at = NOW()
      WHERE id = $1`,
    [account.id]
  );
}

// Walk the history since the last stored historyId and return new
// message ids (added to the inbox). Updates the account's stored
// historyId on success so the next push only fetches deltas.
async function listNewMessageIds(account) {
  const fresh = await eb.refreshIfNeeded(account);
  const gmail = gmailClient(fresh);
  const startHistoryId = account.inbox_subscription_state;
  if (!startHistoryId) return [];
  const r = await gmail.users.history.list({
    userId: 'me',
    startHistoryId,
    historyTypes: ['messageAdded'],
    labelId: 'INBOX',
  });
  const ids = [];
  for (const h of (r.data?.history || [])) {
    for (const m of (h.messagesAdded || [])) {
      if (m.message?.id) ids.push(m.message.id);
    }
  }
  // Persist the latest historyId so the next call resumes from there.
  if (r.data?.historyId) {
    await pool.query(
      `UPDATE email_backend_accounts SET inbox_subscription_state = $1 WHERE id = $2`,
      [String(r.data.historyId), account.id]
    );
  }
  return ids;
}

// Fetch a message in raw RFC 822 form and parse it into the inbound JSON
// payload shape the ingestor expects.
async function fetchMessageAsPayload(account, messageId) {
  const fresh = await eb.refreshIfNeeded(account);
  const gmail = gmailClient(fresh);
  const r = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });
  const m = r.data;
  const headers = {};
  for (const h of (m.payload?.headers || [])) {
    if (h?.name) headers[h.name] = h.value;
  }

  // Walk the MIME tree: collect text/plain (preferred) or text/html for
  // body, and any non-inline parts as attachments.
  const parts = [];
  function walk(p) {
    if (!p) return;
    if (Array.isArray(p.parts)) p.parts.forEach(walk);
    parts.push(p);
  }
  walk(m.payload || {});

  let bodyText = '';
  let bodyHtml = '';
  const attachments = [];
  for (const p of parts) {
    const mime = p.mimeType || '';
    const filename = p.filename || '';
    const data = p.body?.data;
    const attachmentId = p.body?.attachmentId;
    if (mime === 'text/plain' && !bodyText && data) {
      bodyText = Buffer.from(data, 'base64').toString('utf8');
    } else if (mime === 'text/html' && !bodyHtml && data) {
      bodyHtml = Buffer.from(data, 'base64').toString('utf8');
    } else if (filename && (data || attachmentId)) {
      let buf;
      if (data) {
        buf = Buffer.from(data, 'base64');
      } else {
        const att = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId,
          id: attachmentId,
        });
        buf = Buffer.from(att.data?.data || '', 'base64');
      }
      attachments.push({
        filename,
        mimetype: mime || 'application/octet-stream',
        content_base64: buf.toString('base64'),
      });
    }
  }

  const fromHeader = headers['From'] || '';
  // crude "Name <email>" parse
  const m2 = /([^<]*)<([^>]+)>/.exec(fromHeader);
  const fromName = m2 ? m2[1].trim().replace(/^"|"$/g, '') : null;
  const fromAddr = m2 ? m2[2].trim() : fromHeader.trim();

  return {
    source: 'gmail',
    external_message_id: headers['Message-ID'] || m.id,
    from: fromAddr,
    from_name: fromName,
    to: headers['To'] || null,
    cc: (headers['Cc'] || '').split(',').map(s => s.trim()).filter(Boolean),
    subject: headers['Subject'] || '',
    body: bodyText || (bodyHtml ? stripHtml(bodyHtml) : ''),
    message_id: headers['Message-ID'] || null,
    in_reply_to: headers['In-Reply-To'] || null,
    references: headers['References'] || null,
    headers,
    attachments,
  };
}

function stripHtml(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = {
  createWatch,
  renewWatch,
  stopWatch,
  listNewMessageIds,
  fetchMessageAsPayload,
  RENEWAL_THRESHOLD_MS,
};

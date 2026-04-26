// Microsoft Graph inbox subscription adapter.
//
// Lifecycle:
//   1. Admin toggles "Monitor inbox" on a graph_user backend.
//   2. createSubscription POSTs to /v1.0/subscriptions with changeType
//      "created", resource "/me/mailFolders/inbox/messages", a webhook
//      URL pointing at /api/inbound/graph, and a clientState we store.
//   3. Graph hits the webhook with a validation_token query param —
//      route handler echoes it back as text/plain within 10s.
//   4. Subsequent change notifications POST a payload of resource ids;
//      handler fetches each message, packages it into the inbound JSON
//      shape, and feeds the existing tryAutoCreate pipeline.
//   5. Subscriptions max out at ~3 days (4230 minutes); the renewal
//      scheduler PATCHes them daily-ish before they expire.
//
// The access token is refreshed via emailBackends.refreshIfNeeded
// before any Graph call so renewal/fetch survive token expiry.

const fetch = require('node-fetch');
const crypto = require('crypto');
const { pool } = require('../db/pool');
const eb = require('./emailBackends');

const GRAPH = 'https://graph.microsoft.com/v1.0';
// Graph caps subscription lifetime for /messages at 4230 minutes (~70.5h).
// We request slightly under to give renewal headroom.
const SUB_LIFETIME_MS = 4200 * 60 * 1000;
const RENEWAL_THRESHOLD_MS = 12 * 60 * 60 * 1000; // renew if <12h to expiry

function notificationUrl() {
  const base = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
  if (!base) throw new Error('FRONTEND_URL must be set for Graph subscriptions to receive notifications');
  return `${base}/api/inbound/graph`;
}

async function authedFetch(account, url, opts = {}) {
  const fresh = await eb.refreshIfNeeded(account);
  return fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${fresh.oauth_access_token}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
}

async function createSubscription(account) {
  const clientState = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + SUB_LIFETIME_MS);
  const r = await authedFetch(account, `${GRAPH}/subscriptions`, {
    method: 'POST',
    body: JSON.stringify({
      changeType: 'created',
      notificationUrl: notificationUrl(),
      resource: '/me/mailFolders/inbox/messages',
      expirationDateTime: expiresAt.toISOString(),
      clientState,
    }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Graph subscriptions POST ${r.status}: ${text}`);
  }
  const body = await r.json();
  await pool.query(
    `UPDATE email_backend_accounts
        SET inbox_monitor_enabled = TRUE,
            inbox_subscription_id = $1,
            inbox_subscription_secret = $2,
            inbox_subscription_expires_at = $3,
            inbox_last_renewed_at = NOW(),
            updated_at = NOW()
      WHERE id = $4`,
    [body.id, clientState, body.expirationDateTime, account.id]
  );
  return body;
}

async function renewSubscription(account) {
  if (!account.inbox_subscription_id) throw new Error('No subscription id to renew');
  const expiresAt = new Date(Date.now() + SUB_LIFETIME_MS);
  const r = await authedFetch(account, `${GRAPH}/subscriptions/${encodeURIComponent(account.inbox_subscription_id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ expirationDateTime: expiresAt.toISOString() }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Graph subscriptions PATCH ${r.status}: ${text}`);
  }
  const body = await r.json();
  await pool.query(
    `UPDATE email_backend_accounts
        SET inbox_subscription_expires_at = $1,
            inbox_last_renewed_at = NOW(),
            updated_at = NOW()
      WHERE id = $2`,
    [body.expirationDateTime, account.id]
  );
  return body;
}

async function deleteSubscription(account) {
  if (!account.inbox_subscription_id) return;
  try {
    await authedFetch(account, `${GRAPH}/subscriptions/${encodeURIComponent(account.inbox_subscription_id)}`, { method: 'DELETE' });
  } catch (e) {
    console.error(`Graph subscription delete failed (continuing): ${e.message}`);
  }
  await pool.query(
    `UPDATE email_backend_accounts
        SET inbox_monitor_enabled = FALSE,
            inbox_subscription_id = NULL,
            inbox_subscription_secret = NULL,
            inbox_subscription_expires_at = NULL,
            updated_at = NOW()
      WHERE id = $1`,
    [account.id]
  );
}

// Fetch a message + its attachments and convert to the JSON shape the
// /api/inbound/generic ingestor expects.
async function fetchMessageAsPayload(account, messageId) {
  const r = await authedFetch(account, `${GRAPH}/me/messages/${encodeURIComponent(messageId)}?$expand=attachments`);
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Graph /me/messages/${messageId} ${r.status}: ${text}`);
  }
  const m = await r.json();
  const attachments = (m.attachments || [])
    .filter(a => a['@odata.type'] === '#microsoft.graph.fileAttachment' && a.contentBytes)
    .map(a => ({
      filename: a.name || 'attachment.bin',
      mimetype: a.contentType,
      content_base64: a.contentBytes,
    }));
  // Headers as a flat dictionary, lowercase-keyed, last-wins. Used by the
  // ingestor's auto-loop drop check (X-Resolvd-No-Reply, Auto-Submitted).
  const headers = {};
  for (const h of (m.internetMessageHeaders || [])) {
    if (h?.name) headers[h.name] = h.value;
  }
  return {
    source: 'graph',
    external_message_id: m.internetMessageId || m.id,
    from: m.from?.emailAddress?.address || m.sender?.emailAddress?.address,
    from_name: m.from?.emailAddress?.name || m.sender?.emailAddress?.name,
    to: (m.toRecipients || []).map(r => r.emailAddress?.address).filter(Boolean).join(', '),
    cc: (m.ccRecipients || []).map(r => r.emailAddress?.address).filter(Boolean),
    subject: m.subject || '',
    body: (m.body?.contentType === 'html'
      ? stripHtml(m.body?.content || '')
      : (m.body?.content || '')),
    message_id: m.internetMessageId,
    in_reply_to: headers['In-Reply-To'] || null,
    references: headers['References'] || null,
    headers,
    attachments,
  };
}

// Best-effort HTML → plaintext for ticket descriptions. Doesn't try to
// preserve formatting — just removes tags and decodes basic entities.
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
  createSubscription,
  renewSubscription,
  deleteSubscription,
  fetchMessageAsPayload,
  RENEWAL_THRESHOLD_MS,
};

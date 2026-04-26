// Provider-specific inbound webhook receivers (Microsoft Graph
// subscription notifications + Gmail Pub/Sub push). Both adapters end
// up calling the same internal pipeline used by /api/inbound/generic
// so dedup, signature stripping, auto-create, etc. behave identically
// no matter how a message arrived.

const express = require('express');
const fetch = require('node-fetch');
const { pool } = require('../db/pool');
const { decryptRow } = require('../services/fields');
const graphInbox = require('../services/graphInbox');
const gmailInbox = require('../services/gmailInbox');

const router = express.Router();

// Reuse the internal generic handler instead of duplicating the
// dedup/insert logic. Going via the actual HTTP endpoint keeps the
// call path consistent with externally-fed payloads.
async function feedToGeneric(payload) {
  const secret = process.env.INBOUND_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error('INBOUND_WEBHOOK_SECRET not set; provider adapters require it');
  }
  const r = await fetch(`http://localhost:${process.env.PORT || 3001}/api/inbound/generic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Inbound-Secret': secret },
    body: JSON.stringify(payload),
  });
  return await r.json().catch(() => ({}));
}

async function loadAccountByGraphSubscriptionId(subId) {
  const r = await pool.query(
    `SELECT * FROM email_backend_accounts WHERE inbox_subscription_id = $1 AND provider = 'graph_user'`,
    [subId]
  );
  if (!r.rows[0]) return null;
  await decryptRow('email_backend_accounts', r.rows[0]);
  return r.rows[0];
}

async function loadAccountByEmail(email) {
  const r = await pool.query(
    `SELECT * FROM email_backend_accounts
      WHERE LOWER(from_address) = LOWER($1) AND inbox_monitor_enabled = TRUE
      LIMIT 1`,
    [email]
  );
  if (!r.rows[0]) return null;
  await decryptRow('email_backend_accounts', r.rows[0]);
  return r.rows[0];
}

// Microsoft Graph subscription notifications. Two shapes:
//   1. Validation handshake — comes with ?validationToken=… query and
//      no body. Must echo the token in plaintext within 10s or the
//      subscription create is rejected. No secret required at this
//      stage (Graph won't have heard our clientState yet).
//   2. Change notifications — POST body with `value: [{ resource,
//      clientState, ... }]`. We verify clientState matches the
//      subscription we stored, then fetch each resource and feed it
//      through the generic ingestor.
router.post('/graph', async (req, res) => {
  const validationToken = req.query.validationToken;
  if (validationToken) {
    res.set('Content-Type', 'text/plain');
    return res.status(200).send(String(validationToken));
  }
  const notifications = req.body?.value || [];
  // Acknowledge fast — Graph wants 202 within ~30s. We process asynchronously.
  res.status(202).end();
  for (const n of notifications) {
    try {
      const account = await loadAccountByGraphSubscriptionId(n.subscriptionId);
      if (!account) continue;
      if (account.inbox_subscription_secret && n.clientState !== account.inbox_subscription_secret) {
        console.warn(`Graph notification clientState mismatch for sub ${n.subscriptionId}`);
        continue;
      }
      // resource looks like "Users/{id}/Messages/{messageId}"
      const messageId = (n.resource || '').split('/').pop();
      if (!messageId) continue;
      const payload = await graphInbox.fetchMessageAsPayload(account, messageId);
      // Drop the message we sent ourselves — Graph sometimes echoes Sent
      // items into the inbox via shared mailboxes. Our outbound carries
      // X-Resolvd-No-Reply so the existing isAutoLoop check in the
      // generic ingestor takes care of this.
      await feedToGeneric(payload);
    } catch (e) {
      console.error('graph notification handling failed:', e.message);
    }
  }
});

// Gmail Pub/Sub push. The message is base64 in body.message.data
// and decodes to JSON `{ emailAddress, historyId }`. Pub/Sub Push can
// authenticate via OIDC (Authorization: Bearer <token>); operators
// should configure their Push subscription to require the same audience
// we expect, but we also accept a shared secret in
// `?token=GMAIL_PUBSUB_TOKEN` for simpler deploys.
router.post('/gmail', async (req, res) => {
  const expected = process.env.GMAIL_PUBSUB_TOKEN;
  if (expected) {
    if ((req.query.token || '') !== expected) return res.status(401).end();
  }
  // Always 204 quickly so Pub/Sub stops retrying.
  res.status(204).end();
  try {
    const data = req.body?.message?.data;
    if (!data) return;
    const decoded = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
    const account = await loadAccountByEmail(decoded.emailAddress);
    if (!account) return;
    const ids = await gmailInbox.listNewMessageIds(account);
    for (const id of ids) {
      try {
        const payload = await gmailInbox.fetchMessageAsPayload(account, id);
        await feedToGeneric(payload);
      } catch (e) {
        console.error(`gmail message ${id} handling failed:`, e.message);
      }
    }
  } catch (e) {
    console.error('gmail push handling failed:', e.message);
  }
});

module.exports = router;

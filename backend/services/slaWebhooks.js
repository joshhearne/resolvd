// Outbound SLA webhooks — Slack, Microsoft Teams, PagerDuty, or a generic
// signed JSON POST — fired alongside the in-app/email fanout when a
// ticket warns or breaches (sla.tickWarnings / tickBreaches).
//
//   slack      incoming-webhook URL; Block Kit message
//   teams      Teams Workflows ("When a Teams webhook request is
//              received") URL; Adaptive Card message
//   pagerduty  Events API v2 routing key; one incident per ticket + SLA
//              clock (dedup_key), auto-resolved by resolveSweep() once
//              the ticket is resolved or closed
//   generic    any URL; JSON body, signed with HMAC-SHA256 in
//              X-Resolvd-Signature when a signing secret is set
//
// Targets (URLs embed their credential; PagerDuty keys are credentials)
// and signing secrets are stored encrypted and never returned to a
// client — the list shows a masked hint instead.
//
// buildRequest / matchesHook / maskTarget are pure; the rest touch the
// database or network.

const nodeCrypto = require('crypto');
const { pool } = require('../db/pool');
const { encrypt, decrypt } = require('./crypto');
const kms = require('./kms');
const { decryptRow } = require('./fields');

const APP_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
const PAGERDUTY_URL = 'https://events.pagerduty.com/v2/enqueue';
const KINDS = ['slack', 'teams', 'pagerduty', 'generic'];
const EVENTS = ['breach_response', 'breach_resolve', 'warning_response', 'warning_resolve'];
const TARGET_CTX = 'sla_webhooks.target';
const SECRET_CTX = 'sla_webhooks.secret';
const TIMEOUT_MS = 10_000;

const EVENT_TEXT = {
  breach_response: 'Response SLA breached',
  breach_resolve: 'Resolve SLA breached',
  warning_response: 'Response SLA at risk',
  warning_resolve: 'Resolve SLA at risk',
  test: 'Test notification',
};

function pdSeverity(event, priority) {
  if (event.startsWith('warning')) return 'warning';
  if (priority === 1) return 'critical';
  if (priority === 2) return 'error';
  if (priority === 3) return 'warning';
  return 'info';
}

// One incident per ticket and clock, so a response breach and a later
// resolve breach on the same ticket are separate pages.
function dedupKey(event, ticketId) {
  const clock = event.endsWith('_response') ? 'response' : 'resolve';
  return `resolvd-ticket-${ticketId}-${clock}`;
}

// ticket: { id, internal_ref, title, effective_priority, project_name? }
function buildRequest(hook, { event, ticket, occurredAt = new Date() }) {
  const label = EVENT_TEXT[event] || event;
  const ref = ticket.internal_ref || `#${ticket.id}`;
  const url = `${APP_URL}/tickets/${ticket.id}`;
  const pri = ticket.effective_priority ? `P${ticket.effective_priority}` : null;
  const summary = `${label}: ${ref}${ticket.title ? ` — ${ticket.title}` : ''}`;
  const facts = [pri && `Priority ${pri}`, ticket.project_name && `Project ${ticket.project_name}`].filter(Boolean);
  const json = (body) => JSON.stringify(body);

  if (hook.kind === 'slack') {
    // Slack mrkdwn: escape the three control characters in free text.
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return {
      url: hook.target,
      headers: { 'Content-Type': 'application/json' },
      body: json({
        text: summary,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `*${esc(label)}*\n<${url}|${esc(ref)}>${ticket.title ? ` ${esc(ticket.title)}` : ''}` } },
          ...(facts.length ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: esc(facts.join(' · ')) }] }] : []),
        ],
      }),
    };
  }

  if (hook.kind === 'teams') {
    return {
      url: hook.target,
      headers: { 'Content-Type': 'application/json' },
      body: json({
        type: 'message',
        attachments: [{
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.4',
            body: [
              { type: 'TextBlock', text: label, weight: 'Bolder', size: 'Medium', wrap: true },
              { type: 'TextBlock', text: `${ref}${ticket.title ? ` — ${ticket.title}` : ''}`, wrap: true },
              ...(facts.length ? [{ type: 'TextBlock', text: facts.join(' · '), isSubtle: true, spacing: 'None', wrap: true }] : []),
            ],
            actions: [{ type: 'Action.OpenUrl', title: 'Open ticket', url }],
          },
        }],
      }),
    };
  }

  if (hook.kind === 'pagerduty') {
    const key = event === 'test' ? `resolvd-test-${hook.id}` : dedupKey(event, ticket.id);
    return {
      url: PAGERDUTY_URL,
      headers: { 'Content-Type': 'application/json' },
      dedupKey: key,
      body: json({
        routing_key: hook.target,
        event_action: 'trigger',
        dedup_key: key,
        payload: {
          summary: summary.slice(0, 1024),
          source: 'resolvd',
          severity: pdSeverity(event, ticket.effective_priority),
          timestamp: occurredAt.toISOString(),
          custom_details: { event, ticket_ref: ref, priority: pri, project: ticket.project_name || null },
        },
        links: [{ href: url, text: `Open ${ref}` }],
      }),
    };
  }

  // generic
  const body = json({
    event,
    occurred_at: occurredAt.toISOString(),
    ticket: {
      id: ticket.id,
      ref,
      title: ticket.title || null,
      priority: ticket.effective_priority ?? null,
      project: ticket.project_name || null,
      url,
    },
  });
  const ts = String(Math.floor(occurredAt.getTime() / 1000));
  const headers = { 'Content-Type': 'application/json', 'X-Resolvd-Event': event, 'X-Resolvd-Timestamp': ts };
  if (hook.secret) {
    // Signed over "<timestamp>.<body>" so a captured body can't be
    // replayed under a fresh timestamp.
    const sig = nodeCrypto.createHmac('sha256', hook.secret).update(`${ts}.${body}`).digest('hex');
    headers['X-Resolvd-Signature'] = `sha256=${sig}`;
  }
  return { url: hook.target, headers, body };
}

function buildResolveRequest(hook, key) {
  return {
    url: PAGERDUTY_URL,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ routing_key: hook.target, event_action: 'resolve', dedup_key: key }),
  };
}

// hook: { enabled, events[], project_id, max_priority }
function matchesHook(hook, { event, projectId, priority }) {
  if (!hook.enabled) return false;
  if (!(hook.events || []).includes(event)) return false;
  if (hook.project_id != null && hook.project_id !== projectId) return false;
  const p = Number(priority) || 3;
  return p <= (Number(hook.max_priority) || 5);
}

// Display-safe hint: host plus the last 4 chars (URL) or ****1234 (key).
function maskTarget(kind, target) {
  const t = String(target || '');
  if (!t) return '';
  const tail = t.slice(-4);
  if (kind === 'pagerduty') return `••••${tail}`;
  try {
    return `${new URL(t).host}/…${tail}`;
  } catch {
    return `…${tail}`;
  }
}

function validateTarget(kind, target) {
  const t = String(target || '').trim();
  if (!t) return 'target required';
  if (kind === 'pagerduty') {
    return /^[A-Za-z0-9]{20,64}$/.test(t) ? null : 'PagerDuty integration (routing) key looks wrong — 32 letters/digits expected';
  }
  let u;
  try { u = new URL(t); } catch { return 'target must be a URL'; }
  if (kind === 'generic') return /^https?:$/.test(u.protocol) ? null : 'URL must be http(s)';
  return u.protocol === 'https:' ? null : 'URL must be https';
}

async function sealTarget(plaintext) {
  if (!kms.isAvailable()) {
    throw Object.assign(
      new Error('RESOLVD_MASTER_KEY not configured — webhook URLs and keys cannot be stored until it is (Admin → Encryption).'),
      { httpStatus: 400 }
    );
  }
  return encrypt(Buffer.from(String(plaintext).trim(), 'utf8'), TARGET_CTX);
}

async function sealSecret(plaintext) {
  if (!kms.isAvailable()) {
    throw Object.assign(new Error('RESOLVD_MASTER_KEY not configured'), { httpStatus: 400 });
  }
  return encrypt(Buffer.from(String(plaintext).trim(), 'utf8'), SECRET_CTX);
}

async function unseal(row) {
  const target = row.target_enc ? (await decrypt(row.target_enc, TARGET_CTX)).toString('utf8') : null;
  const secret = row.secret_enc ? (await decrypt(row.secret_enc, SECRET_CTX)).toString('utf8') : null;
  return { ...row, target, secret };
}

async function send(req) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: ctl.signal });
    const text = res.ok ? '' : (await res.text().catch(() => '')).slice(0, 300);
    return { ok: res.ok, status: res.status, error: res.ok ? null : `HTTP ${res.status}${text ? `: ${text}` : ''}` };
  } catch (err) {
    return { ok: false, status: null, error: err.name === 'AbortError' ? 'timed out' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function record(hookId, ticketId, event, result, key) {
  await pool.query(
    `INSERT INTO sla_webhook_deliveries (webhook_id, ticket_id, event, ok, http_status, error, dedup_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [hookId, ticketId, event, result.ok, result.status, result.error, key || null]
  );
  await pool.query(
    `UPDATE sla_webhooks SET last_sent_at = NOW(), last_ok = $2, last_error = $3 WHERE id = $1`,
    [hookId, result.ok, result.error]
  );
}

async function ticketContext(ticketId) {
  const r = await pool.query(
    `SELECT t.id, t.internal_ref, t.title, t.title_enc, t.project_id, t.effective_priority,
            p.name AS project_name
       FROM tickets t LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.id = $1`,
    [ticketId]
  );
  if (!r.rows[0]) return null;
  return decryptRow('tickets', r.rows[0]);
}

// Fire every matching hook for one ticket event. Never throws — the SLA
// sweep must not stall on a dead endpoint.
async function dispatch(event, ticketId) {
  try {
    if (!kms.isAvailable()) return;
    const hooks = await pool.query(`SELECT * FROM sla_webhooks WHERE enabled = TRUE AND $1 = ANY(events)`, [event]);
    if (!hooks.rows.length) return;
    const ticket = await ticketContext(ticketId);
    if (!ticket) return;
    for (const row of hooks.rows) {
      if (!matchesHook(row, { event, projectId: ticket.project_id, priority: ticket.effective_priority })) continue;
      try {
        const hook = await unseal(row);
        const req = buildRequest(hook, { event, ticket });
        const result = await send(req);
        await record(row.id, ticket.id, event, result, row.kind === 'pagerduty' ? req.dedupKey : null);
      } catch (err) {
        console.error(`sla webhook ${row.id} (${event}) failed:`, err.message);
      }
    }
  } catch (err) {
    console.error('sla webhook dispatch failed:', err.message);
  }
}

// Resolve PagerDuty incidents whose ticket is now resolved / closed. One
// resolve per open dedup_key; failures stay open and retry next sweep.
async function resolveSweep() {
  if (!kms.isAvailable()) return { resolved: 0 };
  const open = await pool.query(`
    SELECT DISTINCT ON (d.webhook_id, d.dedup_key) d.webhook_id, d.dedup_key, d.ticket_id
      FROM sla_webhook_deliveries d
      JOIN sla_webhooks w ON w.id = d.webhook_id AND w.kind = 'pagerduty'
      JOIN tickets t ON t.id = d.ticket_id
      LEFT JOIN statuses s ON s.kind = 'internal' AND s.name = t.internal_status
     WHERE d.ok = TRUE AND d.dedup_key IS NOT NULL AND d.resolved_at IS NULL
       AND (t.resolved_at IS NOT NULL OR s.is_terminal = TRUE)
  `);
  let resolved = 0;
  for (const row of open.rows) {
    try {
      const w = await pool.query(`SELECT * FROM sla_webhooks WHERE id = $1`, [row.webhook_id]);
      if (!w.rows[0]) continue;
      const hook = await unseal(w.rows[0]);
      const result = await send(buildResolveRequest(hook, row.dedup_key));
      if (!result.ok) {
        console.warn(`pagerduty resolve ${row.dedup_key} failed:`, result.error);
        continue;
      }
      await pool.query(
        `UPDATE sla_webhook_deliveries SET resolved_at = NOW()
          WHERE webhook_id = $1 AND dedup_key = $2 AND resolved_at IS NULL`,
        [row.webhook_id, row.dedup_key]
      );
      resolved++;
    } catch (err) {
      console.error('pagerduty resolve sweep:', err.message);
    }
  }
  return { resolved };
}

// Admin "Send test" — a sample payload to one hook, regardless of its
// event filter. PagerDuty tests are resolved straight away.
async function sendTest(hookId) {
  const w = await pool.query(`SELECT * FROM sla_webhooks WHERE id = $1`, [hookId]);
  if (!w.rows[0]) return null;
  const hook = await unseal(w.rows[0]);
  const ticket = { id: 0, internal_ref: 'TEST-0001', title: 'Resolvd webhook test', effective_priority: 2, project_name: null };
  const req = buildRequest(hook, { event: 'test', ticket });
  const result = await send(req);
  await record(hook.id, null, 'test', result, null);
  if (result.ok && hook.kind === 'pagerduty') await send(buildResolveRequest(hook, req.dedupKey));
  return result;
}

module.exports = {
  KINDS, EVENTS,
  buildRequest, buildResolveRequest, matchesHook, maskTarget, validateTarget, dedupKey,
  sealTarget, sealSecret, dispatch, resolveSweep, sendTest,
};

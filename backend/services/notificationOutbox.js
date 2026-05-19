// Notification outbox flusher.
//
// When a user has email_digest != 'instant', the per-event email path
// inserts a notification_outbox row instead of sending immediately.
// This service ticks every 5 minutes; any row with scheduled_flush_at
// in the past is grouped by user (and by ticket within user) and
// rendered as a single digest email. Empty buckets skipped.
//
// Same shape as mutedDigest.js — startScheduler() exposed, tickOnce()
// idempotent + safe to invoke manually for testing.

const { pool } = require('../db/pool');
const { sendMail } = require('./email');
const { renderDigest } = require('./notificationEmailTemplates');

const TICK_MS = 5 * 60 * 1000;

async function tickOnce() {
  // Suppress rows whose ticket has since reached a terminal status —
  // a comment / assignment / SLA event buffered before close shouldn't
  // surface in a digest sent after the ticket was already closed.
  // Mark them sent (skipped) so they don't pile up forever.
  await pool.query(`
    UPDATE notification_outbox o
       SET sent_at = NOW()
      FROM tickets t
      JOIN statuses s ON s.kind='internal' AND s.name=t.internal_status
     WHERE o.sent_at IS NULL
       AND o.ticket_id IS NOT NULL
       AND t.id = o.ticket_id
       AND s.is_terminal = TRUE
  `).catch((err) => console.error('outbox terminal-suppress failed:', err.message));

  // Cleanup sweep: rows that sat unsent for 30 days are almost certainly
  // orphans (digest toggled off post-insert, scheduled_flush_at never
  // matched, user deactivated, etc). Hard-delete so the table stays
  // bounded. Sent rows are preserved for audit lookback.
  await pool.query(
    `DELETE FROM notification_outbox
       WHERE sent_at IS NULL AND created_at < NOW() - INTERVAL '30 days'`
  ).catch((err) => console.error('outbox cleanup sweep failed:', err.message));

  const r = await pool.query(`
    SELECT o.id, o.user_id, o.event_type, o.ticket_id, o.payload, o.created_at,
           u.email AS user_email, u.display_name AS user_name
      FROM notification_outbox o
      JOIN users u ON u.id = o.user_id
     WHERE o.sent_at IS NULL
       AND o.scheduled_flush_at <= NOW()
       AND u.status = 'active'
       AND u.email IS NOT NULL AND u.email <> ''
     ORDER BY o.user_id, o.ticket_id NULLS LAST, o.created_at
  `);
  if (!r.rows.length) {
    await heartbeat({ flushed_users: 0, flushed_rows: 0 });
    return { flushed_users: 0, flushed_rows: 0 };
  }

  // Group user → ticket → events
  const byUser = new Map();
  for (const row of r.rows) {
    if (!byUser.has(row.user_id)) {
      byUser.set(row.user_id, {
        userId: row.user_id,
        email: row.user_email,
        name: row.user_name,
        ticketGroups: new Map(),
        rowIds: [],
      });
    }
    const u = byUser.get(row.user_id);
    u.rowIds.push(row.id);
    const tkey = row.ticket_id || 0;
    if (!u.ticketGroups.has(tkey)) {
      u.ticketGroups.set(tkey, {
        ticket_id: row.ticket_id,
        ticket_ref: row.payload?.ticket_ref || '(no ref)',
        ticket_title: row.payload?.ticket_title || '',
        events: [],
      });
    }
    u.ticketGroups.get(tkey).events.push({
      event_type: row.event_type,
      payload: row.payload || {},
      created_at: row.created_at,
    });
  }

  let flushedUsers = 0;
  let flushedRows = 0;
  for (const u of byUser.values()) {
    const ticketGroups = [...u.ticketGroups.values()];
    try {
      const { subject, html } = await renderDigest({
        recipientName: u.name,
        ticketGroups,
      });
      await sendMail({
        to: u.email,
        subject,
        html,
        headers: {
          'Auto-Submitted': 'auto-generated',
          'X-Resolvd-Digest': 'notifications',
        },
      });
      await pool.query(
        `UPDATE notification_outbox SET sent_at = NOW() WHERE id = ANY($1::int[])`,
        [u.rowIds]
      );
      flushedUsers++;
      flushedRows += u.rowIds.length;
    } catch (err) {
      console.error(`notificationOutbox flush failed for user ${u.userId}:`, err.message);
    }
  }

  await heartbeat({ flushed_users: flushedUsers, flushed_rows: flushedRows });
  return { flushed_users: flushedUsers, flushed_rows: flushedRows };
}

async function heartbeat(metadata) {
  await pool.query(
    `UPDATE system_jobs
        SET last_run_at = NOW(),
            last_status = 'ok',
            metadata = $1::jsonb
      WHERE name = 'notification_outbox'`,
    [JSON.stringify(metadata)]
  ).catch(() => {});
}

let _interval = null;
function startScheduler() {
  if (_interval) return;
  _interval = setInterval(() => {
    tickOnce().catch(err => console.error('notificationOutbox tick error:', err.message));
  }, TICK_MS);
  // Boot catch-up — flush anything that came due while server was down.
  tickOnce().catch(() => {});
}

module.exports = { tickOnce, startScheduler };

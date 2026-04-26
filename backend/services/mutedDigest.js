// Daily digest of muted vendor replies.
//
// Vendor replies that arrive on a ticket with auto_mute_vendor_replies=TRUE
// land in the thread but suppress per-comment notifications. The digest
// catches them up: once a day at the configured local time, every
// follower of a ticket that received muted replies in the prior 24h
// (or since the previous digest) gets one email summarising what they
// might want to look at before EOD.
//
// Scheduling: server.js runs scheduleTick(pool) on a 5-minute interval.
// Each tick decides "is now past today's local target, and have we
// already run today?". The system_jobs row keeps state idempotent
// across server restarts.

const { pool } = require('../db/pool');
const { decryptRows } = require('./fields');
const { sendMail } = require('./email');
const { getBranding } = require('./branding');
const { getAuthSettings } = require('./authSettings');

const APP_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
const PREVIEW_LEN = 200;

function fmt(d) {
  return new Date(d).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

function preview(s) {
  if (!s) return '';
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_LEN ? flat.slice(0, PREVIEW_LEN) + '…' : flat;
}

// Pull every muted, not-yet-digested comment along with ticket + contact +
// follower fan-out info. One pass; we group in JS.
async function fetchPendingDigestRows(client) {
  const r = await client.query(`
    SELECT
      c.id              AS comment_id,
      c.body            AS comment_body,
      c.body_enc        AS comment_body_enc,
      c.created_at      AS comment_created_at,
      c.vendor_contact_id,
      ct.name           AS contact_name,
      ct.name_enc       AS contact_name_enc,
      ct.email          AS contact_email,
      ct.email_enc      AS contact_email_enc,
      co.name           AS company_name,
      co.name_enc       AS company_name_enc,
      t.id              AS ticket_id,
      t.mot_ref         AS ticket_ref,
      t.title           AS ticket_title,
      t.title_enc       AS ticket_title_enc,
      f.user_id         AS follower_id,
      u.email           AS follower_email,
      u.display_name    AS follower_name
    FROM comments c
    JOIN tickets t ON t.id = c.ticket_id
    LEFT JOIN contacts  ct ON ct.id = c.vendor_contact_id
    LEFT JOIN companies co ON co.id = ct.company_id
    JOIN ticket_followers f ON f.ticket_id = t.id
    JOIN users u ON u.id = f.user_id
    WHERE c.is_muted = TRUE
      AND c.digested_at IS NULL
      AND c.created_at >= NOW() - INTERVAL '7 days'
      AND u.email IS NOT NULL AND u.email <> ''
      AND u.status = 'active'
  `);
  // Decrypt comment body / contact fields / ticket title in bulk.
  // We can't reuse decryptRows directly because each row mixes columns
  // from multiple tables, so we run the decrypt-by-table pieces by hand.
  const { decrypt } = require('./crypto');
  for (const row of r.rows) {
    if (row.comment_body_enc) {
      try { row.comment_body = await decrypt(row.comment_body_enc, 'comments.body'); }
      catch { row.comment_body = row.comment_body || ''; }
    }
    if (row.contact_name_enc) {
      try { row.contact_name = await decrypt(row.contact_name_enc, 'contacts.name'); } catch {}
    }
    if (row.contact_email_enc) {
      try { row.contact_email = await decrypt(row.contact_email_enc, 'contacts.email'); } catch {}
    }
    if (row.company_name_enc) {
      try { row.company_name = await decrypt(row.company_name_enc, 'companies.name'); } catch {}
    }
    if (row.ticket_title_enc) {
      try { row.ticket_title = await decrypt(row.ticket_title_enc, 'tickets.title'); } catch {}
    }
  }
  return r.rows;
}

function groupByFollower(rows) {
  // followerId → { email, name, tickets: Map<ticketId, { ref, title, comments: [] }> }
  const out = new Map();
  for (const row of rows) {
    if (!out.has(row.follower_id)) {
      out.set(row.follower_id, {
        email: row.follower_email,
        name:  row.follower_name,
        tickets: new Map(),
      });
    }
    const f = out.get(row.follower_id);
    if (!f.tickets.has(row.ticket_id)) {
      f.tickets.set(row.ticket_id, {
        ref: row.ticket_ref,
        title: row.ticket_title,
        url: `${APP_URL}/tickets/${row.ticket_id}`,
        comments: [],
      });
    }
    f.tickets.get(row.ticket_id).comments.push({
      id: row.comment_id,
      created_at: row.comment_created_at,
      body: row.comment_body,
      contact_name: row.contact_name,
      contact_email: row.contact_email,
      company_name: row.company_name,
    });
  }
  return out;
}

function renderHtml({ siteName, name, tickets }) {
  const totalComments = [...tickets.values()].reduce((a, t) => a + t.comments.length, 0);
  const ticketBlocks = [...tickets.values()].map(t => {
    const items = t.comments.map(c => {
      const who = c.contact_name
        ? `${c.contact_name}${c.company_name ? ` (${c.company_name})` : ''}`
        : (c.contact_email || 'external sender');
      return `<li style="margin:6px 0;color:#374151;font-size:13px">
        <span style="color:#6b7280;font-family:ui-monospace,monospace">[${fmt(c.created_at)}]</span>
        <strong>${esc(who)}</strong>: ${esc(preview(c.body))}
      </li>`;
    }).join('');
    return `<div style="margin:14px 0">
      <a href="${esc(t.url)}" style="color:#1d4ed8;font-weight:600;text-decoration:none">${esc(t.ref)}</a>
      <span style="color:#374151"> — ${esc(t.title || '(no title)')}</span>
      <span style="color:#9ca3af;font-size:12px"> · ${t.comments.length} muted ${t.comments.length === 1 ? 'reply' : 'replies'}</span>
      <ul style="margin:6px 0 0 0;padding:0 0 0 16px;list-style:disc">${items}</ul>
    </div>`;
  }).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#f9fafb;margin:0;padding:24px">
  <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
    <div style="padding:16px 24px;background:#111827;color:#fff">
      <strong>${esc(siteName)}</strong> — Muted vendor replies digest
    </div>
    <div style="padding:24px">
      <p style="margin:0 0 16px;color:#374151;font-size:14px">
        Hi ${esc(name || 'there')}, ${totalComments} muted vendor ${totalComments === 1 ? 'reply' : 'replies'} arrived
        on tickets you follow. Review anything that looks relevant and hit
        <em>Unmute</em> to bring it back into the main thread.
      </p>
      ${ticketBlocks}
      <p style="margin:24px 0 0;color:#9ca3af;font-size:12px">
        You're receiving this because you follow these tickets. To stop muting future vendor replies on a ticket, switch off
        "Auto-mute vendor replies" in the ticket settings.
      </p>
    </div>
  </div>
</body></html>`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  ));
}

async function runDigest({ markAsDigested = true } = {}) {
  const rows = await fetchPendingDigestRows(pool);
  if (rows.length === 0) return { sent: 0, recipients: 0, comments: 0 };

  const branding = await getBranding().catch(() => null);
  const siteName = branding?.site_name || 'Resolvd';

  const grouped = groupByFollower(rows);
  let sent = 0;
  for (const f of grouped.values()) {
    try {
      await sendMail({
        to: f.email,
        subject: `${siteName} — muted vendor replies digest`,
        html: renderHtml({ siteName, name: f.name, tickets: f.tickets }),
        headers: {
          'Auto-Submitted': 'auto-generated',
          'X-Resolvd-No-Reply': '1',
          'X-Resolvd-Digest': 'muted',
        },
      });
      sent++;
    } catch (err) {
      console.error(`mutedDigest: send to ${f.email} failed:`, err.message);
    }
  }

  if (markAsDigested) {
    const ids = [...new Set(rows.map(r => r.comment_id))];
    if (ids.length) {
      await pool.query(`UPDATE comments SET digested_at = NOW() WHERE id = ANY($1::int[])`, [ids]);
    }
  }
  return { sent, recipients: grouped.size, comments: new Set(rows.map(r => r.comment_id)).size };
}

// Decide whether the digest should fire now and run it once if so.
// Returns { ran: boolean, reason?: string, result? }.
async function tickOnce(now = new Date()) {
  const settings = await getAuthSettings().catch(() => null);
  if (!settings || settings.muted_digest_enabled === false) {
    return { ran: false, reason: 'disabled' };
  }
  const tz = settings.muted_digest_timezone || 'UTC';
  const targetH = settings.muted_digest_local_hour ?? 15;
  const targetM = settings.muted_digest_local_minute ?? 0;

  // Compute "now" in the configured timezone.
  let local;
  try {
    local = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  } catch {
    return { ran: false, reason: `bad timezone ${tz}` };
  }
  const localKey = `${local.year}-${local.month}-${local.day}`;
  const localMinutes = parseInt(local.hour, 10) * 60 + parseInt(local.minute, 10);
  const targetMinutes = targetH * 60 + targetM;
  if (localMinutes < targetMinutes) {
    return { ran: false, reason: 'before_target', localKey, localMinutes };
  }

  // Has the digest already fired for `localKey`?
  const job = await pool.query(`SELECT metadata FROM system_jobs WHERE name = 'muted_digest'`);
  const lastDay = job.rows[0]?.metadata?.last_local_day;
  if (lastDay === localKey) {
    return { ran: false, reason: 'already_today', localKey };
  }

  const result = await runDigest();
  await pool.query(
    `UPDATE system_jobs
        SET last_run_at = NOW(),
            last_status = $1,
            metadata = jsonb_build_object('last_local_day', $2::text, 'sent', $3::int, 'comments', $4::int)
      WHERE name = 'muted_digest'`,
    ['ok', localKey, result.sent, result.comments]
  );
  return { ran: true, localKey, result };
}

let _interval = null;
function startScheduler() {
  if (_interval) return;
  // 5-minute cadence balances "near the target time" and "doesn't burn CPU".
  _interval = setInterval(() => {
    tickOnce().catch(err => console.error('mutedDigest tick error:', err.message));
  }, 5 * 60 * 1000);
  // Fire once on boot so a long-down server catches up the same day it starts.
  tickOnce().catch(() => {});
}

module.exports = { runDigest, tickOnce, startScheduler };

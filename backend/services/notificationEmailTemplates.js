// Per-event email rendering for the notifications matrix.
//
// Event handlers each return { subject, html } given a payload snapshot.
// Used by:
//   - fanoutModule when digest=instant (sends immediately)
//   - outbox flusher renderDigest() (groups multiple events into one
//     email per recipient)
//
// HTML chrome (header/footer/site name) is shared via baseHtml() from
// email.js so branding stays consistent.
//
// Payload shape per event matches what's stashed in notification_outbox.payload.

const { marked } = require('marked');
const { baseHtml } = require('./email');

const APP_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

function ticketUrl(ticketId) { return `${APP_URL}/tickets/${ticketId}`; }

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  ));
}

function viewButton(url, label = 'View Ticket', color = '#1e40af') {
  return `<a href="${esc(url)}" style="display:inline-block;background:${color};color:#fff;text-decoration:none;padding:8px 16px;border-radius:6px;font-size:14px;font-weight:600">${esc(label)}</a>`;
}

const RENDERERS = {
  assignment(payload) {
    const { ticket_id, ticket_ref, ticket_title, actor_name } = payload;
    const subject = `[${ticket_ref}] Assigned to you`;
    const body = `
      <p style="color:#374151;font-size:14px;margin:0 0 12px">
        <strong>${esc(actor_name || 'Someone')}</strong> assigned <strong>${esc(ticket_ref)}</strong> to you.
      </p>
      <p style="color:#374151;font-size:14px;margin:0 0 16px"><strong>${esc(ticket_title || '')}</strong></p>
      ${viewButton(ticketUrl(ticket_id))}`;
    return { subject, body };
  },

  status_change(payload) {
    const { ticket_id, ticket_ref, ticket_title, old_status, new_status, is_closed } = payload;
    const subject = is_closed
      ? `[${ticket_ref}] Ticket closed`
      : `[${ticket_ref}] Status updated: ${old_status} → ${new_status}`;
    const body = `
      <p style="color:#374151;font-size:14px;margin:0 0 12px">
        ${is_closed
          ? `Ticket <strong>${esc(ticket_ref)}</strong> has been closed.`
          : `Status for <strong>${esc(ticket_ref)}</strong> has been updated from <strong>${esc(old_status)}</strong> to <strong>${esc(new_status)}</strong>.`}
      </p>
      <p style="color:#374151;font-size:14px;margin:0 0 16px"><strong>${esc(ticket_title || '')}</strong></p>
      ${viewButton(ticketUrl(ticket_id))}`;
    return { subject, body };
  },

  comment(payload) {
    const { ticket_id, ticket_ref, actor_name, comment_preview } = payload;
    const subject = `[${ticket_ref}] New comment added`;
    const previewHtml = marked(comment_preview || '');
    const body = `
      <p style="color:#374151;font-size:14px;margin:0 0 12px">
        <strong>${esc(actor_name || 'Someone')}</strong> added a comment on <strong>${esc(ticket_ref)}</strong>:
      </p>
      <blockquote style="border-left:3px solid #e5e7eb;margin:0 0 16px;padding:8px 16px;color:#6b7280;font-size:14px">${previewHtml}</blockquote>
      ${viewButton(ticketUrl(ticket_id))}`;
    return { subject, body };
  },

  mention(payload) {
    const { ticket_id, ticket_ref, ticket_title, actor_name } = payload;
    const subject = `[${ticket_ref}] You were mentioned`;
    const body = `
      <p style="color:#374151;font-size:14px;margin:0 0 12px">
        <strong>${esc(actor_name || 'Someone')}</strong> mentioned you on <strong>${esc(ticket_ref)}</strong>${ticket_title ? ` — ${esc(ticket_title)}` : ''}.
      </p>
      ${viewButton(ticketUrl(ticket_id))}`;
    return { subject, body };
  },

  pending_review(payload) {
    const { ticket_id, ticket_ref, ticket_title } = payload;
    const subject = `[${ticket_ref}] Needs review — action required`;
    const body = `
      <p style="color:#374151;font-size:14px;margin:0 0 12px">
        Ticket <strong>${esc(ticket_ref)}</strong> has been flagged for review and requires your attention.
      </p>
      <p style="color:#374151;font-size:14px;margin:0 0 16px"><strong>${esc(ticket_title || '')}</strong></p>
      ${viewButton(ticketUrl(ticket_id), 'Review Ticket', '#7c3aed')}`;
    return { subject, body };
  },

  follow_up(payload) {
    const { ticket_id, ticket_ref, ticket_title, internal_status, recipient_name } = payload;
    const subject = `[${ticket_ref}] Follow-up reminder`;
    const body = `
      <p>Hi ${esc(recipient_name || '')},</p>
      <p>You scheduled a follow-up on <strong>${esc(ticket_ref)}</strong>${ticket_title ? ` — ${esc(ticket_title)}` : ''}.</p>
      <p>Current status: <strong>${esc(internal_status || '')}</strong></p>
      <p>Verify the fix has held, then advance or reopen as needed.</p>
      ${viewButton(ticketUrl(ticket_id))}`;
    return { subject, body };
  },
};

async function renderEventEmail(eventType, payload) {
  const r = RENDERERS[eventType];
  if (!r) throw new Error(`No renderer for event type ${eventType}`);
  const { subject, body } = r(payload);
  const html = await baseHtml(subject, body);
  return { subject, html };
}

// Digest rendering: a single email summarising N buffered events for one
// recipient. Events grouped by ticket (one block per ticket, one line per
// event).
function eventLineLabel(eventType, payload) {
  switch (eventType) {
    case 'assignment':
      return `Assigned by ${esc(payload.actor_name || 'someone')}`;
    case 'status_change':
      return payload.is_closed
        ? `Closed`
        : `Status: ${esc(payload.old_status)} → ${esc(payload.new_status)}`;
    case 'comment': {
      const preview = (payload.comment_preview || '').replace(/\s+/g, ' ').trim();
      const trimmed = preview.length > 140 ? preview.slice(0, 140) + '…' : preview;
      return `${esc(payload.actor_name || 'Someone')} commented: ${esc(trimmed)}`;
    }
    case 'mention':
      return `${esc(payload.actor_name || 'Someone')} mentioned you`;
    default:
      return esc(eventType);
  }
}

async function renderDigest({ recipientName, ticketGroups }) {
  // ticketGroups: Array<{ ticket_id, ticket_ref, ticket_title, events: [{event_type, payload, created_at}] }>
  const totalEvents = ticketGroups.reduce((a, g) => a + g.events.length, 0);
  const subject = `Resolvd digest — ${totalEvents} update${totalEvents === 1 ? '' : 's'}`;
  const blocks = ticketGroups.map(g => {
    const items = g.events.map(e => `
      <li style="margin:6px 0;color:#374151;font-size:13px">
        <span style="color:#9ca3af;font-family:ui-monospace,monospace;font-size:11px">${new Date(e.created_at).toISOString().slice(11, 16)}</span>
        ${eventLineLabel(e.event_type, e.payload)}
      </li>`).join('');
    return `<div style="margin:16px 0;padding:12px 14px;background:#f9fafb;border-radius:6px;border:1px solid #e5e7eb">
      <div style="margin-bottom:6px">
        <a href="${ticketUrl(g.ticket_id)}" style="color:#1d4ed8;font-weight:600;text-decoration:none">${esc(g.ticket_ref)}</a>
        <span style="color:#374151"> — ${esc(g.ticket_title || '(no title)')}</span>
      </div>
      <ul style="margin:0;padding:0 0 0 16px;list-style:disc">${items}</ul>
    </div>`;
  }).join('');
  const body = `
    <p style="color:#374151;font-size:14px;margin:0 0 12px">
      Hi ${esc(recipientName || 'there')}, here's the latest activity on tickets you're following:
    </p>
    ${blocks}
    <p style="color:#9ca3af;font-size:12px;margin:24px 0 0">
      You're receiving this because your email digest is set to batch updates. Switch to <em>Instant</em> in
      Account Preferences → Notifications to get individual emails again.
    </p>`;
  const html = await baseHtml(subject, body);
  return { subject, html };
}

module.exports = { renderEventEmail, renderDigest };

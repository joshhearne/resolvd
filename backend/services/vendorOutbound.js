// Vendor-bound outbound: send a templated email to every active contact
// linked to a ticket when an admin/manager fires a vendor-visible event
// (new_ticket, vendor-visible comment, status change, resolved).
//
// Loop prevention strategy:
//   1. Outbound carries Auto-Submitted: auto-generated so RFC-3834-aware
//      auto-responders on the vendor side won't auto-reply.
//   2. Custom X-Resolvd-No-Reply: 1 marker — Phase D's inbound webhook
//      drops anything carrying it, killing reflective loops cold.
//   3. From is always the connected mailbox (see services/email.js);
//      actor identity rides as the display name. Reply-To defaults to the
//      same mailbox so vendor replies always land in the unmatched-email
//      queue. INBOUND_REPLY_TO env can override Reply-To if needed.
//
// Encryption note: under standard mode the renderer pulls plaintext from
// services/fields.decryptRow before composing. The outbound message
// body is therefore plaintext on the wire — this is unavoidable: the
// recipient is an external party who has no key. Vault mode (Phase 4)
// will route this through the browser instead.

const path = require('path');
const fsp = require('fs').promises;
const { pool } = require('../db/pool');
const { decryptRow, decryptRows } = require('./fields');
const { decrypt } = require('./crypto');
const { sendMail, baseHtml } = require('./email');
const { loadTemplate, render } = require('./emailTemplate');
const { getBranding } = require('./branding');

const APP_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
const REPLY_TO = process.env.INBOUND_REPLY_TO || null;
const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';

// Outbound attachment caps. Most enterprise mail relays cap a single
// message at 25–35 MB total including base64 encoding overhead (~33%).
// We cap raw bytes well below that so the encoded payload still fits.
//   per-file: 10 MB — single large PDF / video stays sendable
//   total:    20 MB — comfortable headroom under Graph's 25 MB body limit
// Env overrides (whole MB):
//   VENDOR_ATTACH_PER_FILE_MB — bump per-file cap. Graph rejects single
//     fileAttachment payloads over ~3 MB unless you switch to the chunked
//     upload-session API, so practical Graph ceiling stays around 3 MB
//     per file even though SMTP/Gmail accept more. SMTP caps depend on
//     the relay (Exchange Online: 25 MB; most cloud providers: 25–35 MB).
//   VENDOR_ATTACH_TOTAL_MB — bump total per-message cap. The base64
//     encoding of binary attachments inflates wire bytes by ~33%, so
//     keep this 25–30% below the relay's hard cap.
// Anything exceeding the caps is dropped from the message with a console
// warn naming the file; recipients see the body without it. The original
// attachments stay on the ticket so internal viewers still have them.
const ATTACH_PER_FILE_BYTES = Math.max(1, Number(process.env.VENDOR_ATTACH_PER_FILE_MB) || 10) * 1024 * 1024;
const ATTACH_TOTAL_BYTES    = Math.max(1, Number(process.env.VENDOR_ATTACH_TOTAL_MB)    || 20) * 1024 * 1024;

// Pulls every ticket attachment that has not yet been delivered to the
// vendor (sent_to_vendor_at IS NULL). Covers both:
//   - new_ticket: brand-new ticket, every file is unsent → all go.
//   - new_comment: vendor-visible comment fires after an internal
//     back-and-forth. Files uploaded during that back-and-forth (whether
//     attached directly to the ticket or to an internal comment) are
//     still unsent, so they ride along with the escalation. This is the
//     fix for the L1-tech-escalates case: previously a vendor-visible
//     comment only carried the files linked to that comment row, so
//     attachments uploaded earlier were silently filtered out.
// Returns objects with `id` so the caller can stamp sent_to_vendor_at
// on the rows that actually made it onto the wire (size-capped files
// are excluded from the stamp so a later send can retry them).
async function fetchUnsentAttachments({ ticketId }) {
  const sql = `
    SELECT id, filename, original_name, mimetype, size, encrypted_at_rest
      FROM attachments
     WHERE ticket_id = $1
       AND sent_to_vendor_at IS NULL
     ORDER BY created_at ASC
  `;
  const r = await pool.query(sql, [ticketId]);

  const result = [];
  let total = 0;
  for (const row of r.rows) {
    if (row.size && row.size > ATTACH_PER_FILE_BYTES) {
      console.warn(`vendorOutbound: skipping ${row.original_name || row.filename} — ${row.size} bytes exceeds per-file cap`);
      continue;
    }
    if (total + (row.size || 0) > ATTACH_TOTAL_BYTES) {
      console.warn(`vendorOutbound: skipping ${row.original_name || row.filename} — total payload would exceed cap`);
      continue;
    }
    try {
      const raw = await fsp.readFile(path.join(UPLOADS_DIR, row.filename));
      const data = row.encrypted_at_rest
        ? await decrypt(raw, `attachments.file:${row.filename}`, { raw: true })
        : raw;
      // Recheck against decrypted size — encryption overhead is small but
      // we accumulate against the actual bytes we're about to send.
      if (total + data.length > ATTACH_TOTAL_BYTES) {
        console.warn(`vendorOutbound: skipping ${row.original_name || row.filename} — decrypted bytes would exceed cap`);
        continue;
      }
      result.push({
        id: row.id,
        filename: row.original_name || row.filename,
        mimetype: row.mimetype || 'application/octet-stream',
        data,
      });
      total += data.length;
    } catch (e) {
      console.warn(`vendorOutbound: skipping attachment ${row.filename}:`, e.message);
    }
  }
  return result;
}

async function fetchTicketContext(ticketId, actorId) {
  const t = await pool.query(`SELECT * FROM tickets WHERE id = $1`, [ticketId]);
  if (!t.rows[0]) return null;
  await decryptRow('tickets', t.rows[0]);

  let actor = null;
  if (actorId) {
    const u = await pool.query(`SELECT id, display_name, email FROM users WHERE id = $1`, [actorId]);
    actor = u.rows[0] || null;
  }

  let submitterEmail = null;
  if (t.rows[0].submitted_by) {
    const s = await pool.query(`SELECT email FROM users WHERE id = $1`, [t.rows[0].submitted_by]);
    submitterEmail = s.rows[0]?.email || null;
  }

  const branding = await getBranding().catch(() => null);
  return {
    ticket: { ...t.rows[0], url: `${APP_URL}/tickets/${ticketId}` },
    actor,
    submitterEmail,
    site: { name: branding?.site_name || 'Resolvd', url: APP_URL },
  };
}

async function fetchTicketContacts(ticketId) {
  const r = await pool.query(`
    SELECT c.*, co.id AS company_id, co.name AS company_name, co.name_enc AS company_name_enc,
           co.domain AS company_domain, co.notification_prefs AS company_notification_prefs
      FROM ticket_contacts tc
      JOIN contacts c ON c.id = tc.contact_id
      JOIN companies co ON co.id = c.company_id
     WHERE tc.ticket_id = $1
       AND c.is_active = TRUE
  `, [ticketId]);
  await decryptRows('contacts', r.rows, { aliases: { company_name: 'companies.name' } });
  return r.rows;
}

const NOTIF_DEFAULTS = {
  on_status_change: true,
  status_change_statuses: [],   // [] = all internal statuses
  on_ticket_resolved: true,
  on_ticket_reopened: false,
};

function companyAllows(contact, eventType, ticketStatusName) {
  const prefs = { ...NOTIF_DEFAULTS, ...(contact.company_notification_prefs || {}) };
  if (eventType === 'status_change') {
    if (!prefs.on_status_change) return false;
    if (prefs.status_change_statuses?.length > 0) {
      return prefs.status_change_statuses.includes(ticketStatusName);
    }
    return true;
  }
  if (eventType === 'ticket_resolved') return prefs.on_ticket_resolved;
  if (eventType === 'ticket_reopened') return prefs.on_ticket_reopened;
  return true; // new_ticket, new_comment always allowed
}

const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');

const MD_ALLOWED_TAGS = [
  'p', 'br', 'strong', 'em', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'span', 'div',
];
const MD_ALLOWED_ATTRS = {
  a: ['href', 'title', 'target', 'rel'],
};

function htmlify(body) {
  // Render markdown so canned responses + comments composed in markdown
  // (e.g. hyperlinks via [label](url)) reach vendor inboxes as real HTML.
  // Raw HTML in the source is stripped by sanitizeHtml so only the tag
  // set produced by marked survives. Falls back to escaped pre-wrap on
  // any rendering error so the vendor still gets the body content.
  let rendered;
  try {
    rendered = marked.parse(String(body || ''), { breaks: true, gfm: true });
  } catch (err) {
    console.error('vendor outbound markdown render failed:', err.message);
    const escaped = String(body || '').replace(/[&<>]/g, (c) => c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;');
    return `<div style="font-family:system-ui,-apple-system,sans-serif;white-space:pre-wrap;font-size:14px;color:#111827">${escaped}</div>`;
  }
  const safe = sanitizeHtml(rendered, {
    allowedTags: MD_ALLOWED_TAGS,
    allowedAttributes: MD_ALLOWED_ATTRS,
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
    },
  });
  return `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#111827;line-height:1.5">${safe}</div>`;
}

// Visible marker prepended to every outbound vendor email body. The
// inbound parser cuts at the first occurrence so anything quoted below
// (the original message, signatures, mail-client banners) is dropped
// before the reply lands as a comment. Phrasing is intentionally
// human-readable; the surrounding `---` triple-dash bookends are the
// machine token. Triple-dash on its own won't collide with stripSignature
// (which requires four-or-more dashes for a sig boundary).
const REPLY_MARKER_TEXT = 'Type your reply above this line';
function replyMarkerHtml(ticketRef) {
  const ref = ticketRef ? ` — ticket ${ticketRef}` : '';
  return `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:11px;color:#9ca3af;border-bottom:1px solid #e5e7eb;padding:0 0 8px;margin:0 0 16px;text-align:center;letter-spacing:0.01em">--- ${REPLY_MARKER_TEXT}${ref} ---</div>`;
}

async function sendVendorEmail({ eventType, ticketId, actorId, commentId = null }) {
  // Status/resolved notifications only go out if the vendor was already
  // contacted about this ticket (new_ticket or vendor-visible comment sent).
  if (eventType === 'status_change' || eventType === 'ticket_resolved') {
    const r = await pool.query(
      `SELECT vendor_notified_at FROM tickets WHERE id = $1`,
      [ticketId]
    );
    if (!r.rows[0]?.vendor_notified_at) return { sent: 0, skipped: 1 };
  }
  // Terminal-status gate for non-closing events: a closed ticket
  // shouldn't ping vendors with new comments / re-fires. status_change
  // and ticket_resolved are exempt — that's how the vendor learns the
  // ticket reached its terminal state.
  if (eventType !== 'status_change' && eventType !== 'ticket_resolved') {
    const t = await pool.query(
      `SELECT 1 FROM tickets t
         JOIN statuses s ON s.kind='internal' AND s.name=t.internal_status
        WHERE t.id = $1 AND s.is_terminal = TRUE LIMIT 1`,
      [ticketId]
    );
    if (t.rowCount) return { sent: 0, skipped: 1 };
  }

  const tplRow = await loadTemplate(eventType, 'vendor');
  if (!tplRow) {
    console.warn(`vendorOutbound: no template for event=${eventType} audience=vendor`);
    return { sent: 0, skipped: 0 };
  }
  const ctx = await fetchTicketContext(ticketId, actorId);
  if (!ctx) return { sent: 0, skipped: 0 };
  const contacts = await fetchTicketContacts(ticketId);
  if (!contacts.length) return { sent: 0, skipped: 0 };

  // new_ticket + new_comment both send every ticket attachment that
  // hasn't been delivered to the vendor yet (sent_to_vendor_at IS NULL).
  // This covers the L1-escalation flow: files uploaded during internal
  // back-and-forth, before anyone flipped a comment vendor-visible,
  // get attached on the first vendor-bound send. status_change /
  // ticket_resolved carry no attachments by design — they're status
  // pings, not file deliveries.
  const attachments = (eventType === 'new_ticket' || eventType === 'new_comment')
    ? await fetchUnsentAttachments({ ticketId })
    : [];
  // sendMail consumers (Graph/Gmail/SMTP) read filename/mimetype/data;
  // the `id` we tracked for the post-send stamp is for our own bookkeeping
  // and shouldn't bleed into the wire payload. Compute once, share across
  // every recipient in the loop.
  const wireAttachments = attachments.map(a => ({
    filename: a.filename, mimetype: a.mimetype, data: a.data,
  }));

  const ticketStatusName = ctx.ticket.internal_status || '';

  let sent = 0;
  let failed = 0;
  for (const contact of contacts) {
    if (!contact.email) { failed++; continue; }
    if (!companyAllows(contact, eventType, ticketStatusName)) continue;
    const personalCtx = {
      ...ctx,
      contact: {
        name: contact.name,
        email: contact.email,
        role_title: contact.role_title,
      },
      company: { name: contact.company_name, domain: contact.company_domain },
    };
    try {
      const rendered = await render(tplRow, personalCtx);
      // Always convert to structured HTML. Plain-text templates need htmlify
      // so newlines render as visual line breaks (white-space:pre-wrap).
      // HTML templates are treated as partial markup — not full documents.
      // Either way, wrap in baseHtml for consistent branded email layout.
      const bodyHtml = tplRow.is_html ? rendered.body : htmlify(rendered.body);
      const composed = replyMarkerHtml(ctx.ticket.internal_ref) + bodyHtml;
      const html = await baseHtml(rendered.subject, composed);
      // Compose `Actor via SiteName` so vendors see the human who sent
      // the message while the envelope From + Reply-To remain the
      // monitored mailbox. The `via` pattern is the standard convention
      // for proxied/automated mail (mailing lists, GitHub notifications,
      // Gmail "Send mail as") — Outlook and Gmail render it consistently
      // without overriding from a directory match, and anti-spoof filters
      // (Inky VIP, Mimecast Impersonation Protect, etc.) recognize it as
      // legitimate rather than treating `Name <unrelated@addr>` as an
      // exec impersonation attempt. Falls back to email local-part, then
      // to the bare site name when no actor is available.
      const actorLabel = ctx.actor?.display_name
        || ctx.actor?.email?.split('@')[0]
        || null;
      const senderName = actorLabel
        ? `${actorLabel} via ${ctx.site.name}`
        : ctx.site.name;
      await sendMail({
        to: contact.email,
        subject: rendered.subject,
        html,
        replyTo: REPLY_TO,
        senderName,
        projectId: ctx.ticket.project_id,
        attachments: wireAttachments,
        headers: {
          'Auto-Submitted': 'auto-generated',
          'X-Auto-Response-Suppress': 'All',
          'Precedence': 'bulk',
          'X-Resolvd-No-Reply': '1',
          'X-Resolvd-Ticket': String(ctx.ticket.internal_ref || ticketId),
        },
      });
      sent++;
    } catch (err) {
      console.error(`vendorOutbound to ${contact.email} failed:`, err.message);
      failed++;
    }
  }
  // Stamp first-contact timestamp so future status/resolved events know
  // the vendor has been in the loop.
  if (sent > 0 && (eventType === 'new_ticket' || eventType === 'new_comment')) {
    await pool.query(
      `UPDATE tickets SET vendor_notified_at = NOW() WHERE id = $1 AND vendor_notified_at IS NULL`,
      [ticketId]
    );
    // Stamp every attachment that actually rode on this send so the
    // next vendor-bound event doesn't re-attach the same files. Only
    // runs when sent>0 — if every recipient errored, leave them unsent
    // so a retry can carry them. Size-capped files were already
    // filtered out by fetchUnsentAttachments and stay unsent for the
    // same retry-on-next-send reason.
    const sentIds = attachments.map(a => a.id).filter(Boolean);
    if (sentIds.length) {
      await pool.query(
        `UPDATE attachments SET sent_to_vendor_at = NOW()
          WHERE id = ANY($1::int[]) AND sent_to_vendor_at IS NULL`,
        [sentIds]
      );
    }
  }

  return { sent, failed, audience: contacts.length };
}

module.exports = { sendVendorEmail };

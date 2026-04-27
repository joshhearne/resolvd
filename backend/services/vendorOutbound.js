// Vendor-bound outbound: send a templated email to every active contact
// linked to a ticket when an admin/manager fires a vendor-visible event
// (new_ticket, vendor-visible comment, status change, resolved).
//
// Loop prevention strategy:
//   1. Outbound carries Auto-Submitted: auto-generated so RFC-3834-aware
//      auto-responders on the vendor side won't auto-reply.
//   2. Custom X-Resolvd-No-Reply: 1 marker — Phase D's inbound webhook
//      drops anything carrying it, killing reflective loops cold.
//   3. Reply-To, when INBOUND_REPLY_TO is configured, points at the
//      tenant's inbound mailbox so the vendor's reply lands in our
//      unmatched-email queue, not in someone's personal inbox.
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

async function fetchTicketImages(ticketId) {
  const r = await pool.query(
    `SELECT filename, original_name, mimetype, encrypted_at_rest
     FROM attachments WHERE ticket_id = $1 AND mimetype LIKE 'image/%'
     ORDER BY created_at ASC`,
    [ticketId]
  );
  const result = [];
  for (const row of r.rows) {
    try {
      const raw = await fsp.readFile(path.join(UPLOADS_DIR, row.filename));
      const data = row.encrypted_at_rest
        ? await decrypt(raw, `attachments.file:${row.filename}`, { raw: true })
        : raw;
      result.push({ filename: row.original_name || row.filename, mimetype: row.mimetype, data });
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
           co.domain AS company_domain
      FROM ticket_contacts tc
      JOIN contacts c ON c.id = tc.contact_id
      JOIN companies co ON co.id = c.company_id
     WHERE tc.ticket_id = $1
       AND c.is_active = TRUE
  `, [ticketId]);
  await decryptRows('contacts', r.rows, { aliases: { company_name: 'companies.name' } });
  return r.rows;
}

function htmlify(body) {
  // Plaintext template body → minimally-formatted HTML for backends that
  // expect content-type text/html (Graph default).
  const escaped = body.replace(/[&<>]/g, (c) => c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;');
  return `<div style="font-family:system-ui,-apple-system,sans-serif;white-space:pre-wrap;font-size:14px;color:#111827">${escaped}</div>`;
}

async function sendVendorEmail({ eventType, ticketId, actorId }) {
  const tplRow = await loadTemplate(eventType, 'vendor');
  if (!tplRow) {
    console.warn(`vendorOutbound: no template for event=${eventType} audience=vendor`);
    return { sent: 0, skipped: 0 };
  }
  const ctx = await fetchTicketContext(ticketId, actorId);
  if (!ctx) return { sent: 0, skipped: 0 };
  const contacts = await fetchTicketContacts(ticketId);
  if (!contacts.length) return { sent: 0, skipped: 0 };

  const imageAttachments = await fetchTicketImages(ticketId);

  let sent = 0;
  let failed = 0;
  for (const contact of contacts) {
    if (!contact.email) { failed++; continue; }
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
      const html = await baseHtml(rendered.subject, bodyHtml);
      await sendMail({
        to: contact.email,
        subject: rendered.subject,
        html,
        replyTo: REPLY_TO,
        submitterEmail: ctx.submitterEmail,
        attachments: imageAttachments,
        headers: {
          'Auto-Submitted': 'auto-generated',
          'X-Auto-Response-Suppress': 'All',
          'Precedence': 'bulk',
          'X-Resolvd-No-Reply': '1',
          'X-Resolvd-Ticket': String(ctx.ticket.mot_ref || ticketId),
        },
      });
      sent++;
    } catch (err) {
      console.error(`vendorOutbound to ${contact.email} failed:`, err.message);
      failed++;
    }
  }
  return { sent, failed, audience: contacts.length };
}

module.exports = { sendVendorEmail };

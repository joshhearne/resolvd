// Lightweight tag substitution for canned-response bodies. Smaller scope
// than emailTemplate.render — no replies, no encryption, no HTML escape
// (canned text lands inside markdown comments where the editor handles
// escaping). Unknown tags pass through unchanged so admins see exactly
// what they typed.
//
// Supported tags:
//   {ticket.ref}            ticket.internal_ref
//   {ticket.title}
//   {ticket.priority}
//   {ticket.url}
//   {ticket.vendor_ref}     external_ticket_ref
//   {ticket.submitter}      submitting user's display name (alias)
//   {submitter.name}        submitting user's display name
//   {submitter.firstName}   first whitespace-delimited token of display name
//   {submitter.email}
//   {assignee.name}         currently-assigned user
//   {assignee.firstName}
//   {assignee.email}
//   {actor.name}            current user (the one inserting the response)
//   {actor.firstName}
//   {actor.email}
//   {site.name}             branding.site_name (Admin → Branding)
//   {site.url}              FRONTEND_URL

const { pool } = require('../db/pool');

const TAG_RE = /\{([a-z_]+)\.([a-z_0-9]+)\}/gi;

function firstName(displayName) {
  if (!displayName) return '';
  // Trim, take first whitespace-delimited token. Handles "Jane Doe",
  // "Dr. Bob", "Alex" → all yield the leading word.
  const trimmed = String(displayName).trim();
  if (!trimmed) return '';
  return trimmed.split(/\s+/)[0];
}

function userNamespace(row) {
  if (!row) return { name: '', firstName: '', email: '' };
  return {
    name: row.display_name || '',
    firstname: firstName(row.display_name || ''),
    // Resolver lower-cases field names so {submitter.firstName} matches
    // both `firstname` and `firstName` in stored bodies.
    email: row.email || '',
  };
}

async function buildContext({ ticketId, actorId }) {
  const ctx = { ticket: {}, submitter: {}, assignee: {}, actor: {}, site: {} };

  const branding = await pool.query(`SELECT site_name FROM branding WHERE id = 1`).catch(() => null);
  ctx.site.name = branding?.rows[0]?.site_name || 'Resolvd';
  ctx.site.url = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

  if (ticketId) {
    const r = await pool.query(
      `SELECT t.id, t.internal_ref, t.title, t.effective_priority, t.external_ticket_ref,
              sub.display_name AS submitter_name, sub.email AS submitter_email,
              asgn.display_name AS assignee_name, asgn.email AS assignee_email
         FROM tickets t
         LEFT JOIN users sub ON sub.id = t.submitted_by
         LEFT JOIN users asgn ON asgn.id = t.assigned_to
        WHERE t.id = $1`,
      [ticketId]
    );
    const t = r.rows[0];
    if (t) {
      ctx.ticket.id = t.id;
      ctx.ticket.ref = t.internal_ref;
      ctx.ticket.title = t.title || '';
      ctx.ticket.priority = String(t.effective_priority || '');
      ctx.ticket.url = `${ctx.site.url}/tickets/${t.id}`;
      ctx.ticket.vendor_ref = t.external_ticket_ref || '';
      ctx.ticket.submitter = t.submitter_name || '';
      ctx.submitter = userNamespace({ display_name: t.submitter_name, email: t.submitter_email });
      ctx.assignee = userNamespace({ display_name: t.assignee_name, email: t.assignee_email });
    }
  }

  if (actorId) {
    const u = await pool.query(
      `SELECT display_name, email FROM users WHERE id = $1`,
      [actorId]
    );
    ctx.actor = userNamespace(u.rows[0]);
  }

  return ctx;
}

function applyTags(body, ctx) {
  if (!body) return '';
  return body.replace(TAG_RE, (match, ns, field) => {
    const namespace = ctx[ns.toLowerCase()];
    if (!namespace) return match;
    const v = namespace[field.toLowerCase()];
    return v == null || v === '' ? match : String(v);
  });
}

async function render(body, { ticketId, actorId }) {
  const ctx = await buildContext({ ticketId, actorId });
  return applyTags(body, ctx);
}

module.exports = { render, applyTags, buildContext };

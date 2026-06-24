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
//   {ticket.host}           hostname pulled from the most-recent alert's
//                           payload (Zabbix {HOST.HOST} tag, etc.)
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
//   {user.display_name}     alias for {actor.name} (used by seeded
//                           restock templates)
//   {consumable.part_no}    Resolved when consumableId is supplied OR
//   {consumable.title}      when the ticket has a consumable_movement;
//   {consumable.vendor_part_no}
//   {consumable.purchase_url}
//   {consumable.reorder_qty}
//   {consumable.current_stock}
//   {vendor.name}           vendor company on the resolved consumable
//   {site.name}             branding.site_name (Admin → Branding)
//   {site.url}              FRONTEND_URL

const { pool } = require('../db/pool');
const ticketCustomFields = require('./ticketCustomFields');

const TAG_RE = /\{([a-z_]+)\.([a-z_0-9]+)\}/gi;
// Custom-field tags use the field's slug, which can contain hyphens
// (e.g. {field.inc-motility-temp-password}) — a separate, hyphen-tolerant
// pass since TAG_RE's key class excludes '-'.
const FIELD_RE = /\{field\.([a-z0-9_-]+)\}/gi;

function firstName(displayName) {
  if (!displayName) return '';
  // Trim, take first whitespace-delimited token. Handles "Jane Doe",
  // "Dr. Bob", "Alex" → all yield the leading word.
  const trimmed = String(displayName).trim();
  if (!trimmed) return '';
  return trimmed.split(/\s+/)[0];
}

function userNamespace(row) {
  if (!row) return { name: '', firstname: '', email: '', display_name: '' };
  const display = row.display_name || '';
  return {
    name: display,
    display_name: display,
    firstname: firstName(display),
    // Resolver lower-cases field names so {submitter.firstName} matches
    // both `firstname` and `firstName` in stored bodies.
    email: row.email || '',
  };
}

// Pull {HOST.HOST} / hostname out of an alert payload. Zabbix renders
// host in event_tags as `host:srv01` and in the structured tags array
// as `{tag:'host', value:'srv01'}`; fall back to vendor_ref when
// nothing else is available.
function extractHostFromPayload(payload) {
  if (!payload) return '';
  const tagsRaw = payload.event_tags;
  if (typeof tagsRaw === 'string' && tagsRaw) {
    for (const part of tagsRaw.split(',')) {
      const m = /^\s*host\s*:\s*(.+?)\s*$/i.exec(part);
      if (m && m[1]) return m[1];
    }
  }
  if (Array.isArray(payload.tags)) {
    for (const t of payload.tags) {
      if (t && /^host(\.host)?$/i.test(String(t.tag || '').trim()) && t.value) {
        return String(t.value).trim();
      }
    }
  }
  return '';
}

async function loadConsumableContext(consumableId) {
  if (!consumableId) return { consumable: {}, vendor: {} };
  const r = await pool.query(
    `SELECT c.id, c.part_no, c.title, c.vendor_part_no, c.purchase_url,
            c.reorder_qty, c.current_stock, c.low_stock_threshold,
            c.is_metered, co.name AS vendor_company_name
       FROM consumables c
       LEFT JOIN companies co ON co.id = c.vendor_company_id
      WHERE c.id = $1`,
    [consumableId]
  );
  const row = r.rows[0];
  if (!row) return { consumable: {}, vendor: {} };
  return {
    consumable: {
      part_no: row.part_no || '',
      title: row.title || '',
      vendor_part_no: row.vendor_part_no || '',
      purchase_url: row.purchase_url || '',
      reorder_qty: row.reorder_qty != null ? String(row.reorder_qty) : '',
      current_stock: row.current_stock != null ? String(row.current_stock) : '',
      low_stock_threshold: row.low_stock_threshold != null ? String(row.low_stock_threshold) : '',
    },
    vendor: { name: row.vendor_company_name || '' },
  };
}

async function buildContext({ ticketId, actorId, consumableId }) {
  const ctx = {
    ticket: {}, submitter: {}, assignee: {}, actor: {}, user: {},
    site: {}, consumable: {}, vendor: {}, field: {},
  };

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

    // Custom-field values for {field.<slug>} tags. The agent is composing the
    // response, so sensitive/agent-only values are revealed here.
    try {
      const cfs = await ticketCustomFields.readValues(pool, ticketId, { reveal: true });
      for (const f of cfs) {
        const v = f.type === 'bool' ? (f.value ? 'Yes' : 'No')
          : Array.isArray(f.value) ? f.value.join(', ')
          : (f.value == null ? '' : f.value);
        ctx.field[String(f.slug).toLowerCase()] = String(v);
      }
    } catch { /* custom fields are best-effort */ }

    // Pull hostname from the most-recent alert payload on the ticket.
    // No-op when the ticket wasn't created from an alert.
    try {
      const ar = await pool.query(
        `SELECT raw_payload FROM alerts
          WHERE ticket_id = $1
          ORDER BY last_seen_at DESC NULLS LAST, id DESC
          LIMIT 1`,
        [ticketId]
      );
      const host = extractHostFromPayload(ar.rows[0]?.raw_payload);
      if (host) ctx.ticket.host = host;
    } catch { /* host is best-effort */ }

    // If no consumable was passed explicitly, fall back to the most
    // recent consumable_movement on the ticket — typical "I just
    // dispatched X and now I'm emailing the vendor to restock" flow.
    if (!consumableId) {
      try {
        const cm = await pool.query(
          `SELECT consumable_id FROM consumable_movements
            WHERE ticket_id = $1
            ORDER BY at DESC
            LIMIT 1`,
          [ticketId]
        );
        if (cm.rows[0]?.consumable_id) consumableId = cm.rows[0].consumable_id;
      } catch { /* fallback is best-effort */ }
    }
  }

  if (actorId) {
    const u = await pool.query(
      `SELECT display_name, email FROM users WHERE id = $1`,
      [actorId]
    );
    ctx.actor = userNamespace(u.rows[0]);
    // {user.display_name} alias — the seeded restock templates were
    // written against {user.display_name} before {actor.*} existed.
    ctx.user = { ...ctx.actor };
  }

  const consCtx = await loadConsumableContext(consumableId);
  ctx.consumable = consCtx.consumable;
  ctx.vendor = consCtx.vendor;

  return ctx;
}

function applyTags(body, ctx) {
  if (!body) return '';
  let out = body.replace(TAG_RE, (match, ns, field) => {
    const namespace = ctx[ns.toLowerCase()];
    if (!namespace) return match;
    const v = namespace[field.toLowerCase()];
    return v == null || v === '' ? match : String(v);
  });
  // Hyphen-tolerant custom-field pass for {field.<slug>}.
  out = out.replace(FIELD_RE, (match, slug) => {
    const v = ctx.field ? ctx.field[String(slug).toLowerCase()] : undefined;
    return v == null || v === '' ? match : String(v);
  });
  return out;
}

async function render(body, { ticketId, actorId, consumableId } = {}) {
  const ctx = await buildContext({ ticketId, actorId, consumableId });
  return applyTags(body, ctx);
}

module.exports = { render, applyTags, buildContext };

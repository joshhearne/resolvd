// Email template renderer. Templates live in the email_templates table;
// admins edit subject/body via the API. Tags use the syntax
//   {namespace.field}            — static lookup (vendor.name, ticket.ref, …)
//   {namespace.field.N}          — parameterised, currently only ticket.replies.N
// Unknown tags are preserved verbatim so a stray "{literal}" never breaks
// rendering; admins see exactly what they typed.
//
// Under standard mode, this module pulls plaintext via decryptRow before
// interpolating, so outbound mail still goes out in cleartext (it has to).
// Internal-only comments (is_internal=TRUE) are excluded from
// {ticket.reply} / {ticket.replies.N} so leaks can't happen via templates.

const { marked } = require('marked');
const { pool } = require('../db/pool');
const { decryptRow, decryptRows } = require('./fields');

const TAG_RE = /\{([a-z_]+)\.([a-z_0-9]+)(?:\.(\d+))?\}/gi;
const REPLIES_HARD_CAP = 20;

function htmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;'  :
    c === '>' ? '&gt;'  :
    c === '"' ? '&quot;': '&#39;'
  ));
}

async function loadTemplate(event_type, audience) {
  const r = await pool.query(
    `SELECT * FROM email_templates WHERE event_type = $1 AND audience = $2 AND enabled = TRUE`,
    [event_type, audience]
  );
  return r.rows[0] || null;
}

async function fetchVendorVisibleReplies(ticketId, count) {
  const r = await pool.query(
    `SELECT c.*, u.display_name AS user_name
       FROM comments c
       LEFT JOIN users u ON u.id = c.user_id
      WHERE c.ticket_id = $1
        AND c.is_external_visible = TRUE
        AND c.is_system = FALSE
      ORDER BY c.created_at DESC
      LIMIT $2`,
    [ticketId, Math.min(count, REPLIES_HARD_CAP)]
  );
  await decryptRows('comments', r.rows);
  // Oldest-first when displayed in body so threads read top-down.
  return r.rows.reverse();
}

function formatReplyText(comment) {
  if (!comment) return '';
  const when = new Date(comment.created_at).toISOString().slice(0, 16).replace('T', ' ');
  const who = comment.user_name || 'system';
  return `[${when} UTC] ${who}: ${comment.body || ''}`;
}

function formatRepliesText(comments) {
  return comments.map(formatReplyText).join('\n');
}

function formatReplyHtml(comment) {
  if (!comment) return '';
  const when = new Date(comment.created_at).toISOString().slice(0, 16).replace('T', ' ');
  const who = htmlEscape(comment.user_name || 'system');
  const bodyHtml = marked(comment.body || '');
  return `<div style="margin-bottom:12px"><span style="font-size:12px;color:#6b7280">${when} UTC — ${who}</span>${bodyHtml}</div>`;
}

function formatRepliesHtml(comments) {
  return comments.map(formatReplyHtml).join('');
}

// Build a value resolver bound to ctx + replies.
function makeResolver(ctx, replies, escape) {
  const enc = (v) => v == null ? '' : (escape ? htmlEscape(v) : String(v));
  return (ns, field, count) => {
    if (ns === 'ticket' && field === 'replies' && count) {
      const n = Math.max(1, Math.min(parseInt(count, 10), REPLIES_HARD_CAP));
      return escape
        ? formatRepliesHtml(replies.slice(-n))
        : formatRepliesText(replies.slice(-n));
    }
    const key = `${ns}.${field}`;
    switch (key) {
      case 'vendor.name':           return enc(ctx.company?.name);
      case 'vendor.domain':         return enc(ctx.company?.domain);
      case 'vendor.contact':        return enc(ctx.contact?.name || ctx.contact?.email);
      case 'vendor.contact_email':  return enc(ctx.contact?.email);
      case 'vendor.contact_role':   return enc(ctx.contact?.role_title);
      case 'company.name':          return enc(ctx.company?.name);
      case 'ticket.id':             return enc(ctx.ticket?.id);
      case 'ticket.ref':            return enc(ctx.ticket?.internal_ref);
      case 'ticket.external_ref':   return enc(ctx.ticket?.external_ticket_ref);
      case 'ticket.title':          return enc(ctx.ticket?.title);
      case 'ticket.description':    return ctx.ticket?.description == null ? ''
        : (escape ? marked(ctx.ticket.description) : String(ctx.ticket.description));
      case 'ticket.status':         return enc(ctx.ticket?.internal_status);
      case 'ticket.priority':       return enc(ctx.ticket?.effective_priority);
      case 'ticket.url':            return enc(ctx.ticket?.url || `${ctx.site?.url || ''}/tickets/${ctx.ticket?.id}`);
      case 'ticket.created_at':     return enc(ctx.ticket?.created_at);
      case 'ticket.updated_at':     return enc(ctx.ticket?.updated_at);
      case 'ticket.reply':          return escape
        ? formatReplyHtml(replies[replies.length - 1])
        : formatReplyText(replies[replies.length - 1]);
      case 'actor.name':            return enc(ctx.actor?.display_name || ctx.actor?.name);
      case 'actor.email':           return enc(ctx.actor?.email);
      case 'site.name':             return enc(ctx.site?.name);
      case 'site.url':              return enc(ctx.site?.url);
      default:                      return null; // unknown — preserve verbatim
    }
  };
}

function applyTags(template, resolve) {
  return template.replace(TAG_RE, (match, ns, field, count) => {
    const out = resolve(ns.toLowerCase(), field.toLowerCase(), count);
    return out == null ? match : out;
  });
}

async function render(template, ctx, opts = {}) {
  if (!template) return null;
  const escape = !!template.is_html;
  const repliesCount = Math.max(
    template.default_replies_count || 3,
    countMaxRepliesNeeded(template.subject_template, template.body_template)
  );
  const replies = ctx.ticket?.id
    ? await fetchVendorVisibleReplies(ctx.ticket.id, repliesCount)
    : [];
  const resolve = makeResolver(ctx, replies, escape);
  return {
    subject: applyTags(template.subject_template, resolve),
    body:    applyTags(template.body_template, resolve),
    is_html: escape,
  };
}

function countMaxRepliesNeeded(...sources) {
  let max = 0;
  for (const src of sources) {
    if (!src) continue;
    let m;
    const re = new RegExp(TAG_RE.source, 'gi');
    while ((m = re.exec(src))) {
      if (m[1].toLowerCase() === 'ticket' && m[2].toLowerCase() === 'replies' && m[3]) {
        const n = parseInt(m[3], 10);
        if (n > max) max = Math.min(n, REPLIES_HARD_CAP);
      } else if (m[1].toLowerCase() === 'ticket' && m[2].toLowerCase() === 'reply') {
        if (max < 1) max = 1;
      }
    }
  }
  return max;
}

// Synthesise a sample context for the preview endpoint so admins can
// edit a template without needing a real ticket.
function sampleContext() {
  return {
    site: { name: 'Resolvd', url: 'https://resolvd.example' },
    actor: { display_name: 'Alex Admin', email: 'alex@example.com' },
    ticket: {
      id: 1234,
      internal_ref: 'PROJ-1234',
      title: 'Sample ticket title',
      description: 'Detailed description of the issue, sample text used by the preview only.',
      internal_status: 'In Progress',
      effective_priority: 2,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      url: 'https://resolvd.example/tickets/1234',
      external_ticket_ref: 'VND-5678',
    },
    company: { name: 'Vendor Co', domain: 'vendorco.com' },
    contact: { name: 'Jamie Vendor', email: 'jamie@vendorco.com', role_title: 'Account Manager' },
  };
}

module.exports = { render, loadTemplate, sampleContext, REPLIES_HARD_CAP };

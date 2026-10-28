// Inbound review hints: "this likely unblocks ticket X".
//
// When an admin opens an unmatched inbound message, look for open tickets
// parked in an awaiting_input status that the message plausibly answers.
// Matching a message onto one of them already auto-resumes it (see
// applyReplyToWaitingTicket); the hint just points the reviewer at it.
//
// Signals, strongest first:
//   ticket_ref   — the message's candidate [PREFIX-N] ref is that ticket
//   external_ref — the ticket's vendor ref appears in the subject / body
//   contact      — the sender is a contact attached to the ticket
//
// matchUnblockCandidates is pure; findUnblockCandidates loads its inputs.

const { pool } = require('../db/pool');
const { decryptRows } = require('./fields');

const REASON_RANK = { ticket_ref: 0, external_ref: 1, contact: 2 };
const MAX_CANDIDATES = 5;
const MIN_EXTERNAL_REF_LEN = 3;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// external_ticket_ref may hold several refs separated by , or ; (same
// split as ExternalRefList on the ticket page). Not on whitespace: a ref
// like "Case 12345" must match whole, or "Case" would hit every email.
function splitExternalRefs(value) {
  return String(value || '')
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_EXTERNAL_REF_LEN);
}

function containsRef(haystack, ref) {
  return new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(ref)}($|[^A-Za-z0-9])`, 'i').test(haystack);
}

function matchUnblockCandidates({ message, contactId, tickets }) {
  const haystack = `${message?.subject || ''}\n${message?.body || ''}`;
  const candidateRef = String(message?.candidate_ticket_ref || '').trim().toLowerCase();
  const out = [];
  for (const t of tickets || []) {
    let reason = null;
    let matchedRef = null;
    if (candidateRef && String(t.internal_ref || '').toLowerCase() === candidateRef) {
      reason = 'ticket_ref';
    } else {
      matchedRef = splitExternalRefs(t.external_ticket_ref).find((r) => containsRef(haystack, r)) || null;
      if (matchedRef) reason = 'external_ref';
      else if (contactId && (t.contact_ids || []).includes(Number(contactId))) reason = 'contact';
    }
    if (!reason) continue;
    out.push({
      id: t.id,
      internal_ref: t.internal_ref,
      title: t.title,
      internal_status: t.internal_status,
      reason,
      matched_ref: matchedRef,
    });
  }
  // Stable sort keeps the caller's (most recently updated first) order
  // within a reason.
  return out
    .sort((a, b) => REASON_RANK[a.reason] - REASON_RANK[b.reason])
    .slice(0, MAX_CANDIDATES);
}

async function findUnblockCandidates({ message, contactId }) {
  const r = await pool.query(`
    SELECT t.id, t.internal_ref, t.title, t.title_enc, t.internal_status,
           t.external_ticket_ref,
           ARRAY(SELECT tc.contact_id FROM ticket_contacts tc WHERE tc.ticket_id = t.id) AS contact_ids
      FROM tickets t
      JOIN statuses s ON s.kind = 'internal' AND s.name = t.internal_status
     WHERE s.semantic_tag = 'awaiting_input'
     ORDER BY t.updated_at DESC NULLS LAST
     LIMIT 500
  `);
  const matches = matchUnblockCandidates({ message, contactId, tickets: r.rows });
  if (!matches.length) return [];
  // Decrypt titles only for the handful we return.
  const byId = new Map(r.rows.map((row) => [row.id, row]));
  const rows = matches.map((m) => byId.get(m.id));
  await decryptRows('tickets', rows);
  return matches.map((m) => ({ ...m, title: byId.get(m.id).title }));
}

module.exports = { matchUnblockCandidates, findUnblockCandidates, splitExternalRefs };

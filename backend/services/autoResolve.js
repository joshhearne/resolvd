// Inbound auto-reopen for resolved-pending-close tickets.
//
// When a reply arrives on a ticket sitting in a resolved_pending_close
// state, we detect "thanks"-style closeouts vs real follow-ups. Real
// follow-ups bump the ticket back to a reopened state; gratitude
// messages leave the auto-close timer running.

const { pool } = require('../db/pool');
const { sendVendorEmail } = require('./vendorOutbound');

let _cache = null;
let _cachedAt = 0;
const TTL_MS = 60 * 1000;

// Single cached row so callers don't re-query for every inbound. Refreshed
// when any setter runs or TTL expires.
async function loadSettings() {
  if (_cache && Date.now() - _cachedAt < TTL_MS) return _cache;
  const r = await pool.query(`
    SELECT gratitude_phrases, reply_stale_days, suppress_ooo_replies
      FROM auto_resolve_settings WHERE id = 1
  `);
  const row = r.rows[0] || {};
  _cache = {
    phrases: (row.gratitude_phrases || []).map(s => String(s).trim().toLowerCase()).filter(Boolean),
    replyStaleDays: Number.isFinite(row.reply_stale_days) ? row.reply_stale_days : 30,
    suppressOoo: row.suppress_ooo_replies !== false,
  };
  _cachedAt = Date.now();
  return _cache;
}

async function getGratitudePhrases() {
  return (await loadSettings()).phrases;
}

async function getReplyRoutingSettings() {
  const s = await loadSettings();
  return { stale_days: s.replyStaleDays, suppress_ooo: s.suppressOoo };
}

function invalidatePhraseCache() {
  _cache = null;
  _cachedAt = 0;
}

async function setGratitudePhrases(phrases) {
  const cleaned = (Array.isArray(phrases) ? phrases : [])
    .map(s => String(s || '').trim())
    .filter(Boolean);
  await pool.query(
    `UPDATE auto_resolve_settings SET gratitude_phrases = $1::text[], updated_at = NOW() WHERE id = 1`,
    [cleaned]
  );
  invalidatePhraseCache();
  return cleaned;
}

async function setReplyRoutingSettings({ stale_days, suppress_ooo } = {}) {
  const sets = [];
  const values = [];
  if (stale_days != null) {
    const n = Math.max(1, Math.min(3650, Math.floor(Number(stale_days))));
    if (!Number.isFinite(n)) throw new Error('stale_days must be a positive integer');
    sets.push(`reply_stale_days = $${values.length + 1}`);
    values.push(n);
  }
  if (suppress_ooo != null) {
    sets.push(`suppress_ooo_replies = $${values.length + 1}`);
    values.push(!!suppress_ooo);
  }
  if (sets.length === 0) return await getReplyRoutingSettings();
  sets.push(`updated_at = NOW()`);
  await pool.query(
    `UPDATE auto_resolve_settings SET ${sets.join(', ')} WHERE id = 1`,
    values
  );
  invalidatePhraseCache();
  return await getReplyRoutingSettings();
}

// Detect an out-of-office auto-reply. Subject signal: any "Automatic
// reply" / "Out of office" / "OOF" / "Auto-Reply" form (Outlook, Gmail
// vacation, third-party schedulers). Body signal: at least one phrase
// strongly indicating absence. Both must match to qualify so a real
// reply that happens to contain the words "out of office" in passing
// doesn't get silenced. Used as a fallback when the standard RFC 3834
// `Auto-Submitted` header path didn't fire (some forwarders strip it).
const OOO_SUBJECT_RE = /\b(?:automatic\s+reply|automatic[-_ ]?response|auto[-_ ]?reply|out\s+of\s+(?:the\s+)?office|out\s+of\s+office\s+autoreply|OOF|OOO\s+(?:reply|notice)?|vacation\s+(?:reply|response|notice))\b/i;
const OOO_BODY_RES = [
  /\bout\s+of\s+(?:the\s+)?office\b/i,
  /\baway\s+from\s+(?:the\s+|my\s+)?(?:office|desk|email)\b/i,
  /\bon\s+(?:vacation|holiday|annual\s+leave|leave|PTO|maternity|paternity|parental\s+leave|sabbatical)\b/i,
  /\bcurrently\s+(?:out|unavailable|away)\b/i,
  /\bI\s+am\s+(?:currently\s+)?(?:out|away|unavailable|on\s+leave)\b/i,
  /\bI['’]?ll\s+be\s+(?:out|away|back)\b/i,
  /\bwill\s+be\s+(?:out\s+of\s+(?:the\s+)?office|away|back)\b/i,
  /\b(?:limited|no)\s+access\s+to\s+(?:my\s+)?(?:e-?mail|messages)\b/i,
  /\breturn(?:ing)?\s+(?:to\s+(?:the\s+)?office\s+)?on\b/i,
  /\bback\s+(?:in\s+(?:the\s+)?office\s+)?on\b/i,
];

function detectOutOfOffice({ subject, body } = {}) {
  if (!subject && !body) return false;
  const subj = String(subject || '');
  if (!OOO_SUBJECT_RE.test(subj)) return false;
  const text = String(body || '');
  if (!text.trim()) return true; // subject-only bouncers (Exchange "OOF: ...")
  return OOO_BODY_RES.some(re => re.test(text));
}

// Strip whitespace + common punctuation; lower-case. Compares the trimmed
// reply body to the phrase list. Match if the body equals a phrase, OR
// the body starts with a phrase followed by punctuation/whitespace and
// nothing meaningful follows (≤ 30 chars trailing). This keeps "thanks!"
// and "thanks — appreciate the quick turnaround" matching while letting
// "thanks but I still see the issue" fall through.
function isGratitudeOnly(body, phrases) {
  if (!body) return false;
  const flat = String(body)
    .replace(/[‘’“”]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!flat) return false;
  for (const phrase of phrases) {
    if (!phrase) continue;
    if (flat === phrase) return true;
    // Allow trailing punctuation/exclamation only.
    const re = new RegExp('^' + phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s.!,;:\\-—)]*$');
    if (re.test(flat)) return true;
  }
  // Body is short (<= 60 chars) and consists of phrase + filler like "!"
  // or "guys" — check if any phrase appears as the dominant content.
  if (flat.length <= 60) {
    for (const phrase of phrases) {
      if (!phrase) continue;
      if (flat.startsWith(phrase) && flat.length - phrase.length <= 25) {
        // The remainder must not contain a verb-y question or negation.
        const rest = flat.slice(phrase.length);
        if (!/\b(but|however|still|not|isn|wasn|doesn|didn|can't|cant|why|when|how|where|please|fix|broken|issue|problem)\b/.test(rest)) {
          return true;
        }
      }
    }
  }
  return false;
}

async function findReopenStatusName() {
  const r = await pool.query(
    `SELECT name FROM statuses
      WHERE kind = 'internal' AND semantic_tag = 'reopened'
      ORDER BY sort_order ASC LIMIT 1`
  );
  return r.rows[0]?.name || 'Reopened';
}

// Returns { reopened: bool, gratitude: bool } when ticket was in a
// resolved_pending_close state. Returns null when the ticket isn't
// in that state (caller should not act).
async function applyReplyToResolvedTicket({ ticketId, replyBody, actorUserId }) {
  const t = await pool.query(`
    SELECT t.id, t.internal_status, t.internal_ref, s.semantic_tag
      FROM tickets t
 LEFT JOIN statuses s ON s.kind = 'internal' AND s.name = t.internal_status
     WHERE t.id = $1
  `, [ticketId]);
  const row = t.rows[0];
  if (!row) return null;
  if (row.semantic_tag !== 'resolved_pending_close') return null;

  const phrases = await getGratitudePhrases();
  const gratitude = isGratitudeOnly(replyBody, phrases);
  if (gratitude) {
    return { reopened: false, gratitude: true, fromStatus: row.internal_status };
  }

  const target = await findReopenStatusName();
  await pool.query(
    `UPDATE tickets SET internal_status = $1, resolved_at = NULL, updated_at = NOW() WHERE id = $2`,
    [target, ticketId]
  );
  await pool.query(
    `INSERT INTO audit_log (ticket_id, user_id, action, old_value, new_value, note)
     VALUES ($1, $2, 'status_change_auto', $3, $4, $5)`,
    [ticketId, actorUserId || null, row.internal_status, target, 'Auto-reopened: non-gratitude reply received during resolved grace window']
  );
  sendVendorEmail({ eventType: 'ticket_reopened', ticketId, actorId: actorUserId }).catch(() => {});
  return { reopened: true, gratitude: false, fromStatus: row.internal_status, toStatus: target };
}

async function findInProgressStatusName() {
  const r = await pool.query(
    `SELECT name FROM statuses
      WHERE kind = 'internal' AND semantic_tag = 'in_progress'
      ORDER BY sort_order ASC LIMIT 1`
  );
  return r.rows[0]?.name || 'In Progress';
}

// Vendor reply lands on an awaiting_input ticket → unblock it.
// Mirrors applyReplyToResolvedTicket but without the gratitude filter:
// any inbound reply on awaiting_input is signal that whatever we were
// waiting for has arrived. Returns { resumed, fromStatus, toStatus } on
// transition or null when ticket isn't in that state.
async function applyReplyToWaitingTicket({ ticketId, actorUserId }) {
  const t = await pool.query(`
    SELECT t.id, t.internal_status, t.internal_ref, s.semantic_tag
      FROM tickets t
 LEFT JOIN statuses s ON s.kind = 'internal' AND s.name = t.internal_status
     WHERE t.id = $1
  `, [ticketId]);
  const row = t.rows[0];
  if (!row) return null;
  if (row.semantic_tag !== 'awaiting_input') return null;

  const target = await findInProgressStatusName();
  await pool.query(
    `UPDATE tickets SET internal_status = $1, updated_at = NOW() WHERE id = $2`,
    [target, ticketId]
  );
  await pool.query(
    `INSERT INTO audit_log (ticket_id, user_id, action, old_value, new_value, note)
     VALUES ($1, $2, 'status_change_auto', $3, $4, $5)`,
    [ticketId, actorUserId || null, row.internal_status, target, 'Auto-resumed: inbound reply received while awaiting input']
  );
  return { resumed: true, fromStatus: row.internal_status, toStatus: target };
}

// Called when a web UI comment is posted on any terminal ticket.
// Applies the same gratitude filter — a substantive comment reopens the
// ticket; a thank-you leaves it closed. Returns null if ticket isn't terminal.
async function applyCommentToTerminalTicket({ ticketId, commentBody, actorUserId }) {
  const t = await pool.query(`
    SELECT t.id, t.internal_status, s.semantic_tag, s.is_terminal
      FROM tickets t
 LEFT JOIN statuses s ON s.kind = 'internal' AND s.name = t.internal_status
     WHERE t.id = $1
  `, [ticketId]);
  const row = t.rows[0];
  if (!row || !row.is_terminal) return null;

  const phrases = await getGratitudePhrases();
  const gratitude = isGratitudeOnly(commentBody, phrases);
  if (gratitude) {
    return { reopened: false, gratitude: true, fromStatus: row.internal_status };
  }

  const target = await findReopenStatusName();
  await pool.query(
    `UPDATE tickets SET internal_status = $1, resolved_at = NULL, updated_at = NOW() WHERE id = $2`,
    [target, ticketId]
  );
  await pool.query(
    `INSERT INTO audit_log (ticket_id, user_id, action, old_value, new_value, note)
     VALUES ($1, $2, 'status_change_auto', $3, $4, $5)`,
    [ticketId, actorUserId || null, row.internal_status, target, 'Auto-reopened: substantive comment posted on resolved ticket']
  );
  sendVendorEmail({ eventType: 'ticket_reopened', ticketId, actorId: actorUserId }).catch(() => {});
  return { reopened: true, gratitude: false, fromStatus: row.internal_status, toStatus: target };
}

module.exports = {
  getGratitudePhrases,
  setGratitudePhrases,
  getReplyRoutingSettings,
  setReplyRoutingSettings,
  invalidatePhraseCache,
  isGratitudeOnly,
  detectOutOfOffice,
  applyReplyToResolvedTicket,
  applyReplyToWaitingTicket,
  applyCommentToTerminalTicket,
};

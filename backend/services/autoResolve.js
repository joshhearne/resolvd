// Inbound auto-reopen for resolved-pending-close tickets.
//
// When a reply arrives on a ticket sitting in a resolved_pending_close
// state, we detect "thanks"-style closeouts vs real follow-ups. Real
// follow-ups bump the ticket back to a reopened state; gratitude
// messages leave the auto-close timer running.

const { pool } = require('../db/pool');

let _cache = null;
let _cachedAt = 0;
const TTL_MS = 60 * 1000;

async function getGratitudePhrases() {
  if (_cache && Date.now() - _cachedAt < TTL_MS) return _cache;
  const r = await pool.query('SELECT gratitude_phrases FROM auto_resolve_settings WHERE id = 1');
  _cache = (r.rows[0]?.gratitude_phrases || []).map(s => String(s).trim().toLowerCase()).filter(Boolean);
  _cachedAt = Date.now();
  return _cache;
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
  return { reopened: true, gratitude: false, fromStatus: row.internal_status, toStatus: target };
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
  return { reopened: true, gratitude: false, fromStatus: row.internal_status, toStatus: target };
}

module.exports = {
  getGratitudePhrases,
  setGratitudePhrases,
  invalidatePhraseCache,
  isGratitudeOnly,
  applyReplyToResolvedTicket,
  applyCommentToTerminalTicket,
};

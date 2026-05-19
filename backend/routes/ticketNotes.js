// Internal handler-only notes on a ticket. Distinct from comments:
// never reach Submitters or Vendors and never get sent outbound. Access
// is gated to "handlers" — global Admin/Manager/Tech, OR a project
// member whose role_override resolves to Admin/Manager/Tech, OR a
// project member with is_agent=TRUE. A Submitter who somehow guessed
// the URL still gets 403 unless they have an agent flag on the ticket's
// project.
//
// Body is encrypted via the standard fields helper (FIELD_MAP entry
// ticket_notes.body -> body_enc).

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { buildWritePatch, decryptRows } = require('../services/fields');
const { resolveMentions } = require('../services/mentions');
const { fanoutMention } = require('../services/notificationFanout');

const router = express.Router();
const GLOBAL_HANDLER_ROLES = new Set(['Admin', 'Manager', 'Tech']);

// Allow if global role is a handler, OR the user is a member of this
// ticket's project with role_override in handler set or is_agent=TRUE.
// Resolves the ticket -> project once, attaches `req.ticket` so the
// handler can reuse it without a second query.
async function requireNoteAccess(req, res, next) {
  try {
    const user = req.session?.user;
    if (!user) return res.status(401).json({ error: 'Unauthenticated' });
    const ticketId = Number(req.params.id);
    if (!Number.isInteger(ticketId) || ticketId <= 0) {
      return res.status(400).json({ error: 'Invalid ticket id' });
    }
    const t = await pool.query(
      'SELECT id, internal_ref, title, title_enc, project_id FROM tickets WHERE id = $1',
      [ticketId]
    );
    if (!t.rows[0]) return res.status(404).json({ error: 'Ticket not found' });
    req.ticket = t.rows[0];

    if (GLOBAL_HANDLER_ROLES.has(user.role)) return next();

    const m = await pool.query(
      'SELECT role_override, is_agent FROM project_members WHERE project_id = $1 AND user_id = $2',
      [t.rows[0].project_id, user.id]
    );
    const row = m.rows[0];
    if (row && (row.is_agent === true || GLOBAL_HANDLER_ROLES.has(row.role_override))) {
      return next();
    }
    return res.status(403).json({ error: 'Forbidden' });
  } catch (err) {
    console.error('note access check:', err);
    return res.status(500).json({ error: 'Database error' });
  }
}

// GET /api/tickets/:id/notes
router.get('/:id/notes', requireAuth, requireNoteAccess, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT n.id, n.ticket_id, n.user_id, n.body, n.body_enc, n.created_at, n.edited_at,
              u.display_name AS user_name, u.email AS user_email
         FROM ticket_notes n
    LEFT JOIN users u ON u.id = n.user_id
        WHERE n.ticket_id = $1
        ORDER BY n.created_at ASC`,
      [Number(req.params.id)]
    );
    await decryptRows('ticket_notes', r.rows);
    res.json(r.rows);
  } catch (err) {
    console.error('notes list:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/tickets/:id/notes  { body }
router.post('/:id/notes', requireAuth, requireNoteAccess, async (req, res) => {
  try {
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Note body required' });
    const ticketId = req.ticket.id;
    const t = { rows: [req.ticket] };

    const patch = await buildWritePatch(pool, 'ticket_notes', { body });
    const cols = ['ticket_id', 'user_id', ...patch.cols];
    const values = [ticketId, req.session.user.id, ...patch.values];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const ins = await pool.query(
      `INSERT INTO ticket_notes (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id, created_at`,
      values
    );

    // Mention fan-out — agents only. Decrypt the ticket title here so
    // the notification email shows a real subject. Failure to fan out
    // should never block note creation, so swallow errors.
    try {
      const mentioned = await resolveMentions(body, {
        projectId: t.rows[0].project_id,
        agentsOnly: true,
        excludeUserId: req.session.user.id,
      });
      if (mentioned.length) {
        const { decryptRow } = require('../services/fields');
        await decryptRow('tickets', t.rows[0]);
        await fanoutMention(pool, {
          ticket: t.rows[0],
          comment: body,
          commentId: ins.rows[0].id,
          kind: 'note',
          mentionedUsers: mentioned,
          actorId: req.session.user.id,
          actorName: req.session.user.displayName || req.session.user.email,
        });
      }
    } catch (err) {
      console.error('note mention fanout:', err.message);
    }

    res.status(201).json({
      id: ins.rows[0].id,
      ticket_id: ticketId,
      user_id: req.session.user.id,
      user_name: req.session.user.displayName || req.session.user.email,
      body,
      created_at: ins.rows[0].created_at,
    });
  } catch (err) {
    console.error('notes create:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/tickets/:id/notes/:noteId — author or Admin/Manager can
// edit. Tech with note access can edit own notes. Notes don't fan out
// outbound so there is no distribution gate — any edit shows "(edited)".
router.patch('/:id/notes/:noteId', requireAuth, requireNoteAccess, async (req, res) => {
  try {
    const newBody = String(req.body?.body || '').trim();
    if (!newBody) return res.status(400).json({ error: 'Note body required' });
    const noteId = Number(req.params.noteId);
    const ticketId = req.ticket.id;
    const existing = await pool.query(
      'SELECT id, user_id, body, body_enc FROM ticket_notes WHERE id = $1 AND ticket_id = $2',
      [noteId, ticketId]
    );
    if (!existing.rows[0]) return res.status(404).json({ error: 'Note not found' });
    const n = existing.rows[0];

    const user = req.session.user;
    const isAuthor = n.user_id === user.id;
    const isPriv = ['Admin', 'Manager'].includes(user.role);
    if (!isAuthor && !isPriv) {
      return res.status(403).json({ error: 'Only the author, Admin, or Manager can edit this note' });
    }

    const { decryptRow } = require('../services/fields');
    await decryptRow('ticket_notes', n);
    if ((n.body || '') === newBody) {
      return res.json({ id: n.id, ticket_id: ticketId, edited_at: null, body: newBody });
    }

    const patch = await buildWritePatch(pool, 'ticket_notes', { body: newBody });
    const sets = patch.cols.map((col, i) => `${col} = $${i + 1}`);
    sets.push('edited_at = NOW()');
    const values = [...patch.values, noteId];
    const result = await pool.query(
      `UPDATE ticket_notes SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING id, edited_at`,
      values
    );
    await pool.query(
      `INSERT INTO audit_log (ticket_id, user_id, action, old_value, new_value, note)
       VALUES ($1, $2, 'note_edited', $3, $4, $5)`,
      [ticketId, user.id, String(noteId), String(noteId), isAuthor ? null : 'edited by handler']
    );
    res.json({ id: result.rows[0].id, ticket_id: ticketId, edited_at: result.rows[0].edited_at, body: newBody });
  } catch (err) {
    console.error('note edit failed:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/tickets/:id/notes/:noteId — author or Admin
router.delete('/:id/notes/:noteId', requireAuth, requireNoteAccess, async (req, res) => {
  try {
    const noteId = Number(req.params.noteId);
    const ticketId = Number(req.params.id);
    const row = await pool.query(
      'SELECT user_id FROM ticket_notes WHERE id = $1 AND ticket_id = $2',
      [noteId, ticketId]
    );
    if (!row.rows[0]) return res.status(404).json({ error: 'Note not found' });
    const isAuthor = row.rows[0].user_id === req.session.user.id;
    const isAdmin = req.session.user.role === 'Admin';
    if (!isAuthor && !isAdmin) {
      return res.status(403).json({ error: 'Only the author or an Admin can delete this note' });
    }
    await pool.query('DELETE FROM ticket_notes WHERE id = $1', [noteId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('notes delete:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

// Internal handler-only notes on a ticket. Distinct from comments:
// never reach Submitters or Vendors and never get sent outbound. The
// whole module is role-gated to Admin/Manager/Tech — even GET. A
// Submitter who somehow guessed the URL would get 403.
//
// Body is encrypted via the standard fields helper (FIELD_MAP entry
// ticket_notes.body -> body_enc).

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { buildWritePatch, decryptRows } = require('../services/fields');
const { resolveMentions } = require('../services/mentions');
const { fanoutMention } = require('../services/notificationFanout');

const router = express.Router();
const NOTE_ROLES = ['Admin', 'Manager', 'Tech'];

// GET /api/tickets/:id/notes
router.get('/:id/notes', requireAuth, requireRole(...NOTE_ROLES), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT n.id, n.ticket_id, n.user_id, n.body, n.body_enc, n.created_at,
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
router.post('/:id/notes', requireAuth, requireRole(...NOTE_ROLES), async (req, res) => {
  try {
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Note body required' });
    const ticketId = Number(req.params.id);
    const t = await pool.query(
      'SELECT id, internal_ref, title, title_enc, project_id FROM tickets WHERE id = $1',
      [ticketId]
    );
    if (!t.rows[0]) return res.status(404).json({ error: 'Ticket not found' });

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

// DELETE /api/tickets/:id/notes/:noteId — author or Admin
router.delete('/:id/notes/:noteId', requireAuth, requireRole(...NOTE_ROLES), async (req, res) => {
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

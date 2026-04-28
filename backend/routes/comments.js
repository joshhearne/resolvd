const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { notifyNewComment } = require('../services/email');
const { buildWritePatch, decryptRow, decryptRows } = require('../services/fields');
const { sendVendorEmail } = require('../services/vendorOutbound');

const router = express.Router();

// GET /api/tickets/:id/comments
router.get('/:id/comments', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*, u.display_name as user_name, u.email as user_email
      FROM comments c
      LEFT JOIN users u ON c.user_id = u.id
      WHERE c.ticket_id = $1
      ORDER BY c.created_at ASC
    `, [req.params.id]);
    await decryptRows('comments', result.rows);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/tickets/:id/comments
router.post('/:id/comments', requireAuth, requireRole('Admin', 'Manager', 'Submitter'), async (req, res) => {
  try {
    const { body, is_external_visible } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: 'Comment body required' });

    const ticket = await pool.query(
      'SELECT id, internal_ref, title, title_enc, submitted_by FROM tickets WHERE id = $1',
      [req.params.id]
    );
    if (!ticket.rows[0]) return res.status(404).json({ error: 'Ticket not found' });
    await decryptRow('tickets', ticket.rows[0]);

    // Vendor-visible comments require a privileged role — submitters can
    // log internal comments but not flag content as outbound to vendors.
    const wantsExternal = !!is_external_visible;
    if (wantsExternal && !['Admin', 'Manager'].includes(req.session.user.role)) {
      return res.status(403).json({ error: 'Only Admin/Manager can mark a comment as vendor-visible' });
    }

    const trimmedBody = body.trim();
    const patch = await buildWritePatch(pool, 'comments', { body: trimmedBody });
    const cols = ['ticket_id', 'user_id', 'is_external_visible', ...patch.cols];
    const values = [Number(req.params.id), req.session.user.id, wantsExternal, ...patch.values];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const insertResult = await pool.query(
      `INSERT INTO comments (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`,
      values
    );

    // Update ticket updated_at
    await pool.query('UPDATE tickets SET updated_at = NOW() WHERE id = $1', [req.params.id]);

    // Auto-follow when the commenter has the preference enabled (default
    // ON). System comments don't trigger this.
    const prefRow = await pool.query(
      'SELECT preferences FROM users WHERE id = $1',
      [req.session.user.id]
    );
    const autoFollow = prefRow.rows[0]?.preferences?.auto_follow_on_comment;
    if (autoFollow !== false) {
      await pool.query(
        `INSERT INTO ticket_followers (ticket_id, user_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [req.params.id, req.session.user.id]
      );
    }

    const comment = await pool.query(`
      SELECT c.*, u.display_name as user_name, u.email as user_email
      FROM comments c
      LEFT JOIN users u ON c.user_id = u.id
      WHERE c.id = $1
    `, [insertResult.rows[0].id]);

    const result = comment.rows[0];
    await decryptRow('comments', result);
    res.status(201).json(result);

    // Notify followers async (skip system comments)
    if (!result.is_system) {
      notifyNewComment(pool, {
        ticket: ticket.rows[0],
        comment: trimmedBody,
        actorId: req.session.user.id,
        actorName: req.session.user.displayName,
      }).catch(() => {});
    }

    // Vendor-bound outbound fires only when the comment is flagged for
    // external visibility AND there are contacts attached to the ticket.
    if (wantsExternal && !result.is_system) {
      sendVendorEmail({
        eventType: 'new_comment',
        ticketId: ticket.rows[0].id,
        actorId: req.session.user.id,
      }).catch(err => console.error('vendor outbound failed:', err.message));
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/comments/:id/mute   — Admin/Manager flips is_muted=TRUE
// POST /api/comments/:id/unmute — Admin/Manager flips is_muted=FALSE
async function setMuted(req, res, value) {
  try {
    const r = await pool.query(
      `UPDATE comments SET is_muted = $1
        WHERE id = $2
        RETURNING id, ticket_id, is_muted`,
      [value, req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Comment not found' });
    // Audit on ticket so the timeline shows who un-muted what.
    await pool.query(
      `INSERT INTO audit_log (ticket_id, user_id, action, new_value, note)
       VALUES ($1, $2, $3, $4, $5)`,
      [r.rows[0].ticket_id, req.session.user.id,
       value ? 'comment_muted' : 'comment_unmuted',
       String(r.rows[0].id), null]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
}

router.post('/comments/:id/mute',   requireAuth, requireRole('Admin', 'Manager'),
  (req, res) => setMuted(req, res, true));
router.post('/comments/:id/unmute', requireAuth, requireRole('Admin', 'Manager'),
  (req, res) => setMuted(req, res, false));

// DELETE /api/comments/:id — Admin only
router.delete('/comments/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM comments WHERE id = $1 RETURNING id, ticket_id`,
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Comment not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

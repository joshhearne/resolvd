const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { notifyNewComment } = require('../services/email');
const { buildWritePatch, decryptRow, decryptRows } = require('../services/fields');

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
    const { body } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: 'Comment body required' });

    const ticket = await pool.query(
      'SELECT id, mot_ref, title, title_enc, submitted_by FROM tickets WHERE id = $1',
      [req.params.id]
    );
    if (!ticket.rows[0]) return res.status(404).json({ error: 'Ticket not found' });
    await decryptRow('tickets', ticket.rows[0]);

    const trimmedBody = body.trim();
    const patch = await buildWritePatch(pool, 'comments', { body: trimmedBody });
    const cols = ['ticket_id', 'user_id', ...patch.cols];
    const values = [Number(req.params.id), req.session.user.id, ...patch.values];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const insertResult = await pool.query(
      `INSERT INTO comments (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`,
      values
    );

    // Update ticket updated_at
    await pool.query('UPDATE tickets SET updated_at = NOW() WHERE id = $1', [req.params.id]);

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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

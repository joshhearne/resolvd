const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { notifyNewComment } = require('../services/email');

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

    const ticket = await pool.query('SELECT id, mot_ref, title, submitted_by FROM tickets WHERE id = $1', [req.params.id]);
    if (!ticket.rows[0]) return res.status(404).json({ error: 'Ticket not found' });

    const insertResult = await pool.query(`
      INSERT INTO comments (ticket_id, user_id, body) VALUES ($1, $2, $3) RETURNING id
    `, [Number(req.params.id), req.session.user.id, body.trim()]);

    // Update ticket updated_at
    await pool.query('UPDATE tickets SET updated_at = NOW() WHERE id = $1', [req.params.id]);

    const comment = await pool.query(`
      SELECT c.*, u.display_name as user_name, u.email as user_email
      FROM comments c
      LEFT JOIN users u ON c.user_id = u.id
      WHERE c.id = $1
    `, [insertResult.rows[0].id]);

    const result = comment.rows[0];
    res.status(201).json(result);

    // Notify followers async (skip system comments)
    if (!result.is_system) {
      notifyNewComment(pool, {
        ticket: ticket.rows[0],
        comment: body.trim(),
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

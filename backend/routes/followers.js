const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

// GET /api/tickets/:ticketId/followers
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.display_name, u.email
      FROM ticket_followers tf
      JOIN users u ON tf.user_id = u.id
      WHERE tf.ticket_id = $1
      ORDER BY u.display_name ASC
    `, [req.params.ticketId]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/tickets/:ticketId/follow
router.post('/follow', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'INSERT INTO ticket_followers (ticket_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.params.ticketId, req.session.user.id]
    );
    res.json({ following: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/tickets/:ticketId/follow
router.delete('/follow', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM ticket_followers WHERE ticket_id = $1 AND user_id = $2',
      [req.params.ticketId, req.session.user.id]
    );
    res.json({ following: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

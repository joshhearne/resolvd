const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

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

// POST /api/tickets/:ticketId/followers — Admin/Manager add another user
// Body: { user_id }
router.post('/', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const userId = Number(req.body?.user_id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'user_id required' });
    }
    const u = await pool.query(`SELECT id FROM users WHERE id = $1 AND status = 'active'`, [userId]);
    if (!u.rows[0]) return res.status(400).json({ error: 'User not found or inactive' });
    await pool.query(
      'INSERT INTO ticket_followers (ticket_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.params.ticketId, userId]
    );
    await pool.query(
      `INSERT INTO audit_log (ticket_id, user_id, action, new_value, note)
       VALUES ($1, $2, 'follower_added', $3, $4)`,
      [req.params.ticketId, req.session.user.id, String(userId), `Follower added by ${req.session.user.displayName || req.session.user.email}`]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('add follower error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/tickets/:ticketId/followers/:userId — Admin/Manager remove
router.delete('/:userId', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    await pool.query(
      'DELETE FROM ticket_followers WHERE ticket_id = $1 AND user_id = $2',
      [req.params.ticketId, userId]
    );
    await pool.query(
      `INSERT INTO audit_log (ticket_id, user_id, action, old_value, note)
       VALUES ($1, $2, 'follower_removed', $3, $4)`,
      [req.params.ticketId, req.session.user.id, String(userId), 'Follower removed']
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('remove follower error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

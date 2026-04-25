const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/dashboard/stats
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const statusCounts = await pool.query(`
      SELECT internal_status, COUNT(*) as count FROM tickets GROUP BY internal_status
    `);

    const priorityCounts = await pool.query(`
      SELECT effective_priority, COUNT(*) as count FROM tickets
      WHERE internal_status NOT IN ('Closed') GROUP BY effective_priority ORDER BY effective_priority
    `);

    const flaggedCount = await pool.query(`
      SELECT COUNT(*) as count FROM tickets WHERE flagged_for_review = TRUE AND internal_status != 'Closed'
    `);

    const statusMap = {};
    statusCounts.rows.forEach(r => { statusMap[r.internal_status] = parseInt(r.count, 10); });

    res.json({
      total_open: statusMap['Open'] || 0,
      total_in_progress: statusMap['In Progress'] || 0,
      total_awaiting_mot: statusMap['Awaiting MOT Input'] || 0,
      total_pending_review: statusMap['Pending Review'] || 0,
      total_closed: statusMap['Closed'] || 0,
      total_reopened: statusMap['Reopened'] || 0,
      flagged_for_review: parseInt(flaggedCount.rows[0].count, 10),
      priority_distribution: priorityCounts.rows.map(r => ({
        ...r,
        count: parseInt(r.count, 10),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/dashboard/activity
router.get('/activity', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.*, u.display_name as user_name, t.mot_ref, t.title as ticket_title
      FROM audit_log a
      LEFT JOIN users u ON a.user_id = u.id
      LEFT JOIN tickets t ON a.ticket_id = t.id
      ORDER BY a.created_at DESC
      LIMIT 10
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

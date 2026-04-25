const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const ALL_STATUSES = ['Open', 'In Progress', 'Awaiting', 'Pending Review', 'Reopened', 'Closed'];

// GET /api/export/tickets?statuses=Open,Closed,...
router.get('/tickets', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const requested = (req.query.statuses || '').split(',').map(s => s.trim()).filter(Boolean);
    const statuses = requested.filter(s => ALL_STATUSES.includes(s));
    if (!statuses.length) return res.status(400).json({ error: 'No valid statuses specified' });

    const result = await pool.query(`
      SELECT
        t.id, t.mot_ref, t.title, t.description,
        t.internal_status, t.coastal_status, t.coastal_ticket_ref,
        t.effective_priority, t.priority_override, t.computed_priority,
        t.impact, t.urgency,
        t.blocker_type, t.mot_blocker_note, t.blocked_by_ticket,
        t.flagged_for_review, t.review_note,
        t.created_at, t.updated_at,
        u_sub.display_name AS submitter_name,
        u_asgn.display_name AS assignee_name,
        proj.name AS project_name,
        proj.prefix AS project_prefix,
        COALESCE(
          json_agg(
            json_build_object(
              'id', a.id,
              'original_name', a.original_name,
              'mimetype', a.mimetype,
              'size', a.size
            ) ORDER BY a.created_at ASC
          ) FILTER (WHERE a.id IS NOT NULL AND a.mimetype LIKE 'image/%'),
          '[]'
        ) AS images
      FROM tickets t
      LEFT JOIN users u_sub ON t.submitted_by = u_sub.id
      LEFT JOIN users u_asgn ON t.assigned_to = u_asgn.id
      LEFT JOIN projects proj ON t.project_id = proj.id
      LEFT JOIN attachments a ON a.ticket_id = t.id
      WHERE t.internal_status = ANY($1::text[])
      GROUP BY
        t.id, u_sub.display_name, u_asgn.display_name,
        proj.name, proj.prefix
    `, [statuses]);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

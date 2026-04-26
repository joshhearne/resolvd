const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { decryptRows } = require('../services/fields');
const { decrypt } = require('../services/crypto');

const router = express.Router();

const ALL_STATUSES = ['Open', 'In Progress', 'Awaiting', 'Pending Review', 'Reopened', 'Closed'];

// GET /api/export/tickets?statuses=...&project_ids=1,2&updated_from=YYYY-MM-DD&updated_to=YYYY-MM-DD
router.get('/tickets', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const requested = (req.query.statuses || '').split(',').map(s => s.trim()).filter(Boolean);
    const statuses = requested.filter(s => ALL_STATUSES.includes(s));
    if (!statuses.length) return res.status(400).json({ error: 'No valid statuses specified' });

    const projectIds = (req.query.project_ids || '').split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n));
    const updatedFrom = req.query.updated_from || null;
    const updatedTo = req.query.updated_to || null;

    const params = [statuses];
    let p = 2;
    const clauses = [];

    if (projectIds.length) { clauses.push(`t.project_id = ANY($${p++}::int[])`); params.push(projectIds); }
    if (updatedFrom) { clauses.push(`t.updated_at >= $${p++}::date`); params.push(updatedFrom); }
    if (updatedTo) { clauses.push(`t.updated_at < ($${p++}::date + interval '1 day')`); params.push(updatedTo); }

    const extraWhere = clauses.length ? `AND ${clauses.join(' AND ')}` : '';

    const result = await pool.query(`
      SELECT
        t.id, t.mot_ref,
        t.title, t.title_enc,
        t.description, t.description_enc,
        t.internal_status, t.coastal_status, t.coastal_ticket_ref,
        t.effective_priority, t.priority_override, t.computed_priority,
        t.impact, t.urgency,
        t.blocker_type,
        t.mot_blocker_note, t.mot_blocker_note_enc,
        t.blocked_by_ticket,
        t.flagged_for_review,
        t.review_note, t.review_note_enc,
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
              'original_name_enc_b64', encode(a.original_name_enc, 'base64'),
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
      ${extraWhere}
      GROUP BY
        t.id, u_sub.display_name, u_asgn.display_name,
        proj.name, proj.prefix
      ORDER BY t.effective_priority ASC, t.mot_ref ASC
    `, params);

    await decryptRows('tickets', result.rows);
    // Image attachments arrive as JSON arrays; decrypt original_name per item.
    for (const row of result.rows) {
      if (Array.isArray(row.images)) {
        for (const img of row.images) {
          if (img.original_name_enc_b64) {
            try {
              img.original_name = await decrypt(
                Buffer.from(img.original_name_enc_b64, 'base64'),
                'attachments.original_name'
              );
            } catch (e) {
              img.original_name = img.original_name || null;
            }
          }
          delete img.original_name_enc_b64;
        }
      }
    }

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { decryptRows } = require('../services/fields');
const { decrypt } = require('../services/crypto');

const router = express.Router();

const ALL_INTERNAL_STATUSES = ['Open', 'In Progress', 'Awaiting', 'Awaiting Input', 'Pending Review', 'Reopened', 'Closed'];

// GET /api/export/options?project_ids=1,2
// Returns distinct external statuses and companies for the given projects.
router.get('/options', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const projectIds = (req.query.project_ids || '').split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n));
    const params = projectIds.length ? [projectIds] : [];
    const extWhere = projectIds.length
      ? `WHERE project_id = ANY($1::int[]) AND coastal_status IS NOT NULL`
      : `WHERE coastal_status IS NOT NULL`;
    const coWhere = projectIds.length
      ? `WHERE co.project_id = ANY($1::int[]) AND co.is_archived = FALSE`
      : `WHERE co.is_archived = FALSE`;

    const [extRows, coRows] = await Promise.all([
      pool.query(`SELECT DISTINCT coastal_status FROM tickets ${extWhere} ORDER BY coastal_status`, params),
      pool.query(`SELECT co.id, co.name, co.name_enc, p.name AS project_name FROM companies co JOIN projects p ON p.id = co.project_id ${coWhere} ORDER BY co.name`, params),
    ]);
    await decryptRows('companies', coRows.rows);
    res.json({ external_statuses: extRows.rows.map(r => r.coastal_status), companies: coRows.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/export/tickets
// Query params:
//   statuses          — comma-sep internal statuses
//   external_statuses — comma-sep coastal_status values
//   status_logic      — AND | OR (default OR)
//   project_ids       — comma-sep project IDs
//   company_ids       — comma-sep company IDs (only tickets with a contact from these companies)
//   updated_from / updated_to — date range
router.get('/tickets', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const internalRequested = (req.query.statuses || '').split(',').map(s => s.trim()).filter(Boolean);
    const externalRequested = (req.query.external_statuses || '').split(',').map(s => s.trim()).filter(Boolean);
    const statusLogic = (req.query.status_logic || 'OR').toUpperCase() === 'AND' ? 'AND' : 'OR';

    const internalStatuses = internalRequested.filter(s => ALL_INTERNAL_STATUSES.includes(s));
    const externalStatuses = externalRequested;

    if (!internalStatuses.length && !externalStatuses.length) {
      return res.status(400).json({ error: 'No valid statuses specified' });
    }

    const params = [];
    let p = 1;

    // Build status WHERE clause
    let statusClause;
    if (internalStatuses.length && externalStatuses.length) {
      params.push(internalStatuses); const ip = p++;
      params.push(externalStatuses); const ep = p++;
      statusClause = `(t.internal_status = ANY($${ip}::text[]) ${statusLogic} t.coastal_status = ANY($${ep}::text[]))`;
    } else if (internalStatuses.length) {
      params.push(internalStatuses); statusClause = `t.internal_status = ANY($${p++}::text[])`;
    } else {
      params.push(externalStatuses); statusClause = `t.coastal_status = ANY($${p++}::text[])`;
    }

    const clauses = [];
    const projectIds = (req.query.project_ids || '').split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n));
    const companyIds  = (req.query.company_ids  || '').split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n));
    const updatedFrom = req.query.updated_from || null;
    const updatedTo   = req.query.updated_to   || null;

    if (projectIds.length) { clauses.push(`t.project_id = ANY($${p++}::int[])`); params.push(projectIds); }
    if (updatedFrom)        { clauses.push(`t.updated_at >= $${p++}::date`);      params.push(updatedFrom); }
    if (updatedTo)          { clauses.push(`t.updated_at < ($${p++}::date + interval '1 day')`); params.push(updatedTo); }
    if (companyIds.length) {
      clauses.push(`EXISTS (
        SELECT 1 FROM ticket_contacts tc2
        JOIN contacts con2 ON con2.id = tc2.contact_id
        WHERE tc2.ticket_id = t.id AND con2.company_id = ANY($${p++}::int[])
      )`);
      params.push(companyIds);
    }

    const extraWhere = clauses.length ? `AND ${clauses.join(' AND ')}` : '';

    const result = await pool.query(`
      SELECT
        t.id, t.mot_ref,
        t.title, t.title_enc,
        t.description, t.description_enc,
        t.internal_status, t.coastal_status, t.external_ticket_ref,
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
      WHERE ${statusClause}
      ${extraWhere}
      GROUP BY
        t.id, u_sub.display_name, u_asgn.display_name,
        proj.name, proj.prefix
      ORDER BY t.effective_priority ASC, t.mot_ref ASC
    `, params);

    await decryptRows('tickets', result.rows);
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

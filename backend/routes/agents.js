// Agent listings — users marked is_agent on at least one project. Used
// by the assignment + escalation admin pages to populate the user pool
// without leaning on the role enum (which was the old filter).

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/agents — distinct active users who are agent on at least
// one active project. Used by org-default policy editors where no
// specific project scope is set.
router.get('/', requireAuth, requireRole('Admin', 'Manager'), async (_req, res) => {
  try {
    const r = await pool.query(`
      SELECT DISTINCT u.id, u.display_name, u.email, u.role
        FROM users u
        JOIN project_members pm ON pm.user_id = u.id
        JOIN projects p ON p.id = pm.project_id
       WHERE pm.is_agent = TRUE
         AND u.status = 'active'
         AND p.status = 'active'
       ORDER BY u.display_name ASC
    `);
    res.json(r.rows);
  } catch (err) {
    console.error('agents list:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/agents/eligible — assignees the UI can offer. Unions global
// handler-roled users (Admin/Manager/Tech) with project-scoped is_agent
// members. When ?project_id=N is supplied, restricts the is_agent set
// to that project; otherwise pulls anyone flagged on at least one
// active project. Used by the bulk-edit assignee picker so non-handler
// users (Submitters/Viewers) never appear.
router.get('/eligible', requireAuth, async (req, res) => {
  try {
    const projectId = req.query.project_id ? Number(req.query.project_id) : null;
    const params = [];
    let agentClause;
    if (Number.isInteger(projectId) && projectId > 0) {
      params.push(projectId);
      agentClause = `
        SELECT u.id, u.display_name, u.email, u.role
          FROM users u
          JOIN project_members pm ON pm.user_id = u.id
         WHERE pm.project_id = $1 AND pm.is_agent = TRUE
           AND u.status = 'active'
      `;
    } else {
      agentClause = `
        SELECT DISTINCT u.id, u.display_name, u.email, u.role
          FROM users u
          JOIN project_members pm ON pm.user_id = u.id
          JOIN projects p ON p.id = pm.project_id
         WHERE pm.is_agent = TRUE
           AND u.status = 'active'
           AND p.status = 'active'
      `;
    }
    const r = await pool.query(`
      ${agentClause}
      UNION
      SELECT u.id, u.display_name, u.email, u.role
        FROM users u
       WHERE u.role IN ('Admin', 'Manager', 'Tech')
         AND u.status = 'active'
      ORDER BY display_name ASC
    `, params);
    res.json(r.rows);
  } catch (err) {
    console.error('agents eligible list:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/agents/project/:id — agents on a specific project.
router.get('/project/:id', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT u.id, u.display_name, u.email, u.role
        FROM users u
        JOIN project_members pm ON pm.user_id = u.id
       WHERE pm.project_id = $1
         AND pm.is_agent = TRUE
         AND u.status = 'active'
       ORDER BY u.display_name ASC
    `, [req.params.id]);
    res.json(r.rows);
  } catch (err) {
    console.error('agents project list:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

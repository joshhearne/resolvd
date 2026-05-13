const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getRestrictionDefaults, effectiveFlag } = require('../services/restrictions');

const router = express.Router();

const VALID_ROLES = ['Admin', 'Submitter', 'Viewer'];

// GET /api/projects — Admin: all; others: their projects
router.get('/', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    let result;

    if (user.role === 'Admin') {
      result = await pool.query(`
        SELECT p.*,
          u.display_name as created_by_name,
          (SELECT COUNT(*) FROM tickets t WHERE t.project_id = p.id)::int as ticket_count,
          (SELECT COUNT(*) FROM project_members pm WHERE pm.project_id = p.id)::int as member_count
        FROM projects p
        LEFT JOIN users u ON p.created_by = u.id
        ORDER BY p.status ASC, p.name ASC
      `);
    } else {
      result = await pool.query(`
        SELECT p.*,
          u.display_name as created_by_name,
          (SELECT COUNT(*) FROM tickets t WHERE t.project_id = p.id)::int as ticket_count,
          (SELECT COUNT(*) FROM project_members pm2 WHERE pm2.project_id = p.id)::int as member_count,
          pm.role_override
        FROM projects p
        JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1
        LEFT JOIN users u ON p.created_by = u.id
        WHERE p.status = 'active'
        ORDER BY p.name ASC
      `, [user.id]);
    }

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/projects — Admin only
router.post('/', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const { name, prefix, description, has_external_vendor } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
    if (!prefix?.trim()) return res.status(400).json({ error: 'Prefix required' });

    const cleanPrefix = prefix.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!cleanPrefix) return res.status(400).json({ error: 'Prefix must contain letters or numbers' });

    const hasVendor = has_external_vendor !== false && has_external_vendor !== 'false';
    const result = await pool.query(`
      INSERT INTO projects (name, prefix, description, has_external_vendor, created_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [name.trim(), cleanPrefix, description?.trim() || null, hasVendor, req.session.user.id]);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Prefix already in use' });
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/projects/:id — with members
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;

    const projectResult = await pool.query(`
      SELECT p.*, u.display_name as created_by_name,
        (SELECT COUNT(*) FROM tickets t WHERE t.project_id = p.id)::int as ticket_count
      FROM projects p
      LEFT JOIN users u ON p.created_by = u.id
      WHERE p.id = $1
    `, [req.params.id]);

    const project = projectResult.rows[0];
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Access check for non-admins
    if (user.role !== 'Admin') {
      const member = await pool.query(
        'SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2',
        [req.params.id, user.id]
      );
      if (!member.rows[0]) return res.status(403).json({ error: 'Not a project member' });
    }

    const membersResult = await pool.query(`
      SELECT pm.id, pm.user_id, pm.role_override, pm.is_agent, pm.added_at,
        u.display_name, u.email, u.role as global_role, u.status,
        adder.display_name as added_by_name
      FROM project_members pm
      JOIN users u ON pm.user_id = u.id
      LEFT JOIN users adder ON pm.added_by = adder.id
      WHERE pm.project_id = $1
      ORDER BY u.display_name ASC
    `, [req.params.id]);

    const defaults = await getRestrictionDefaults();
    res.json({
      ...project,
      members: membersResult.rows,
      effective_restrict_followers: effectiveFlag(project.restrict_followers_to_members, defaults.followers),
      effective_restrict_mentions: effectiveFlag(project.restrict_mentions_to_members, defaults.mentions),
      defaults,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/projects/:id — Admin only
router.patch('/:id', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const { name, description, status, has_external_vendor, default_assignee_id, restrict_followers_to_members, restrict_mentions_to_members, auto_add_new_users, ai_context_md, ai_context_enabled, allow_asset_linking, asset_company_ids } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name.trim();
    if (description !== undefined) updates.description = description?.trim() || null;
    if (status !== undefined) {
      if (!['active', 'archived'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
      updates.status = status;
    }
    if (has_external_vendor !== undefined) updates.has_external_vendor = has_external_vendor !== false && has_external_vendor !== 'false';
    // Tri-state: null clears the per-project override and inherits the
    // org default; true/false sets an explicit per-project policy.
    if (restrict_followers_to_members !== undefined) {
      updates.restrict_followers_to_members = restrict_followers_to_members === null
        ? null
        : (restrict_followers_to_members !== false && restrict_followers_to_members !== 'false');
    }
    if (restrict_mentions_to_members !== undefined) {
      updates.restrict_mentions_to_members = restrict_mentions_to_members === null
        ? null
        : (restrict_mentions_to_members !== false && restrict_mentions_to_members !== 'false');
    }
    if (auto_add_new_users !== undefined) {
      updates.auto_add_new_users = auto_add_new_users !== false && auto_add_new_users !== 'false';
    }
    if (ai_context_md !== undefined) {
      // Cap context at 8KB. AI providers will accept much more, but
      // every byte costs input tokens on every rewrite call. If admin
      // needs more, raise the cap deliberately.
      const md = (ai_context_md ?? '').toString();
      if (md.length > 8000) return res.status(400).json({ error: 'ai_context_md too long (8000 char limit)' });
      updates.ai_context_md = md.trim() || null;
    }
    if (ai_context_enabled !== undefined) {
      updates.ai_context_enabled = ai_context_enabled !== false && ai_context_enabled !== 'false';
    }
    if (allow_asset_linking !== undefined) {
      updates.allow_asset_linking = allow_asset_linking !== false && allow_asset_linking !== 'false';
    }
    if (asset_company_ids !== undefined) {
      if (!Array.isArray(asset_company_ids) || asset_company_ids.some((id) => !Number.isInteger(id) || id <= 0)) {
        return res.status(400).json({ error: 'asset_company_ids must be an array of positive integer ids' });
      }
      updates.asset_company_ids = asset_company_ids;
    }
    if (default_assignee_id !== undefined) {
      if (default_assignee_id === null || default_assignee_id === '') {
        updates.default_assignee_id = null;
      } else {
        const id = Number(default_assignee_id);
        if (!Number.isInteger(id) || id <= 0) {
          return res.status(400).json({ error: 'default_assignee_id must be a user id or null' });
        }
        const u = await pool.query(
          `SELECT id, role FROM users WHERE id = $1 AND status = 'active'`,
          [id]
        );
        if (!u.rows[0]) return res.status(400).json({ error: 'default_assignee_id user not found or inactive' });
        if (!['Admin', 'Manager', 'Submitter'].includes(u.rows[0].role)) {
          return res.status(400).json({ error: 'Default assignee must have role Submitter, Manager, or Admin' });
        }
        updates.default_assignee_id = id;
      }
    }
    if (Object.keys(updates).length === 0) {
      const r = await pool.query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
      return res.json(r.rows[0]);
    }
    updates.updated_at = new Date().toISOString();
    const keys = Object.keys(updates);
    const vals = Object.values(updates);
    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const result = await pool.query(
      `UPDATE projects SET ${setClauses} WHERE id = $${keys.length + 1} RETURNING *`,
      [...vals, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Project not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/projects/:id — Admin only, only if no tickets
router.delete('/:id', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const count = await pool.query('SELECT COUNT(*) as cnt FROM tickets WHERE project_id = $1', [req.params.id]);
    if (parseInt(count.rows[0].cnt, 10) > 0) {
      return res.status(409).json({ error: 'Cannot delete project with tickets. Archive it instead.' });
    }
    const result = await pool.query('DELETE FROM projects WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Project not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/projects/:id/members — Admin only
router.post('/:id/members', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const { user_id, role_override } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    if (role_override && !VALID_ROLES.includes(role_override)) {
      return res.status(400).json({ error: 'Invalid role_override' });
    }

    const result = await pool.query(`
      INSERT INTO project_members (project_id, user_id, role_override, added_by)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (project_id, user_id) DO UPDATE SET role_override = EXCLUDED.role_override
      RETURNING *
    `, [req.params.id, user_id, role_override || null, req.session.user.id]);

    // Re-fetch with user details
    const member = await pool.query(`
      SELECT pm.id, pm.user_id, pm.role_override, pm.added_at,
        u.display_name, u.email, u.role as global_role
      FROM project_members pm
      JOIN users u ON pm.user_id = u.id
      WHERE pm.id = $1
    `, [result.rows[0].id]);

    res.status(201).json(member.rows[0]);
  } catch (err) {
    if (err.code === '23503') return res.status(404).json({ error: 'User or project not found' });
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/projects/:id/members/bulk — Admin/Manager bulk-add
// Body: { user_ids: [int], role_override?: 'Admin'|'Submitter'|'Viewer' }
// Idempotent (ON CONFLICT updates role_override). Returns the count of
// rows added or updated and the full member list.
router.post('/:id/members/bulk', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const { user_ids, role_override } = req.body || {};
    if (!Array.isArray(user_ids) || user_ids.length === 0) {
      return res.status(400).json({ error: 'user_ids array required' });
    }
    if (role_override && !VALID_ROLES.includes(role_override)) {
      return res.status(400).json({ error: 'Invalid role_override' });
    }
    // Capped to keep one request from chewing the connection.
    const ids = user_ids.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
    if (ids.length > 500) return res.status(400).json({ error: 'Bulk add limited to 500 users per call' });

    let added = 0;
    for (const uid of ids) {
      const r = await pool.query(`
        INSERT INTO project_members (project_id, user_id, role_override, added_by)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (project_id, user_id) DO UPDATE SET role_override = EXCLUDED.role_override
        RETURNING id, (xmax = 0) AS inserted
      `, [req.params.id, uid, role_override || null, req.session.user.id]);
      if (r.rows[0]?.inserted) added++;
    }

    const members = await pool.query(`
      SELECT pm.id, pm.user_id, pm.role_override, pm.added_at,
        u.display_name, u.email, u.role as global_role, u.status,
        adder.display_name as added_by_name
      FROM project_members pm
      JOIN users u ON pm.user_id = u.id
      LEFT JOIN users adder ON pm.added_by = adder.id
      WHERE pm.project_id = $1
      ORDER BY u.display_name ASC
    `, [req.params.id]);

    res.json({ added, total: ids.length, members: members.rows });
  } catch (err) {
    console.error('bulk add members failed:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/projects/:id/members/:uid — update role override and/or
// agent flag. Either or both can be patched in one call; omitted fields
// are left untouched.
router.patch('/:id/members/:uid', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const body = req.body || {};
    const sets = [];
    const values = [];
    let p = 1;
    if (Object.prototype.hasOwnProperty.call(body, 'role_override')) {
      if (body.role_override && !VALID_ROLES.includes(body.role_override)) {
        return res.status(400).json({ error: 'Invalid role_override' });
      }
      sets.push(`role_override = $${p++}`);
      values.push(body.role_override || null);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'is_agent')) {
      if (typeof body.is_agent !== 'boolean') {
        return res.status(400).json({ error: 'is_agent must be boolean' });
      }
      sets.push(`is_agent = $${p++}`);
      values.push(body.is_agent);
    }
    if (!sets.length) return res.status(400).json({ error: 'no updatable fields supplied' });
    values.push(req.params.id, req.params.uid);
    const result = await pool.query(
      `UPDATE project_members SET ${sets.join(', ')} WHERE project_id = $${p++} AND user_id = $${p} RETURNING *`,
      values
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Member not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/projects/:id/members/:uid — remove member
router.delete('/:id/members/:uid', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM project_members WHERE project_id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.params.uid]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Member not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

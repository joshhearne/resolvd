const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { render } = require('../services/cannedRender');

const router = express.Router();

function isPriv(role) {
  return ['Admin', 'Manager'].includes(role);
}

// GET /api/canned-responses — list visible to caller (own user-scoped +
// all globals). Optional ?category=... filter.
// GET /api/canned-responses
//   ?category=...      — filter by category (admin page filter)
//   ?project_id=N      — filter to responses that apply to that project
//                        (NULL/empty project_ids = all projects). Without
//                        this param, returns every visible response so the
//                        admin manage page can show the full inventory.
router.get('/', requireAuth, async (req, res) => {
  try {
    const { category, project_id } = req.query;
    const params = [req.session.user.id];
    const where = [`(scope = 'global' OR (scope = 'user' AND user_id = $1))`];
    if (category) {
      params.push(category);
      where.push(`category = $${params.length}`);
    }
    if (project_id) {
      params.push(Number(project_id));
      where.push(
        `(project_ids IS NULL OR cardinality(project_ids) = 0 OR $${params.length} = ANY(project_ids))`
      );
    }
    const r = await pool.query(
      `SELECT * FROM canned_responses
        WHERE ${where.join(' AND ')}
        ORDER BY use_count DESC, scope DESC, title ASC`,
      params
    );
    res.json(r.rows);
  } catch (err) {
    console.error('canned list error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/canned-responses
router.post('/', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const { scope = 'user', title, body, category, project_ids } = req.body || {};
    if (!title || typeof title !== 'string') return res.status(400).json({ error: 'title required' });
    if (!body || typeof body !== 'string') return res.status(400).json({ error: 'body required' });
    if (!['global', 'user'].includes(scope)) return res.status(400).json({ error: 'scope must be global|user' });
    if (scope === 'global' && !isPriv(user.role)) {
      return res.status(403).json({ error: 'Only Admin/Manager can create global responses' });
    }

    const projects = Array.isArray(project_ids)
      ? project_ids.map(Number).filter((n) => Number.isFinite(n) && n > 0)
      : null;

    const r = await pool.query(
      `INSERT INTO canned_responses (scope, user_id, title, body, category, project_ids, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        scope,
        scope === 'user' ? user.id : null,
        title.trim(),
        body,
        (category || '').trim() || null,
        projects && projects.length ? projects : null,
        user.id,
      ]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error('canned create error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/canned-responses/:id
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const id = Number(req.params.id);
    const existing = await pool.query(`SELECT * FROM canned_responses WHERE id = $1`, [id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Not found' });
    const row = existing.rows[0];

    const canEdit =
      (row.scope === 'user' && row.user_id === user.id) ||
      (row.scope === 'global' && isPriv(user.role));
    if (!canEdit) return res.status(403).json({ error: 'Forbidden' });

    const { title, body, category, project_ids } = req.body || {};
    const sets = [];
    const values = [];
    let p = 1;
    if (title !== undefined) { sets.push(`title = $${p++}`); values.push(String(title).trim()); }
    if (body !== undefined) { sets.push(`body = $${p++}`); values.push(String(body)); }
    if (category !== undefined) {
      sets.push(`category = $${p++}`);
      values.push((String(category || '').trim()) || null);
    }
    if (project_ids !== undefined) {
      const projects = Array.isArray(project_ids)
        ? project_ids.map(Number).filter((n) => Number.isFinite(n) && n > 0)
        : null;
      sets.push(`project_ids = $${p++}`);
      values.push(projects && projects.length ? projects : null);
    }
    if (!sets.length) return res.status(400).json({ error: 'No updatable fields' });
    sets.push(`updated_at = NOW()`);
    values.push(id);
    const r = await pool.query(
      `UPDATE canned_responses SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`,
      values
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error('canned patch error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/canned-responses/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const id = Number(req.params.id);
    const existing = await pool.query(`SELECT * FROM canned_responses WHERE id = $1`, [id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Not found' });
    const row = existing.rows[0];
    const canDel =
      (row.scope === 'user' && row.user_id === user.id) ||
      (row.scope === 'global' && isPriv(user.role));
    if (!canDel) return res.status(403).json({ error: 'Forbidden' });
    await pool.query(`DELETE FROM canned_responses WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('canned delete error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/canned-responses/:id/render — return the body with tags
// substituted for a given ticket context. Non-mutating preview by
// default; `record_use=true` increments the usage counter (caller should
// pass true when actually inserting into a comment).
router.post('/:id/render', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const id = Number(req.params.id);
    const { ticket_id, record_use } = req.body || {};
    const r = await pool.query(`SELECT * FROM canned_responses WHERE id = $1`, [id]);
    const row = r.rows[0];
    if (!row) return res.status(404).json({ error: 'Not found' });
    // Visibility: globals or own user-scoped
    if (row.scope === 'user' && row.user_id !== user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const rendered = await render(row.body, {
      ticketId: ticket_id ? Number(ticket_id) : null,
      actorId: user.id,
    });

    if (record_use) {
      await pool.query(
        `UPDATE canned_responses
            SET use_count = use_count + 1, last_used_at = NOW()
          WHERE id = $1`,
        [id]
      );
    }

    res.json({ rendered, source_body: row.body });
  } catch (err) {
    console.error('canned render error:', err);
    res.status(500).json({ error: 'Render error' });
  }
});

module.exports = router;

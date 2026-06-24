// Project-scoped ticket forms (Phase 1).
//
//   project ──< ticket_categories ──< ticket_forms ──< ticket_form_fields → custom_field_defs
//
// Categories sub-group a project ("Service Request", "HR"); forms are request
// types ("Onboarding") that bind a set of fields; the binding row carries the
// per-form `required` flag. Required-ness lives on the binding, never on the
// field def — so a field is only mandatory on the forms that opt in. That is
// the anti-bleed guarantee versus a global "required field on every ticket".
//
// Mutations are Admin-only. Reads are gated to the caller's accessible
// projects (Admin/Manager see all; others see their project_members rows),
// which is also how the HR project stays invisible to non-members.

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Mirror of the per-route helper used elsewhere (tickets.js, sla.js): null =
// all projects (Admin/Manager), otherwise the member project id list.
async function getAccessibleProjectIds(user) {
  if (['Admin', 'Manager'].includes(user.role)) return null;
  const result = await pool.query(
    'SELECT project_id FROM project_members WHERE user_id = $1',
    [user.id]
  );
  return result.rows.map((r) => r.project_id);
}

// True if the caller may see/use a given project.
async function canAccessProject(user, projectId) {
  const ids = await getAccessibleProjectIds(user);
  if (ids === null) return true;
  return ids.includes(Number(projectId));
}

// ───────── Categories ───────────────────────────────────────────────

// GET /api/forms/categories?project_id=N — list a project's categories.
router.get('/categories', requireAuth, async (req, res) => {
  try {
    const projectId = Number(req.query.project_id);
    if (!Number.isInteger(projectId) || projectId <= 0) return res.status(400).json({ error: 'project_id required' });
    if (!(await canAccessProject(req.session.user, projectId))) return res.status(403).json({ error: 'no access to project' });
    const r = await pool.query(
      `SELECT * FROM ticket_categories WHERE project_id = $1 ORDER BY sort_order, id`,
      [projectId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('categories list:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.post('/categories', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const { project_id, name, sort_order } = req.body || {};
    const projectId = Number(project_id);
    if (!Number.isInteger(projectId) || projectId <= 0) return res.status(400).json({ error: 'project_id required' });
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name required' });
    const proj = await pool.query(`SELECT 1 FROM projects WHERE id = $1`, [projectId]);
    if (!proj.rows[0]) return res.status(404).json({ error: 'project not found' });
    const r = await pool.query(
      `INSERT INTO ticket_categories (project_id, name, sort_order)
       VALUES ($1, $2, COALESCE($3, 0)) RETURNING *`,
      [projectId, name.trim(), sort_order]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'a category with that name already exists in this project' });
    console.error('category create:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.patch('/categories/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const sets = [];
    const values = [];
    let p = 1;
    if (req.body.name !== undefined) { sets.push(`name = $${p++}`); values.push(String(req.body.name).trim()); }
    if (req.body.sort_order !== undefined) { sets.push(`sort_order = $${p++}`); values.push(Number(req.body.sort_order) || 0); }
    if (!sets.length) return res.status(400).json({ error: 'no updatable fields supplied' });
    values.push(id);
    const r = await pool.query(`UPDATE ticket_categories SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`, values);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'name already in use in this project' });
    console.error('category patch:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Cascade removes child forms + bindings (NOT field defs or stored values).
router.delete('/categories/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM ticket_categories WHERE id = $1 RETURNING id`, [Number(req.params.id)]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('category delete:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ───────── Forms ─────────────────────────────────────────────────────

// GET /api/forms?project_id=N — category→forms tree for the picker, scoped to
// the caller's accessible projects. Omit project_id to get every accessible
// project's tree (for the global menu).
router.get('/', requireAuth, async (req, res) => {
  try {
    const ids = await getAccessibleProjectIds(req.session.user);
    const params = [];
    const clauses = [];
    if (req.query.project_id !== undefined) {
      const pid = Number(req.query.project_id);
      if (!Number.isInteger(pid) || pid <= 0) return res.status(400).json({ error: 'invalid project_id' });
      if (!(await canAccessProject(req.session.user, pid))) return res.status(403).json({ error: 'no access to project' });
      params.push(pid);
      clauses.push(`c.project_id = $${params.length}`);
    } else if (ids !== null) {
      if (!ids.length) return res.json([]);
      params.push(ids);
      clauses.push(`c.project_id = ANY($${params.length}::int[])`);
    }
    if (req.query.include_disabled !== '1') clauses.push(`f.enabled = TRUE`);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const r = await pool.query(
      `SELECT f.*, c.project_id, c.name AS category_name
         FROM ticket_forms f
         JOIN ticket_categories c ON c.id = f.category_id
         ${where}
        ORDER BY c.project_id, c.sort_order, c.id, f.sort_order, f.id`,
      params
    );
    res.json(r.rows);
  } catch (err) {
    console.error('forms list:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/forms/:id — the render contract: form meta + ordered fields with
// the per-form `required` flag merged onto each def.
router.get('/:id(\\d+)', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const meta = await pool.query(
      `SELECT f.*, c.project_id, c.name AS category_name
         FROM ticket_forms f JOIN ticket_categories c ON c.id = f.category_id
        WHERE f.id = $1`,
      [id]
    );
    if (!meta.rows[0]) return res.status(404).json({ error: 'not found' });
    if (!(await canAccessProject(req.session.user, meta.rows[0].project_id))) return res.status(403).json({ error: 'no access' });
    const fields = await pool.query(
      `SELECT ff.id AS binding_id, ff.required, ff.sort_order,
              d.id AS def_id, d.slug, d.label, d.type, d.options, d.help_text, d.sensitive, d.agent_only
         FROM ticket_form_fields ff
         JOIN custom_field_defs d ON d.id = ff.field_def_id
        WHERE ff.form_id = $1 AND d.archived = FALSE
        ORDER BY ff.sort_order, ff.id`,
      [id]
    );
    res.json({ form: meta.rows[0], project_id: meta.rows[0].project_id, fields: fields.rows });
  } catch (err) {
    console.error('form get:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.post('/', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const { category_id, name, description, enabled, sort_order, default_title, default_description } = req.body || {};
    const catId = Number(category_id);
    if (!Number.isInteger(catId) || catId <= 0) return res.status(400).json({ error: 'category_id required' });
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name required' });
    const cat = await pool.query(`SELECT 1 FROM ticket_categories WHERE id = $1`, [catId]);
    if (!cat.rows[0]) return res.status(404).json({ error: 'category not found' });
    const r = await pool.query(
      `INSERT INTO ticket_forms (category_id, name, description, enabled, sort_order, created_by, default_title, default_description)
       VALUES ($1, $2, $3, COALESCE($4, TRUE), COALESCE($5, 0), $6, $7, $8) RETURNING *`,
      [catId, name.trim(), description || null, enabled, sort_order, req.session.user.id, default_title || null, default_description || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'a form with that name already exists in this category' });
    console.error('form create:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.patch('/:id(\\d+)', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const sets = [];
    const values = [];
    let p = 1;
    for (const [k, col] of [['name', 'name'], ['description', 'description'], ['default_title', 'default_title'], ['default_description', 'default_description']]) {
      if (req.body[k] !== undefined) { sets.push(`${col} = $${p++}`); values.push(req.body[k] == null ? null : String(req.body[k]).trim() || null); }
    }
    if (req.body.enabled !== undefined) { sets.push(`enabled = $${p++}`); values.push(!!req.body.enabled); }
    if (req.body.sort_order !== undefined) { sets.push(`sort_order = $${p++}`); values.push(Number(req.body.sort_order) || 0); }
    if (req.body.category_id !== undefined) { sets.push(`category_id = $${p++}`); values.push(Number(req.body.category_id)); }
    if (!sets.length) return res.status(400).json({ error: 'no updatable fields supplied' });
    sets.push('updated_at = NOW()');
    values.push(id);
    const r = await pool.query(`UPDATE ticket_forms SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`, values);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'name already in use in this category' });
    console.error('form patch:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.delete('/:id(\\d+)', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM ticket_forms WHERE id = $1 RETURNING id`, [Number(req.params.id)]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('form delete:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ───────── Form ↔ field bindings ─────────────────────────────────────

// PUT /api/forms/:id/fields — replace the form's field set in one shot.
// Body: [{ field_def_id, required, sort_order }]. Each def must be a ticket
// def that's either shared (project_id NULL) or local to this form's project.
router.put('/:id(\\d+)/fields', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const formId = Number(req.params.id);
    const items = Array.isArray(req.body) ? req.body : [];
    const meta = await pool.query(
      `SELECT c.project_id FROM ticket_forms f JOIN ticket_categories c ON c.id = f.category_id WHERE f.id = $1`,
      [formId]
    );
    if (!meta.rows[0]) return res.status(404).json({ error: 'form not found' });
    const projectId = meta.rows[0].project_id;

    const defIds = items.map((i) => Number(i.field_def_id)).filter((n) => Number.isInteger(n) && n > 0);
    if (defIds.length) {
      const ok = await pool.query(
        `SELECT id FROM custom_field_defs
          WHERE id = ANY($1::int[]) AND entity_type = 'ticket' AND archived = FALSE
            AND (project_id IS NULL OR project_id = $2)`,
        [defIds, projectId]
      );
      if (ok.rows.length !== defIds.length) {
        return res.status(400).json({ error: 'one or more field defs are invalid, archived, or out of project scope' });
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM ticket_form_fields WHERE form_id = $1`, [formId]);
      let order = 0;
      for (const it of items) {
        const defId = Number(it.field_def_id);
        if (!Number.isInteger(defId) || defId <= 0) continue;
        await client.query(
          `INSERT INTO ticket_form_fields (form_id, field_def_id, required, sort_order)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (form_id, field_def_id) DO UPDATE SET required = EXCLUDED.required, sort_order = EXCLUDED.sort_order`,
          [formId, defId, !!it.required, Number.isInteger(it.sort_order) ? it.sort_order : order++]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('form fields put:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
module.exports.getAccessibleProjectIds = getAccessibleProjectIds;

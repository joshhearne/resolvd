// Custom field defs + values. Phase 1C-1 surfaces this for the Asset
// entity; Ticket integration follows in a later PR if needed. Defs are
// Admin-only to mutate; reads available to Admin/Manager.

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const ENTITY_TYPES = ['asset', 'ticket'];
const FIELD_TYPES = ['text', 'number', 'date', 'bool', 'select'];

// Slugify a label: lowercase, alphanumeric + underscore. Used as the
// stable machine handle so renames don't break attribute mappings. When a
// projectPrefix is supplied (project-local def), the slug is prefixed with
// the lowercased project tag + hyphen (e.g. "hr-username") to cut
// cross-project name collisions.
function slugify(label, projectPrefix) {
  const base = String(label || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  if (!base) return base;
  if (projectPrefix) {
    const tag = String(projectPrefix).toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (tag) return `${tag}-${base}`.slice(0, 80);
  }
  return base;
}

function validateOptions(options, type) {
  if (type !== 'select') return null;
  if (!Array.isArray(options) || !options.length) return 'select type requires non-empty options array';
  for (const o of options) {
    if (!o || typeof o.value !== 'string' || typeof o.label !== 'string') {
      return 'each option must be { value: string, label: string }';
    }
  }
  return null;
}

// Coerce + validate a value against a def. Returns
// { col: 'value_text'|..., value } or { error: string }. NULL values
// clear the row.
function coerceValue(value, def) {
  if (value == null || value === '') return { col: null, value: null };
  switch (def.type) {
    case 'text':
      return { col: 'value_text', value: String(value) };
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) return { error: 'number required' };
      return { col: 'value_number', value: n };
    }
    case 'date': {
      const d = new Date(value);
      if (isNaN(d.getTime())) return { error: 'date required (ISO8601)' };
      return { col: 'value_date', value: d.toISOString() };
    }
    case 'bool':
      return { col: 'value_bool', value: !!value };
    case 'select': {
      const valid = (def.options || []).some((o) => o.value === String(value));
      if (!valid) return { error: 'value not in options' };
      return { col: 'value_text', value: String(value) };
    }
    default:
      return { error: 'unknown type' };
  }
}

// ───────── Defs ──────────────────────────────────────────────────────

router.get('/', requireAuth, requireRole('Admin', 'Manager', 'Tech'), async (req, res) => {
  try {
    const entity = req.query.entity_type;
    const params = [];
    const clauses = [];
    if (entity) {
      if (!ENTITY_TYPES.includes(entity)) return res.status(400).json({ error: 'invalid entity_type' });
      params.push(entity);
      clauses.push(`entity_type = $${params.length}`);
    }
    // project_id filter: pass an id for "shared library + that project's
    // locals"; omit for all. ?project_id=null|0 restricts to shared only.
    if (req.query.project_id !== undefined) {
      const pid = Number(req.query.project_id);
      if (Number.isInteger(pid) && pid > 0) {
        params.push(pid);
        clauses.push(`(project_id IS NULL OR project_id = $${params.length})`);
      } else {
        clauses.push(`project_id IS NULL`);
      }
    }
    // Hide soft-archived defs unless explicitly asked.
    if (req.query.include_archived !== '1') clauses.push(`archived = FALSE`);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const r = await pool.query(
      `SELECT * FROM custom_field_defs ${where} ORDER BY entity_type, sort_order, id`,
      params
    );
    res.json(r.rows);
  } catch (err) {
    console.error('custom field defs list:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.post('/', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const { entity_type, label, type, options, required, sort_order, help_text, project_id, sensitive, agent_only } = req.body || {};
    if (!ENTITY_TYPES.includes(entity_type)) return res.status(400).json({ error: 'invalid entity_type' });
    if (!label || typeof label !== 'string') return res.status(400).json({ error: 'label required' });
    if (!FIELD_TYPES.includes(type)) return res.status(400).json({ error: 'invalid type' });
    const optErr = validateOptions(options, type);
    if (optErr) return res.status(400).json({ error: optErr });

    // Resolve project scope + tag for the slug prefix. project_id absent/null
    // = shared global library (no prefix).
    let projId = null;
    let prefix = null;
    if (project_id !== undefined && project_id !== null && project_id !== '') {
      projId = Number(project_id);
      if (!Number.isInteger(projId) || projId <= 0) return res.status(400).json({ error: 'invalid project_id' });
      const proj = await pool.query(`SELECT prefix FROM projects WHERE id = $1`, [projId]);
      if (!proj.rows[0]) return res.status(404).json({ error: 'project not found' });
      prefix = proj.rows[0].prefix;
    }

    const slug = slugify(label, prefix);
    if (!slug) return res.status(400).json({ error: 'label must produce a non-empty slug' });

    // Friendly collision check within the target scope before relying on the
    // partial-unique index, so we can name the clashing slug + scope.
    const dupe = await pool.query(
      `SELECT id FROM custom_field_defs
        WHERE entity_type = $1 AND slug = $2 AND project_id IS NOT DISTINCT FROM $3`,
      [entity_type, slug, projId]
    );
    if (dupe.rows[0]) {
      return res.status(409).json({
        error: `Field slug "${slug}" already exists in ${projId ? `project ${prefix}` : 'the shared library'}. Pick a different label.`,
        slug,
      });
    }

    const r = await pool.query(
      `INSERT INTO custom_field_defs
         (entity_type, slug, label, type, options, required, sort_order, help_text, project_id, sensitive, agent_only)
       VALUES ($1, $2, $3, $4, $5::jsonb, COALESCE($6, FALSE), COALESCE($7, 0), $8, $9, COALESCE($10, FALSE), COALESCE($11, FALSE))
       RETURNING *`,
      [
        entity_type, slug, label.trim(), type,
        JSON.stringify(options || []),
        required, sort_order, help_text || null,
        projId, !!sensitive, !!agent_only,
      ]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'slug already in use in that scope' });
    console.error('custom field def create:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.patch('/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const body = req.body || {};
    const def = await pool.query(`SELECT * FROM custom_field_defs WHERE id = $1`, [id]);
    if (!def.rows[0]) return res.status(404).json({ error: 'not found' });

    const sets = [];
    const values = [];
    let p = 1;
    if (body.label !== undefined) {
      sets.push(`label = $${p++}`);
      values.push(String(body.label).trim());
    }
    if (body.type !== undefined) {
      if (!FIELD_TYPES.includes(body.type)) return res.status(400).json({ error: 'invalid type' });
      sets.push(`type = $${p++}`);
      values.push(body.type);
    }
    if (body.options !== undefined) {
      const t = body.type || def.rows[0].type;
      const optErr = validateOptions(body.options, t);
      if (optErr) return res.status(400).json({ error: optErr });
      sets.push(`options = $${p++}::jsonb`);
      values.push(JSON.stringify(body.options || []));
    }
    if (body.required !== undefined) {
      sets.push(`required = $${p++}`);
      values.push(!!body.required);
    }
    if (body.sort_order !== undefined) {
      sets.push(`sort_order = $${p++}`);
      values.push(Number(body.sort_order) || 0);
    }
    if (body.help_text !== undefined) {
      sets.push(`help_text = $${p++}`);
      values.push(body.help_text || null);
    }
    if (body.sensitive !== undefined) {
      sets.push(`sensitive = $${p++}`);
      values.push(!!body.sensitive);
    }
    if (body.agent_only !== undefined) {
      sets.push(`agent_only = $${p++}`);
      values.push(!!body.agent_only);
    }
    if (body.archived !== undefined) {
      sets.push(`archived = $${p++}`);
      values.push(!!body.archived);
    }
    if (!sets.length) return res.status(400).json({ error: 'no updatable fields supplied' });
    sets.push('updated_at = NOW()');
    values.push(id);
    const r = await pool.query(
      `UPDATE custom_field_defs SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`,
      values
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error('custom field def patch:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Soft-delete: archive the def so historical ticket/asset values survive and
// the slug stays reserved. Hard ?purge=1 still available for never-used defs.
router.delete('/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (req.query.purge === '1') {
      const inUse = await pool.query(`SELECT 1 FROM custom_field_values WHERE def_id = $1 LIMIT 1`, [id]);
      if (inUse.rows[0]) return res.status(409).json({ error: 'def has stored values; archive instead of purge' });
      const bound = await pool.query(`SELECT 1 FROM ticket_form_fields WHERE field_def_id = $1 LIMIT 1`, [id]);
      if (bound.rows[0]) return res.status(409).json({ error: 'def is bound to a form; unbind first' });
      const d = await pool.query(`DELETE FROM custom_field_defs WHERE id = $1 RETURNING id`, [id]);
      if (!d.rows[0]) return res.status(404).json({ error: 'not found' });
      return res.json({ ok: true, purged: true });
    }
    const r = await pool.query(
      `UPDATE custom_field_defs SET archived = TRUE, updated_at = NOW() WHERE id = $1 RETURNING id`,
      [id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, archived: true });
  } catch (err) {
    console.error('custom field def delete:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ───────── Values (asset-only for Phase 1C-1) ────────────────────────

// GET /api/custom-field-defs/values/asset/:id — list defs + the asset's
// values joined for rendering the edit panel.
router.get('/values/asset/:id', requireAuth, requireRole('Admin', 'Manager', 'Tech'), async (req, res) => {
  try {
    const assetId = Number(req.params.id);
    const r = await pool.query(
      `SELECT d.*, v.value_text, v.value_number, v.value_date, v.value_bool
         FROM custom_field_defs d
         LEFT JOIN custom_field_values v
           ON v.def_id = d.id AND v.asset_id = $1
        WHERE d.entity_type = 'asset'
        ORDER BY d.sort_order, d.id`,
      [assetId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('custom field values list:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PUT /api/custom-field-defs/values/asset/:id — bulk write. Body:
// [{ def_id, value }]. Each value is coerced per def type; null/empty
// removes the row.
router.put('/values/asset/:id', requireAuth, requireRole('Admin', 'Manager', 'Tech'), async (req, res) => {
  try {
    const assetId = Number(req.params.id);
    const items = Array.isArray(req.body) ? req.body : [];
    if (!items.length) return res.status(400).json({ error: 'expected array of {def_id, value}' });

    const exists = await pool.query(`SELECT 1 FROM assets WHERE id = $1`, [assetId]);
    if (!exists.rows[0]) return res.status(404).json({ error: 'asset not found' });

    const defIds = items.map((i) => Number(i.def_id)).filter((n) => Number.isInteger(n));
    if (!defIds.length) return res.status(400).json({ error: 'no valid def_ids' });
    const defsRows = await pool.query(
      `SELECT * FROM custom_field_defs WHERE id = ANY($1::int[]) AND entity_type = 'asset'`,
      [defIds]
    );
    const defsById = Object.fromEntries(defsRows.rows.map((d) => [d.id, d]));

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const it of items) {
        const def = defsById[Number(it.def_id)];
        if (!def) continue;
        const coerced = coerceValue(it.value, def);
        if (coerced.error) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `${def.slug}: ${coerced.error}` });
        }
        if (coerced.col == null) {
          await client.query(
            `DELETE FROM custom_field_values WHERE def_id = $1 AND asset_id = $2`,
            [def.id, assetId]
          );
          continue;
        }
        const cols = ['value_text', 'value_number', 'value_date', 'value_bool'];
        const setVals = cols.map((c) => (c === coerced.col ? coerced.value : null));
        await client.query(
          `INSERT INTO custom_field_values
             (def_id, asset_id, value_text, value_number, value_date, value_bool)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (def_id, asset_id) WHERE asset_id IS NOT NULL DO UPDATE SET
             value_text = EXCLUDED.value_text,
             value_number = EXCLUDED.value_number,
             value_date = EXCLUDED.value_date,
             value_bool = EXCLUDED.value_bool,
             updated_at = NOW()`,
          [def.id, assetId, ...setVals]
        );
      }
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('custom field values put:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
// Reusable helpers for the forms + ticket-create paths.
module.exports.slugify = slugify;
module.exports.coerceValue = coerceValue;
module.exports.FIELD_TYPES = FIELD_TYPES;

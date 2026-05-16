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
// stable machine handle so renames don't break attribute mappings.
function slugify(label) {
  return String(label || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
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
    let where = '';
    if (entity) {
      if (!ENTITY_TYPES.includes(entity)) return res.status(400).json({ error: 'invalid entity_type' });
      params.push(entity);
      where = `WHERE entity_type = $1`;
    }
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
    const { entity_type, label, type, options, required, sort_order, help_text } = req.body || {};
    if (!ENTITY_TYPES.includes(entity_type)) return res.status(400).json({ error: 'invalid entity_type' });
    if (!label || typeof label !== 'string') return res.status(400).json({ error: 'label required' });
    if (!FIELD_TYPES.includes(type)) return res.status(400).json({ error: 'invalid type' });
    const optErr = validateOptions(options, type);
    if (optErr) return res.status(400).json({ error: optErr });

    const slug = slugify(label);
    if (!slug) return res.status(400).json({ error: 'label must produce a non-empty slug' });

    const r = await pool.query(
      `INSERT INTO custom_field_defs
         (entity_type, slug, label, type, options, required, sort_order, help_text)
       VALUES ($1, $2, $3, $4, $5::jsonb, COALESCE($6, FALSE), COALESCE($7, 0), $8)
       RETURNING *`,
      [
        entity_type, slug, label.trim(), type,
        JSON.stringify(options || []),
        required, sort_order, help_text || null,
      ]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'slug already in use for that entity_type' });
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

router.delete('/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM custom_field_defs WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
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
           ON CONFLICT (def_id, asset_id) DO UPDATE SET
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

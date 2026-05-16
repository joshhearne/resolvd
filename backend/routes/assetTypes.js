// Asset types — drives which fields render on the New/Edit asset
// form. Phase 1B-2 ships a read-mostly API (admin can list + tweak
// required/sort flags); full CRUD lands when a real customization
// need surfaces. Seeded types are flagged is_system so the UI can
// prevent accidental deletion.

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const BUILTIN_KEYS = new Set([
  'hostname', 'serial', 'mac', 'ip_address', 'manufacturer', 'model',
  'os', 'os_version', 'cpu', 'ram_bytes', 'storage_bytes', 'organization',
]);

router.get('/', requireAuth, async (req, res) => {
  try {
    const types = await pool.query(
      `SELECT * FROM asset_types ORDER BY sort_order, label`
    );
    const fields = await pool.query(
      `SELECT * FROM asset_type_fields ORDER BY type_id, sort_order, id`
    );
    const byType = new Map();
    for (const f of fields.rows) {
      if (!byType.has(f.type_id)) byType.set(f.type_id, []);
      byType.get(f.type_id).push(f);
    }
    res.json(
      types.rows.map((t) => ({ ...t, fields: byType.get(t.id) || [] }))
    );
  } catch (err) {
    console.error('asset types list error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/asset-types — create a custom type. is_system stays false
// (no spoofing). Fields array optional; admin can edit after.
router.post('/', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const { slug, label, icon, sort_order, fields } = req.body || {};
    if (!slug || !/^[a-z0-9_]+$/.test(slug)) {
      return res.status(400).json({ error: 'slug must be lowercase alnum + underscore' });
    }
    if (!label || typeof label !== 'string') return res.status(400).json({ error: 'label required' });
    const r = await pool.query(
      `INSERT INTO asset_types (slug, label, icon, sort_order, is_system)
       VALUES ($1, $2, $3, COALESCE($4, 0), FALSE)
       RETURNING *`,
      [slug, label.trim(), icon || null, sort_order]
    );
    const typeId = r.rows[0].id;
    if (Array.isArray(fields)) {
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i] || {};
        if (!BUILTIN_KEYS.has(f.builtin_key)) continue;
        await pool.query(
          `INSERT INTO asset_type_fields (type_id, builtin_key, required, sort_order)
           VALUES ($1, $2, $3, $4)`,
          [typeId, f.builtin_key, !!f.required, f.sort_order ?? i]
        );
      }
    }
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'slug already exists' });
    console.error('asset type create:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.patch('/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const body = req.body || {};
    const sets = [];
    const values = [];
    let p = 1;
    for (const k of ['label', 'icon', 'sort_order']) {
      if (Object.prototype.hasOwnProperty.call(body, k)) {
        sets.push(`${k} = $${p++}`);
        values.push(body[k]);
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'fields')) {
      // Replace the field list entirely. Simpler than diffing for the
      // admin UI; the form holds the canonical state during edit.
      const fields = Array.isArray(body.fields) ? body.fields : [];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (sets.length) {
          sets.push('updated_at = NOW()');
          values.push(id);
          await client.query(
            `UPDATE asset_types SET ${sets.join(', ')} WHERE id = $${p}`,
            values
          );
        }
        await client.query(`DELETE FROM asset_type_fields WHERE type_id = $1`, [id]);
        for (let i = 0; i < fields.length; i++) {
          const f = fields[i] || {};
          if (!BUILTIN_KEYS.has(f.builtin_key)) continue;
          await client.query(
            `INSERT INTO asset_type_fields (type_id, builtin_key, required, sort_order)
             VALUES ($1, $2, $3, $4)`,
            [id, f.builtin_key, !!f.required, f.sort_order ?? i]
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
      return res.json({ ok: true });
    }
    if (!sets.length) return res.status(400).json({ error: 'no updatable fields supplied' });
    sets.push('updated_at = NOW()');
    values.push(id);
    const r = await pool.query(
      `UPDATE asset_types SET ${sets.join(', ')} WHERE id = $${p} RETURNING id`,
      values
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('asset type patch:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.delete('/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const r = await pool.query(`SELECT is_system FROM asset_types WHERE id = $1`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    if (r.rows[0].is_system) return res.status(400).json({ error: 'system types cannot be deleted' });
    await pool.query(`DELETE FROM asset_types WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('asset type delete:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

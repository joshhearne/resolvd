const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
const VALID_KINDS = ['internal', 'external'];
const VALID_MAP_KINDS = ['suggest', 'mirror'];

// GET /api/statuses — list (any auth)
// Returns { internal: [...], external: [...], transitions: [...], mappings: [...] }
router.get('/', requireAuth, async (req, res) => {
  try {
    const statuses = await pool.query('SELECT * FROM statuses ORDER BY kind, sort_order, id');
    const transitions = await pool.query('SELECT from_status_id, to_status_id FROM status_transitions');
    const mappings = await pool.query('SELECT id, internal_status_id, external_status_id, kind FROM status_mappings');
    const internal = statuses.rows.filter(s => s.kind === 'internal');
    const external = statuses.rows.filter(s => s.kind === 'external');
    res.json({
      internal,
      external,
      transitions: transitions.rows,
      mappings: mappings.rows,
    });
  } catch (err) {
    console.error('statuses list error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/statuses — create (Admin)
router.post('/', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const { kind, name, color, sort_order, is_initial, is_terminal, is_blocker, semantic_tag } = req.body || {};
    if (!VALID_KINDS.includes(kind)) return res.status(400).json({ error: 'Invalid kind' });
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
    const finalColor = /^#[0-9a-fA-F]{6}$/.test(color || '') ? color : '#6b7280';

    if (is_initial) {
      await pool.query('UPDATE statuses SET is_initial = FALSE WHERE kind = $1', [kind]);
    }

    const r = await pool.query(
      `INSERT INTO statuses (kind, name, color, sort_order, is_initial, is_terminal, is_blocker, semantic_tag)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        kind,
        name.trim(),
        finalColor,
        Number.isFinite(sort_order) ? sort_order : 100,
        !!is_initial,
        !!is_terminal,
        !!is_blocker,
        semantic_tag || null,
      ]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A status with that name already exists' });
    console.error('status create error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/statuses/:id — update (Admin)
router.patch('/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const { name, color, sort_order, is_initial, is_terminal, is_blocker, semantic_tag } = req.body || {};
    const cur = await pool.query('SELECT * FROM statuses WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'Not found' });
    const row = cur.rows[0];

    if (is_initial && !row.is_initial) {
      await pool.query('UPDATE statuses SET is_initial = FALSE WHERE kind = $1', [row.kind]);
    }

    const updates = {};
    if (name !== undefined && name.trim()) updates.name = name.trim();
    if (color !== undefined && /^#[0-9a-fA-F]{6}$/.test(color)) updates.color = color;
    if (sort_order !== undefined && Number.isFinite(Number(sort_order))) updates.sort_order = Number(sort_order);
    if (is_initial !== undefined) updates.is_initial = !!is_initial;
    if (is_terminal !== undefined) updates.is_terminal = !!is_terminal;
    if (is_blocker !== undefined) updates.is_blocker = !!is_blocker;
    if (semantic_tag !== undefined) updates.semantic_tag = semantic_tag || null;

    if (Object.keys(updates).length === 0) return res.json(row);

    const keys = Object.keys(updates);
    const vals = Object.values(updates);
    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const r = await pool.query(
      `UPDATE statuses SET ${setClauses} WHERE id = $${keys.length + 1} RETURNING *`,
      [...vals, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A status with that name already exists' });
    console.error('status update error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/statuses/:id — Admin. Refuses if any tickets use this status name.
router.delete('/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const cur = await pool.query('SELECT * FROM statuses WHERE id = $1', [req.params.id]);
    const row = cur.rows[0];
    if (!row) return res.status(404).json({ error: 'Not found' });

    const col = row.kind === 'internal' ? 'internal_status' : 'coastal_status';
    const usage = await pool.query(`SELECT COUNT(*) AS cnt FROM tickets WHERE ${col} = $1`, [row.name]);
    if (parseInt(usage.rows[0].cnt, 10) > 0) {
      return res.status(409).json({ error: 'Status is in use by existing tickets' });
    }
    await pool.query('DELETE FROM statuses WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('status delete error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PUT /api/statuses/:id/transitions — replace outgoing transitions (Admin)
// Body: { to_ids: [int, int, ...] }
router.put('/:id/transitions', requireAuth, requireRole('Admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    const fromId = Number(req.params.id);
    const { to_ids } = req.body || {};
    if (!Array.isArray(to_ids)) return res.status(400).json({ error: 'to_ids must be an array' });

    const cur = await client.query('SELECT kind FROM statuses WHERE id = $1', [fromId]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'Not found' });
    const kind = cur.rows[0].kind;

    // Same-kind only.
    if (to_ids.length) {
      const check = await client.query(
        'SELECT id FROM statuses WHERE id = ANY($1::int[]) AND kind = $2',
        [to_ids, kind]
      );
      if (check.rows.length !== to_ids.length) {
        return res.status(400).json({ error: 'to_ids must reference statuses of the same kind' });
      }
    }

    await client.query('BEGIN');
    await client.query('DELETE FROM status_transitions WHERE from_status_id = $1', [fromId]);
    for (const toId of to_ids) {
      if (toId === fromId) continue;
      await client.query(
        'INSERT INTO status_transitions (from_status_id, to_status_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [fromId, toId]
      );
    }
    await client.query('COMMIT');
    const r = await client.query('SELECT to_status_id FROM status_transitions WHERE from_status_id = $1', [fromId]);
    res.json({ from_status_id: fromId, to_ids: r.rows.map(x => x.to_status_id) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('status transitions error:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    client.release();
  }
});

// POST /api/statuses/mappings — create (Admin)
router.post('/mappings', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const { internal_status_id, external_status_id, kind } = req.body || {};
    if (!internal_status_id || !external_status_id) {
      return res.status(400).json({ error: 'Both status IDs required' });
    }
    const mapKind = VALID_MAP_KINDS.includes(kind) ? kind : 'suggest';
    const both = await pool.query(
      'SELECT id, kind FROM statuses WHERE id = ANY($1::int[])',
      [[internal_status_id, external_status_id]]
    );
    const i = both.rows.find(r => r.id === Number(internal_status_id));
    const e = both.rows.find(r => r.id === Number(external_status_id));
    if (!i || i.kind !== 'internal') return res.status(400).json({ error: 'internal_status_id must reference an internal status' });
    if (!e || e.kind !== 'external') return res.status(400).json({ error: 'external_status_id must reference an external status' });

    const r = await pool.query(
      `INSERT INTO status_mappings (internal_status_id, external_status_id, kind)
         VALUES ($1, $2, $3) RETURNING *`,
      [internal_status_id, external_status_id, mapKind]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Mapping already exists' });
    console.error('mapping create error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/statuses/mappings/:id — Admin
router.delete('/mappings/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    await pool.query('DELETE FROM status_mappings WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('mapping delete error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

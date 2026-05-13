const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { decryptRows } = require('../services/fields');

const router = express.Router();

// GET /api/assets — paginated list with optional search. Phase 1A
// surface for smoke testing the Action1 sync before the dedicated UI
// lands. project_id query param scopes results to assets eligible for
// linking on that project (used by the ticket asset picker).
router.get('/', requireAuth, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const q = (req.query.q || '').trim();
    const projectId = req.query.project_id ? Number(req.query.project_id) : null;

    const params = [];
    const conds = [];
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      conds.push(`(LOWER(hostname) LIKE $${params.length}
                   OR LOWER(serial) LIKE $${params.length}
                   OR LOWER(organization) LIKE $${params.length}
                   OR LOWER(model) LIKE $${params.length})`);
    }
    if (projectId) {
      // Project-scoped: respects allow_asset_linking + asset_company_ids
      // filter so the asset picker only shows what's actually pickable
      // for this project. Empty asset_company_ids = all assets allowed.
      const projRes = await pool.query(
        `SELECT allow_asset_linking, asset_company_ids FROM projects WHERE id = $1`,
        [projectId]
      );
      if (!projRes.rows[0]) return res.status(404).json({ error: 'project not found' });
      if (!projRes.rows[0].allow_asset_linking) {
        return res.json({ items: [], total: 0, limit, offset });
      }
      const companyIds = projRes.rows[0].asset_company_ids || [];
      if (companyIds.length) {
        params.push(companyIds);
        conds.push(`company_id = ANY($${params.length}::int[])`);
      }
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    params.push(limit, offset);
    const limitIdx = params.length - 1;
    const offsetIdx = params.length;

    const r = await pool.query(
      `SELECT id, source_system, source_external_id, hostname, serial,
              manufacturer, model, os, os_version, organization,
              linked_user_id, company_id,
              last_seen_at, updated_at
         FROM assets
         ${where}
         ORDER BY last_seen_at DESC NULLS LAST, hostname
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );
    const countParams = params.slice(0, params.length - 2);
    const total = await pool.query(`SELECT COUNT(*)::int AS n FROM assets ${where}`, countParams);
    res.json({ items: r.rows, total: total.rows[0].n, limit, offset });
  } catch (err) {
    console.error('assets list error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/assets/:id — single asset incl. raw_data + linked user
// details + tickets[]. Tickets decrypted via the standard helper.
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT a.*, u.display_name AS linked_user_name, u.email AS linked_user_email,
              c.name AS company_name
         FROM assets a
         LEFT JOIN users u ON u.id = a.linked_user_id
         LEFT JOIN companies c ON c.id = a.company_id
        WHERE a.id = $1`,
      [Number(req.params.id)]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });

    const tickets = await pool.query(
      `SELECT id, internal_ref, title, title_enc, effective_priority,
              internal_status, external_status, created_at, updated_at,
              resolved_at, project_id
         FROM tickets
        WHERE asset_id = $1
        ORDER BY created_at DESC
        LIMIT 100`,
      [Number(req.params.id)]
    );
    await decryptRows('tickets', tickets.rows);
    res.json({ ...r.rows[0], tickets: tickets.rows });
  } catch (err) {
    console.error('asset get error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/assets/:id — manual edits. Admin/Manager can fix matcher
// abstentions or re-assign company. Only fields useful to override
// manually are mutable here; structural fields come from sync.
router.patch('/:id', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const body = req.body || {};
    const sets = [];
    const values = [];
    let p = 1;
    if (Object.prototype.hasOwnProperty.call(body, 'linked_user_id')) {
      if (body.linked_user_id !== null
          && (!Number.isInteger(body.linked_user_id) || body.linked_user_id <= 0)) {
        return res.status(400).json({ error: 'linked_user_id must be positive integer or null' });
      }
      sets.push(`linked_user_id = $${p++}`);
      values.push(body.linked_user_id);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'company_id')) {
      if (body.company_id !== null
          && (!Number.isInteger(body.company_id) || body.company_id <= 0)) {
        return res.status(400).json({ error: 'company_id must be positive integer or null' });
      }
      sets.push(`company_id = $${p++}`);
      values.push(body.company_id);
    }
    if (!sets.length) return res.status(400).json({ error: 'no updatable fields supplied' });
    sets.push('updated_at = NOW()');
    values.push(Number(req.params.id));
    const r = await pool.query(
      `UPDATE assets SET ${sets.join(', ')} WHERE id = $${p} RETURNING id`,
      values
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('asset patch error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

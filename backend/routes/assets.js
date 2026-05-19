const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { decryptRows } = require('../services/fields');

const router = express.Router();

// GET /api/assets — paginated list with optional search. Phase 1A
// surface for smoke testing the Action1 sync before the dedicated UI
// lands. project_id query param scopes results to assets eligible for
// linking on that project (used by the ticket asset picker).
router.get('/', requireAuth, requireRole('Admin', 'Manager', 'Tech'), async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const q = (req.query.q || '').trim();
    const projectId = req.query.project_id ? Number(req.query.project_id) : null;
    const offlineRaw = Number(req.query.offline_days);
    const offlineDays = Number.isFinite(offlineRaw) && offlineRaw > 0 ? Math.floor(offlineRaw) : null;

    const params = [];
    const conds = [];
    if (offlineDays) {
      params.push(offlineDays);
      conds.push(`(a.last_seen_at IS NULL OR a.last_seen_at < NOW() - ($${params.length} || ' days')::interval)`);
    }
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      conds.push(`(LOWER(a.hostname) LIKE $${params.length}
                   OR LOWER(a.serial) LIKE $${params.length}
                   OR LOWER(a.organization) LIKE $${params.length}
                   OR LOWER(a.model) LIKE $${params.length})`);
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
        conds.push(`a.company_id = ANY($${params.length}::int[])`);
      }
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    params.push(limit, offset);
    const limitIdx = params.length - 1;
    const offsetIdx = params.length;

    const r = await pool.query(
      `SELECT a.id, a.source_system, a.source_external_id, a.hostname, a.serial,
              a.manufacturer, a.model, a.os, a.os_version, a.organization,
              a.linked_user_id, a.company_id, a.asset_type_id,
              at.slug AS asset_type_slug, at.label AS asset_type_label,
              a.missing_updates_critical, a.missing_updates_other,
              a.vulnerabilities_critical, a.vulnerabilities_other,
              a.update_status, a.vulnerability_status, a.reboot_required,
              a.last_seen_at, a.updated_at
         FROM assets a
         LEFT JOIN asset_types at ON at.id = a.asset_type_id
         ${where}
         ORDER BY a.last_seen_at DESC NULLS LAST, a.hostname
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );
    const countParams = params.slice(0, params.length - 2);
    const total = await pool.query(`SELECT COUNT(*)::int AS n FROM assets a ${where}`, countParams);
    res.json({ items: r.rows, total: total.rows[0].n, limit, offset });
  } catch (err) {
    console.error('assets list error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/assets/:id — single asset incl. raw_data + linked user
// details + tickets[]. Tickets decrypted via the standard helper.
router.get('/:id(\\d+)', requireAuth, requireRole('Admin', 'Manager', 'Tech'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT a.*, u.display_name AS linked_user_name, u.email AS linked_user_email,
              c.name AS company_name,
              at.slug AS asset_type_slug, at.label AS asset_type_label
         FROM assets a
         LEFT JOIN users u ON u.id = a.linked_user_id
         LEFT JOIN companies c ON c.id = a.company_id
         LEFT JOIN asset_types at ON at.id = a.asset_type_id
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

// Fields editable on RMM-managed assets — sync overrides these on every
// pull, so only the cross-reference cols are useful to override here.
const RMM_EDITABLE = ['linked_user_id', 'company_id', 'asset_type_id'];

// Fields editable on manual assets — admin owns the data, so the full
// structural set is fair game.
const MANUAL_EDITABLE = [
  'hostname', 'serial', 'mac', 'manufacturer', 'model', 'os', 'os_version',
  'cpu', 'ip_address', 'organization', 'linked_user_id', 'company_id',
  'ram_bytes', 'storage_bytes', 'asset_type_id',
];

const TEXT_FIELDS = new Set([
  'hostname', 'serial', 'mac', 'manufacturer', 'model',
  'os', 'os_version', 'cpu', 'ip_address', 'organization',
]);
const INT_FIELDS = new Set(['linked_user_id', 'company_id', 'ram_bytes', 'storage_bytes', 'asset_type_id']);

// POST /api/assets — manual asset create. Generates a UUID for the
// stable source_external_id so admin can decommission + reuse names
// freely. source_system = 'manual' distinguishes from RMM-managed rows.
//
// Validation: requires *something* identifying — hostname OR serial OR
// MAC. Monitors don't need a hostname; printers may not have a serial;
// floor is "we know what we're looking at by at least one identifier."
// If asset_type_id is set, also enforces that type's required field
// list.
router.post('/', requireAuth, requireRole('Admin', 'Manager', 'Tech'), async (req, res) => {
  try {
    const body = req.body || {};
    const ident = [body.hostname, body.serial, body.mac].some(
      (v) => typeof v === 'string' && v.trim()
    );
    if (!ident) {
      return res.status(400).json({ error: 'At least one of hostname, serial, MAC required' });
    }
    if (body.asset_type_id) {
      const tf = await pool.query(
        `SELECT builtin_key FROM asset_type_fields WHERE type_id = $1 AND required = TRUE`,
        [Number(body.asset_type_id)]
      );
      for (const row of tf.rows) {
        const v = body[row.builtin_key];
        if (v == null || (typeof v === 'string' && !v.trim())) {
          return res.status(400).json({ error: `${row.builtin_key} required for this asset type` });
        }
      }
    }
    const externalId = require('crypto').randomUUID();
    const cols = ['source_system', 'source_external_id'];
    const vals = ['manual', externalId];
    for (const f of MANUAL_EDITABLE) {
      if (!Object.prototype.hasOwnProperty.call(body, f)) continue;
      const v = body[f];
      if (TEXT_FIELDS.has(f)) {
        cols.push(f);
        vals.push(typeof v === 'string' ? v.trim() || null : null);
      } else if (INT_FIELDS.has(f)) {
        if (v !== null && (!Number.isInteger(v) || v < 0)) {
          return res.status(400).json({ error: `${f} must be non-negative integer or null` });
        }
        cols.push(f);
        vals.push(v);
      }
    }
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const r = await pool.query(
      `INSERT INTO assets (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`,
      vals
    );
    res.status(201).json({ id: r.rows[0].id });
  } catch (err) {
    console.error('asset create error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/assets/:id — manual assets get the full editable set,
// RMM-managed assets keep the narrow override set (sync clobbers
// structural fields on every pull anyway).
router.patch('/:id(\\d+)', requireAuth, requireRole('Admin', 'Manager', 'Tech'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await pool.query(`SELECT source_system FROM assets WHERE id = $1`, [id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'not found' });
    const isManual = existing.rows[0].source_system === 'manual';
    const editable = isManual ? MANUAL_EDITABLE : RMM_EDITABLE;

    const body = req.body || {};
    const sets = [];
    const values = [];
    let p = 1;
    for (const f of editable) {
      if (!Object.prototype.hasOwnProperty.call(body, f)) continue;
      let v = body[f];
      if (TEXT_FIELDS.has(f)) {
        v = typeof v === 'string' ? v.trim() || null : (v === null ? null : null);
      } else if (INT_FIELDS.has(f)) {
        if (v !== null && (!Number.isInteger(v) || v < 0)) {
          return res.status(400).json({ error: `${f} must be non-negative integer or null` });
        }
      }
      sets.push(`${f} = $${p++}`);
      values.push(v);
    }
    if (!sets.length) return res.status(400).json({ error: 'no updatable fields supplied' });
    sets.push('updated_at = NOW()');
    values.push(id);
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

// DELETE /api/assets/:id — only manual assets are deletable; RMM-
// managed ones should disappear via their source's lifecycle. Tickets
// linked to a deleted asset get asset_id = NULL (FK ON DELETE SET NULL).
router.delete('/:id(\\d+)', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const r = await pool.query(`SELECT source_system FROM assets WHERE id = $1`, [id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    if (r.rows[0].source_system !== 'manual') {
      return res.status(400).json({ error: 'Only manual assets can be deleted directly' });
    }
    await pool.query(`DELETE FROM assets WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('asset delete error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/assets/export.csv — current inventory as CSV. Honors the
// same q + project_id + offline_days filters as the list endpoint.
function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
router.get('/export.csv', requireAuth, requireRole('Admin', 'Manager', 'Tech'), async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const offlineRaw = Number(req.query.offline_days);
    const offlineDays = Number.isFinite(offlineRaw) && offlineRaw > 0 ? Math.floor(offlineRaw) : null;
    const params = [];
    const conds = [];
    if (offlineDays) {
      params.push(offlineDays);
      conds.push(`(a.last_seen_at IS NULL OR a.last_seen_at < NOW() - ($${params.length} || ' days')::interval)`);
    }
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      conds.push(`(LOWER(a.hostname) LIKE $${params.length} OR LOWER(a.serial) LIKE $${params.length} OR LOWER(a.organization) LIKE $${params.length} OR LOWER(a.model) LIKE $${params.length})`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await pool.query(
      `SELECT a.id, a.hostname, at.label AS type, a.manufacturer, a.model,
              a.serial, a.os, a.os_version, a.cpu, a.ram_bytes, a.storage_bytes,
              a.mac, a.ip_address, a.organization, c.name AS company,
              u.display_name AS linked_user, u.email AS linked_user_email,
              a.missing_updates_critical, a.missing_updates_other,
              a.vulnerabilities_critical, a.vulnerabilities_other,
              a.update_status, a.reboot_required, a.source_system,
              a.last_seen_at, a.last_software_sync_at
         FROM assets a
         LEFT JOIN asset_types at ON at.id = a.asset_type_id
         LEFT JOIN companies c ON c.id = a.company_id
         LEFT JOIN users u ON u.id = a.linked_user_id
         ${where}
         ORDER BY a.last_seen_at DESC NULLS LAST, a.hostname`,
      params
    );
    const cols = [
      'id', 'hostname', 'type', 'manufacturer', 'model',
      'serial', 'os', 'os_version', 'cpu', 'ram_bytes', 'storage_bytes',
      'mac', 'ip_address', 'organization', 'company',
      'linked_user', 'linked_user_email',
      'missing_updates_critical', 'missing_updates_other',
      'vulnerabilities_critical', 'vulnerabilities_other',
      'update_status', 'reboot_required', 'source_system',
      'last_seen_at', 'last_software_sync_at',
    ];
    const lines = [cols.join(',')];
    for (const row of r.rows) {
      lines.push(cols.map((c) => csvEscape(row[c])).join(','));
    }
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="inventory-${stamp}.csv"`);
    res.send(lines.join('\n'));
  } catch (err) {
    console.error('asset csv export error:', err);
    res.status(500).json({ error: 'Export failed' });
  }
});

// GET /api/assets/:id/software — installed software for the asset.
// Supports ?q= text filter on name / vendor for the typeahead.
// Returns canonical_name + canonical_vendor + last_alias_id so the UI
// can show "Adobe Acrobat (was: Adobe Acrobat Pro DC 64-bit)" and link
// the alias rule that won the match.
router.get('/:id(\\d+)/software', requireAuth, requireRole('Admin', 'Manager', 'Tech'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const q = (req.query.q || '').trim().toLowerCase();
    const params = [id];
    let where = `WHERE s.asset_id = $1`;
    if (q) {
      params.push(`%${q}%`);
      where += ` AND (LOWER(s.name) LIKE $2 OR LOWER(COALESCE(s.vendor,'')) LIKE $2 OR LOWER(COALESCE(s.canonical_name,'')) LIKE $2)`;
    }
    const r = await pool.query(
      `SELECT s.id, s.name, s.version, s.vendor, s.install_date, s.size_bytes,
              s.canonical_name, s.canonical_vendor, s.last_alias_id,
              s.raw, s.updated_at,
              a.pattern AS alias_pattern
         FROM asset_software s
         LEFT JOIN software_aliases a ON a.id = s.last_alias_id
         ${where}
         ORDER BY LOWER(COALESCE(s.canonical_name, s.name)), s.version
         LIMIT 1000`,
      params
    );
    res.json({ items: r.rows, total: r.rows.length });
  } catch (err) {
    console.error('asset software list error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/assets/:id/tickets — tickets linked to this asset across all
// projects. Admin / Manager see every row; others are scoped to
// projects they're members of. Useful for the asset detail page's
// "what tickets touched this machine" panel.
router.get('/:id(\\d+)/tickets', requireAuth, requireRole('Admin', 'Manager', 'Tech'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const user = req.session.user;
    const isPriv = user.role === 'Admin' || user.role === 'Manager';
    const params = [id];
    let projectFilter = '';
    if (!isPriv) {
      params.push(user.id);
      projectFilter = `AND EXISTS (
        SELECT 1 FROM project_members pm
         WHERE pm.project_id = t.project_id AND pm.user_id = $2
      )`;
    }
    const r = await pool.query(
      `SELECT t.id, t.internal_ref, t.title, t.title_enc,
              t.internal_status, t.effective_priority, t.project_id,
              p.name AS project_name, p.prefix AS project_prefix,
              t.created_at, t.updated_at, t.resolved_at
         FROM tickets t
         LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.asset_id = $1 ${projectFilter}
        ORDER BY
          CASE WHEN t.resolved_at IS NULL THEN 0 ELSE 1 END,
          t.created_at DESC
        LIMIT 200`,
      params
    );
    // Decrypt titles under standard mode.
    const { decryptRows } = require('../services/fields');
    await decryptRows('tickets', r.rows);
    res.json(r.rows);
  } catch (err) {
    console.error('asset tickets list error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/assets/:id/vulnerabilities — placeholder for Phase 5
// per-CVE data. Today returns the count columns the assets table
// already carries; future vendors that ship per-CVE rows will
// populate an asset_vulnerabilities table the UI is already reading.
router.get('/:id(\\d+)/vulnerabilities', requireAuth, requireRole('Admin', 'Manager', 'Tech'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const a = await pool.query(
      `SELECT vulnerabilities_critical, vulnerabilities_other,
              missing_updates_critical, missing_updates_other,
              update_status, vulnerability_status, reboot_required
         FROM assets WHERE id = $1`,
      [id]
    );
    if (!a.rows[0]) return res.status(404).json({ error: 'not found' });
    // Phase 5 will populate this from asset_vulnerabilities. For now
    // empty list — UI degrades to count-only view.
    res.json({
      summary: a.rows[0],
      items: [],
    });
  } catch (err) {
    console.error('asset vulnerabilities error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/assets/:id/sync-software — on-demand pull from the asset's
// upstream RMM source.
router.post('/:id(\\d+)/sync-software', requireAuth, requireRole('Admin', 'Manager', 'Tech'), async (req, res) => {
  try {
    const { syncSoftwareForAsset } = require('../services/action1Software');
    const result = await syncSoftwareForAsset(Number(req.params.id));
    res.json(result);
  } catch (err) {
    console.error('asset software sync error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// POST /api/assets/:id/print-label — render + send an asset label to
// the configured Zebra. QR payload is `asset:<id>` so a scanner can
// deep-link back to the inventory row.
router.post('/:id(\\d+)/print-label', requireAuth, requireRole('Admin', 'Manager', 'Tech'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, hostname, serial, model, manufacturer FROM assets WHERE id = $1`,
      [Number(req.params.id)]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Asset not found' });
    const labelPrinter = require('../services/labelPrinter');
    const labelTemplates = require('../services/labelTemplates');
    const cfg = await labelPrinter.getConfig();
    if (!cfg?.enabled) return res.status(400).json({ error: 'Label printer disabled' });
    if (!cfg.host) return res.status(400).json({ error: 'Label printer host not configured' });
    const zpl = labelTemplates.renderAssetLabel({ asset: r.rows[0] }, cfg);
    await labelPrinter.print(zpl);
    res.json({ ok: true });
  } catch (err) {
    console.error('asset print-label:', err);
    res.status(500).json({ error: err.message || 'Print failed' });
  }
});

module.exports = router;

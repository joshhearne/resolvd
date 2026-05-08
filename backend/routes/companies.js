// Multi-modal company CRUD.
//   kind='vendor'   — external escalation party. project_id required;
//                     project must have has_external_vendor=TRUE.
//   kind='customer' — external party we serve (MSP mode). project_id may
//                     be NULL; multi-project linkage via company_projects.
//   kind='internal' — own org unit (Internal IT, DevOps, dept). No
//                     project_id; tracks members + locations.
// Names/notes encrypt under standard mode; domain stays plaintext for
// sender-domain matching on inbound email.

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { buildWritePatch, decryptRow, decryptRows } = require('../services/fields');

const router = express.Router();

const VALID_KINDS = new Set(['vendor', 'customer', 'internal']);

function normalizeDomain(domain) {
  if (!domain) return null;
  const d = String(domain).trim().toLowerCase();
  if (!d) return null;
  return d.replace(/^@/, '').replace(/^https?:\/\//, '').split('/')[0];
}

// GET /api/companies?kind=vendor|customer|internal&project_id=...&include_archived=1
router.get('/', requireAuth, async (req, res) => {
  try {
    const { project_id, include_archived, kind } = req.query;
    const params = [];
    const where = ['1=1'];
    if (project_id) {
      // Vendors live on companies.project_id; customers via company_projects.
      // Match either side for the same query.
      params.push(Number(project_id));
      where.push(`(c.project_id = $${params.length} OR EXISTS (
        SELECT 1 FROM company_projects cp
         WHERE cp.company_id = c.id AND cp.project_id = $${params.length}))`);
    }
    if (kind) {
      if (!VALID_KINDS.has(kind)) return res.status(400).json({ error: 'invalid kind' });
      params.push(kind);
      where.push(`c.kind = $${params.length}`);
    }
    if (include_archived !== '1') where.push('c.is_archived = FALSE');
    const result = await pool.query(`
      SELECT c.*, p.name AS project_name,
        (SELECT COUNT(*)::int FROM contacts WHERE company_id = c.id AND is_active = TRUE) AS active_contact_count,
        (SELECT COUNT(*)::int FROM company_members WHERE company_id = c.id) AS member_count,
        (SELECT COUNT(*)::int FROM locations WHERE company_id = c.id AND is_archived = FALSE) AS location_count
      FROM companies c
      LEFT JOIN projects p ON c.project_id = p.id
      WHERE ${where.join(' AND ')}
      ORDER BY c.name ASC, c.created_at DESC
    `, params);
    await decryptRows('companies', result.rows);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/companies
router.post('/', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const { kind = 'vendor', project_id, name, domain, notes } = req.body || {};
    if (!VALID_KINDS.has(kind)) return res.status(400).json({ error: 'invalid kind' });
    if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });

    let resolvedProjectId = null;
    if (kind === 'vendor') {
      if (!project_id) return res.status(400).json({ error: 'project_id required for vendor companies' });
      const proj = await pool.query(
        `SELECT id, has_external_vendor FROM projects WHERE id = $1 AND status = 'active'`,
        [Number(project_id)]
      );
      if (!proj.rows[0]) return res.status(404).json({ error: 'Project not found or archived' });
      if (!proj.rows[0].has_external_vendor) {
        return res.status(400).json({ error: 'Project is not configured with an external vendor' });
      }
      resolvedProjectId = Number(project_id);
    } else if (project_id) {
      // Customer/internal: project_id optional. If supplied, validate.
      const proj = await pool.query(
        `SELECT id FROM projects WHERE id = $1 AND status = 'active'`,
        [Number(project_id)]
      );
      if (!proj.rows[0]) return res.status(404).json({ error: 'Project not found or archived' });
      resolvedProjectId = Number(project_id);
    }

    const patch = await buildWritePatch(pool, 'companies', {
      name: name.trim(),
      notes: notes || null,
    });
    const cols = ['kind', 'project_id', 'domain', 'created_by_user_id', ...patch.cols];
    const values = [kind, resolvedProjectId, normalizeDomain(domain), req.session.user.id, ...patch.values];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const result = await pool.query(
      `INSERT INTO companies (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
      values
    );
    const row = result.rows[0];
    await decryptRow('companies', row);
    res.status(201).json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/companies/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*, p.name AS project_name
      FROM companies c
      LEFT JOIN projects p ON c.project_id = p.id
      WHERE c.id = $1
    `, [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    await decryptRow('companies', result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/companies/:id
router.patch('/:id', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const existing = await pool.query(`SELECT * FROM companies WHERE id = $1`, [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Not found' });

    const body = req.body || {};
    const sensitiveObj = {};
    const passthrough = { updated_at: new Date().toISOString() };

    if (body.name !== undefined) {
      if (!body.name || !body.name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
      sensitiveObj.name = body.name.trim();
    }
    if (body.notes !== undefined) sensitiveObj.notes = body.notes || null;
    if (body.domain !== undefined) passthrough.domain = normalizeDomain(body.domain);
    if (body.is_archived !== undefined) passthrough.is_archived = !!body.is_archived;
    if (body.kind !== undefined) {
      if (!VALID_KINDS.has(body.kind)) return res.status(400).json({ error: 'invalid kind' });
      passthrough.kind = body.kind;
    }
    if (body.project_id !== undefined) {
      passthrough.project_id = body.project_id ? Number(body.project_id) : null;
    }
    if (body.notification_prefs !== undefined && typeof body.notification_prefs === 'object' && !Array.isArray(body.notification_prefs)) {
      passthrough.notification_prefs = JSON.stringify(body.notification_prefs);
    }
    if (body.auto_add_domains !== undefined) {
      const list = Array.isArray(body.auto_add_domains)
        ? body.auto_add_domains
            .map((d) => String(d || '').trim().toLowerCase().replace(/^@/, '').replace(/^https?:\/\//, '').split('/')[0])
            .filter(Boolean)
        : null;
      passthrough.auto_add_domains = list && list.length ? list : null;
    }

    const patch = await buildWritePatch(pool, 'companies', sensitiveObj);
    const cols = [...Object.keys(passthrough), ...patch.cols];
    const values = [...Object.values(passthrough), ...patch.values];
    if (cols.length === 0) return res.json(existing.rows[0]);
    const setClauses = cols.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const result = await pool.query(
      `UPDATE companies SET ${setClauses} WHERE id = $${cols.length + 1} RETURNING *`,
      [...values, req.params.id]
    );

    // When auto_add_domains was touched on an internal company, retroactively
    // sweep existing active users whose email domain now matches and insert
    // membership rows. Idempotent on conflict.
    if (
      Object.prototype.hasOwnProperty.call(passthrough, 'auto_add_domains') &&
      result.rows[0].kind === 'internal' &&
      Array.isArray(result.rows[0].auto_add_domains) &&
      result.rows[0].auto_add_domains.length
    ) {
      await pool.query(
        `INSERT INTO company_members (company_id, user_id)
         SELECT $1, u.id FROM users u
          WHERE u.status = 'active'
            AND lower(split_part(u.email, '@', 2)) = ANY($2)
         ON CONFLICT (company_id, user_id) DO NOTHING`,
        [result.rows[0].id, result.rows[0].auto_add_domains]
      );
    }

    await decryptRow('companies', result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/companies/:id — admin hard-delete (cascades contacts, members, locations, ticket_contacts)
router.delete('/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM companies WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Locations ─────────────────────────────────────────────────────────

router.get('/:id/locations', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM locations WHERE company_id = $1
         ORDER BY is_primary DESC, name ASC`,
      [Number(req.params.id)]
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.post('/:id/locations', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const { name, location_code, address, timezone, phone, use_extensions, is_primary } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
    const company = await pool.query(`SELECT id FROM companies WHERE id = $1`, [Number(req.params.id)]);
    if (!company.rows[0]) return res.status(404).json({ error: 'Company not found' });

    // If marking primary, demote any existing primary on this company.
    if (is_primary) {
      await pool.query(
        `UPDATE locations SET is_primary = FALSE WHERE company_id = $1 AND is_primary = TRUE`,
        [Number(req.params.id)]
      );
    }
    const r = await pool.query(
      `INSERT INTO locations
         (company_id, name, location_code, address, timezone, phone, use_extensions, is_primary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        Number(req.params.id),
        name.trim(),
        (location_code || '').trim() || null,
        (address || '').trim() || null,
        (timezone || '').trim() || null,
        (phone || '').trim() || null,
        !!use_extensions,
        !!is_primary,
      ]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.patch('/locations/:locationId', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const id = Number(req.params.locationId);
    const existing = await pool.query(`SELECT * FROM locations WHERE id = $1`, [id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Not found' });

    const body = req.body || {};
    const allowed = ['name', 'location_code', 'address', 'timezone', 'phone',
      'use_extensions', 'is_primary', 'is_archived'];
    const sets = [];
    const values = [];
    let p = 1;
    for (const k of allowed) {
      if (Object.prototype.hasOwnProperty.call(body, k)) {
        if (['use_extensions', 'is_primary', 'is_archived'].includes(k)) {
          sets.push(`${k} = $${p++}`);
          values.push(!!body[k]);
        } else {
          const v = (body[k] || '').toString().trim();
          sets.push(`${k} = $${p++}`);
          values.push(v || null);
        }
      }
    }
    if (!sets.length) return res.json(existing.rows[0]);

    if (body.is_primary === true) {
      // Demote siblings before promoting this one.
      await pool.query(
        `UPDATE locations SET is_primary = FALSE
          WHERE company_id = $1 AND id <> $2 AND is_primary = TRUE`,
        [existing.rows[0].company_id, id]
      );
    }

    sets.push(`updated_at = NOW()`);
    values.push(id);
    const r = await pool.query(
      `UPDATE locations SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`,
      values
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.delete('/locations/:locationId', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    // Soft-archive — contacts pointing here keep their location_id ref.
    const r = await pool.query(
      `UPDATE locations SET is_archived = TRUE, is_primary = FALSE, updated_at = NOW()
        WHERE id = $1 RETURNING id`,
      [Number(req.params.locationId)]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Members ────────────────────────────────────────────────────────────

router.get('/:id/members', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT cm.*, u.display_name, u.email, u.role,
              l.name AS location_name, l.location_code
         FROM company_members cm
         JOIN users u ON u.id = cm.user_id
         LEFT JOIN locations l ON l.id = cm.location_id
        WHERE cm.company_id = $1
        ORDER BY u.display_name ASC`,
      [Number(req.params.id)]
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.post('/:id/members', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const { user_id, location_id, role_label } = req.body || {};
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    const company = await pool.query(`SELECT id FROM companies WHERE id = $1`, [Number(req.params.id)]);
    if (!company.rows[0]) return res.status(404).json({ error: 'Company not found' });
    const u = await pool.query(`SELECT id FROM users WHERE id = $1 AND status = 'active'`, [Number(user_id)]);
    if (!u.rows[0]) return res.status(404).json({ error: 'User not found or inactive' });

    await pool.query(
      `INSERT INTO company_members (company_id, user_id, location_id, role_label, added_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (company_id, user_id)
       DO UPDATE SET location_id = EXCLUDED.location_id, role_label = EXCLUDED.role_label`,
      [
        Number(req.params.id),
        Number(user_id),
        location_id ? Number(location_id) : null,
        (role_label || '').trim() || null,
        req.session.user.id,
      ]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.delete('/:id/members/:userId', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM company_members WHERE company_id = $1 AND user_id = $2 RETURNING company_id`,
      [Number(req.params.id), Number(req.params.userId)]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Customer ↔ Project linkage ─────────────────────────────────────────

router.get('/:id/projects', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.id, p.name, p.prefix
         FROM company_projects cp
         JOIN projects p ON p.id = cp.project_id
        WHERE cp.company_id = $1
        ORDER BY p.name`,
      [Number(req.params.id)]
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.put('/:id/projects', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  // Replace the full set of linked projects in one shot. Body: { project_ids: [...] }
  try {
    const ids = Array.isArray(req.body?.project_ids)
      ? Array.from(new Set(req.body.project_ids.map(Number).filter((n) => Number.isFinite(n) && n > 0)))
      : [];
    const company = await pool.query(`SELECT id FROM companies WHERE id = $1`, [Number(req.params.id)]);
    if (!company.rows[0]) return res.status(404).json({ error: 'Company not found' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM company_projects WHERE company_id = $1`, [Number(req.params.id)]);
      for (const pid of ids) {
        await client.query(
          `INSERT INTO company_projects (company_id, project_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [Number(req.params.id), pid]
        );
      }
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }
    res.json({ ok: true, project_ids: ids });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

// Vendor company CRUD. Linked to a project (1 project → many companies);
// the project must have has_external_vendor=true. Names/notes encrypt
// under standard mode; domain stays plaintext for sender-domain matching
// on inbound email.

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { buildWritePatch, decryptRow, decryptRows } = require('../services/fields');

const router = express.Router();

function normalizeDomain(domain) {
  if (!domain) return null;
  const d = String(domain).trim().toLowerCase();
  if (!d) return null;
  // Strip leading "@" or scheme; keep apex.
  return d.replace(/^@/, '').replace(/^https?:\/\//, '').split('/')[0];
}

// GET /api/companies?project_id=...
router.get('/', requireAuth, async (req, res) => {
  try {
    const { project_id, include_archived } = req.query;
    const params = [];
    let where = `1=1`;
    if (project_id) {
      params.push(Number(project_id));
      where += ` AND project_id = $${params.length}`;
    }
    if (include_archived !== '1') where += ` AND is_archived = FALSE`;
    const result = await pool.query(`
      SELECT c.*, p.name AS project_name,
        (SELECT COUNT(*)::int FROM contacts WHERE company_id = c.id AND is_active = TRUE) AS active_contact_count
      FROM companies c
      LEFT JOIN projects p ON c.project_id = p.id
      WHERE ${where}
      ORDER BY c.created_at DESC
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
    const { project_id, name, domain, notes } = req.body || {};
    if (!project_id) return res.status(400).json({ error: 'project_id required' });
    if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });

    const proj = await pool.query(
      `SELECT id, has_external_vendor FROM projects WHERE id = $1 AND status = 'active'`,
      [Number(project_id)]
    );
    if (!proj.rows[0]) return res.status(404).json({ error: 'Project not found or archived' });
    if (!proj.rows[0].has_external_vendor) {
      return res.status(400).json({ error: 'Project is not configured with an external vendor' });
    }

    const patch = await buildWritePatch(pool, 'companies', {
      name: name.trim(),
      notes: notes || null,
    });
    const cols = ['project_id', 'domain', 'created_by_user_id', ...patch.cols];
    const values = [Number(project_id), normalizeDomain(domain), req.session.user.id, ...patch.values];
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
    if (body.notification_prefs !== undefined && typeof body.notification_prefs === 'object' && !Array.isArray(body.notification_prefs)) {
      passthrough.notification_prefs = JSON.stringify(body.notification_prefs);
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
    await decryptRow('companies', result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/companies/:id — admin hard-delete (cascades contacts + ticket_contacts)
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

module.exports = router;

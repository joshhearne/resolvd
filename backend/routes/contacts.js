// Vendor contact CRUD. Email is encrypted under standard mode and also
// HMAC'd into email_blind_idx for inbound-webhook lookup. Adding generic
// mailbox addresses (support@, helpdesk@, …) is rejected up front to
// prevent reply loops with the vendor's own helpdesk.

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { buildWritePatch, decryptRow, decryptRows } = require('../services/fields');
const { hashWhole } = require('../services/blindIndex');
const { checkContactEmail } = require('../services/genericMailbox');

const router = express.Router();

// GET /api/companies/:companyId/contacts
router.get('/companies/:companyId/contacts', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM contacts
       WHERE company_id = $1 AND is_active = TRUE
       ORDER BY created_at DESC
    `, [req.params.companyId]);
    await decryptRows('contacts', result.rows);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/companies/:companyId/contacts
router.post('/companies/:companyId/contacts',
  requireAuth, requireRole('Admin', 'Manager'),
  async (req, res) => {
    try {
      const company = await pool.query(`SELECT id FROM companies WHERE id = $1`, [req.params.companyId]);
      if (!company.rows[0]) return res.status(404).json({ error: 'Company not found' });

      const { name, email, phone, role_title, notes } = req.body || {};
      if (!email) return res.status(400).json({ error: 'email required' });
      const check = await checkContactEmail(email);
      if (!check.ok) return res.status(400).json({ error: check.message, code: check.code });

      const normalizedEmail = String(email).trim().toLowerCase();
      const blind = hashWhole(normalizedEmail);

      const patch = await buildWritePatch(pool, 'contacts', {
        name: (name || '').trim() || null,
        email: normalizedEmail,
        phone: phone || null,
        notes: notes || null,
      });
      const cols = ['company_id', 'email_blind_idx', 'role_title', 'created_by_user_id', ...patch.cols];
      const values = [Number(req.params.companyId), blind, role_title || null, req.session.user.id, ...patch.values];
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const result = await pool.query(
        `INSERT INTO contacts (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
        values
      );
      const row = result.rows[0];
      await decryptRow('contacts', row);
      res.status(201).json(row);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database error' });
    }
  }
);

// GET /api/contacts/:id
router.get('/contacts/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM contacts WHERE id = $1`, [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    await decryptRow('contacts', result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/contacts/:id
router.patch('/contacts/:id', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const existing = await pool.query(`SELECT * FROM contacts WHERE id = $1`, [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Not found' });

    const body = req.body || {};
    const sensitiveObj = {};
    const passthrough = { updated_at: new Date().toISOString() };

    if (body.name !== undefined) sensitiveObj.name = (body.name || '').trim() || null;
    if (body.phone !== undefined) sensitiveObj.phone = body.phone || null;
    if (body.notes !== undefined) sensitiveObj.notes = body.notes || null;
    if (body.role_title !== undefined) passthrough.role_title = body.role_title || null;
    if (body.is_active !== undefined) passthrough.is_active = !!body.is_active;

    if (body.email !== undefined) {
      const check = await checkContactEmail(body.email);
      if (!check.ok) return res.status(400).json({ error: check.message, code: check.code });
      const normalized = String(body.email).trim().toLowerCase();
      sensitiveObj.email = normalized;
      passthrough.email_blind_idx = hashWhole(normalized);
    }

    const patch = await buildWritePatch(pool, 'contacts', sensitiveObj);
    const cols = [...Object.keys(passthrough), ...patch.cols];
    const values = [...Object.values(passthrough), ...patch.values];
    if (cols.length === 1 && cols[0] === 'updated_at') return res.json(existing.rows[0]);
    const setClauses = cols.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const result = await pool.query(
      `UPDATE contacts SET ${setClauses} WHERE id = $${cols.length + 1} RETURNING *`,
      [...values, req.params.id]
    );
    await decryptRow('contacts', result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/contacts/:id — soft-delete by setting is_active=false; the
// row stays linked to historical tickets.
router.delete('/contacts/:id', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE contacts SET is_active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/contacts/lookup?email=... — admin tool for the inbound-match UI
// GET /api/projects/:projectId/contacts — all active contacts for a project,
// grouped with company info. Used by the new-ticket contact picker.
router.get('/projects/:projectId/contacts', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.id, c.name, c.name_enc, c.email, c.email_enc, c.role_title,
             co.id AS company_id, co.name AS company_name, co.name_enc AS company_name_enc
        FROM contacts c
        JOIN companies co ON co.id = c.company_id
       WHERE co.project_id = $1 AND c.is_active = TRUE AND co.is_archived = FALSE
       ORDER BY co.name, c.name
    `, [req.params.projectId]);
    await decryptRows('contacts', result.rows, { aliases: { company_name: 'companies.name' } });
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.get('/contacts-lookup', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'email required' });
    const blind = hashWhole(email);
    const result = await pool.query(
      `SELECT c.*, co.name AS company_name, co.id AS company_id
         FROM contacts c
         JOIN companies co ON co.id = c.company_id
        WHERE c.email_blind_idx = $1 AND c.is_active = TRUE
        LIMIT 5`,
      [blind]
    );
    await decryptRows('contacts', result.rows);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

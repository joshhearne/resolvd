// Admin-only routes for editing email templates and previewing the
// rendered output.

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const tpl = require('../services/emailTemplate');

const router = express.Router();

// GET /api/email-templates
router.get('/', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT t.*, u.display_name AS updated_by_name
        FROM email_templates t
        LEFT JOIN users u ON u.id = t.updated_by_user_id
       ORDER BY event_type ASC, audience ASC
    `);
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/email-templates/:event/:audience
router.get('/:event/:audience', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM email_templates WHERE event_type = $1 AND audience = $2`,
      [req.params.event, req.params.audience]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/email-templates/:id
router.patch('/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const allowed = ['subject_template', 'body_template', 'is_html', 'enabled', 'default_replies_count'];
    const body = req.body || {};
    const sets = [];
    const vals = [];
    for (const key of allowed) {
      if (body[key] !== undefined) {
        let v = body[key];
        if (key === 'default_replies_count') {
          v = Math.max(0, Math.min(parseInt(v, 10) || 0, tpl.REPLIES_HARD_CAP));
        }
        if (key === 'is_html' || key === 'enabled') v = !!v;
        if (key === 'subject_template' || key === 'body_template') {
          if (typeof v !== 'string' || !v.length) {
            return res.status(400).json({ error: `${key} must be a non-empty string` });
          }
        }
        vals.push(v);
        sets.push(`${key} = $${vals.length}`);
      }
    }
    if (sets.length === 0) return res.status(400).json({ error: 'No editable fields supplied' });
    vals.push(req.session.user.id);
    sets.push(`updated_by_user_id = $${vals.length}`);
    sets.push(`updated_at = NOW()`);
    vals.push(req.params.id);
    const result = await pool.query(
      `UPDATE email_templates SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/email-templates/:id/preview — render against sample or
// supplied ticket id (?ticket_id=...) so admins can sanity-check edits.
router.post('/:id/preview', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const t = await pool.query(`SELECT * FROM email_templates WHERE id = $1`, [req.params.id]);
    if (!t.rows[0]) return res.status(404).json({ error: 'Not found' });
    const template = t.rows[0];
    // Allow inline overrides so admins can preview unsaved edits.
    if (req.body?.subject_template) template.subject_template = String(req.body.subject_template);
    if (req.body?.body_template) template.body_template = String(req.body.body_template);
    if (req.body?.is_html !== undefined) template.is_html = !!req.body.is_html;

    let ctx = tpl.sampleContext();
    if (req.body?.ticket_id) {
      // Pull a real ticket but keep contact/company synthetic unless the
      // caller also supplies a contact_id.
      const { decryptRow } = require('../services/fields');
      const tk = await pool.query(`SELECT * FROM tickets WHERE id = $1`, [req.body.ticket_id]);
      if (tk.rows[0]) {
        await decryptRow('tickets', tk.rows[0]);
        ctx.ticket = { ...ctx.ticket, ...tk.rows[0] };
      }
    }
    const rendered = await tpl.render(template, ctx);
    res.json(rendered);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Render error: ' + err.message });
  }
});

module.exports = router;

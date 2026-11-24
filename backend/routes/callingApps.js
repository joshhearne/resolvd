// Calling apps for click-to-call (ticket Contacts tab).
//
//   GET    /api/calling-apps        enabled apps + the org default (any user)
//   GET    /api/calling-apps/all    every app, for the admin page (Admin)
//   POST   /api/calling-apps        add a custom app (Admin)
//   PATCH  /api/calling-apps/:id    edit / enable / make default (Admin)
//   DELETE /api/calling-apps/:id    remove a custom app (Admin)
//
// Templates: see db/schema.js (calling_apps). Links are only ever built
// in the browser from these templates; the server just stores them and
// refuses schemes that could run script.

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { numericId } = require('../middleware/params');

const router = express.Router();
router.use(requireAuth);

const BLOCKED_SCHEMES = new Set(['javascript', 'data', 'vbscript', 'file', 'about', 'blob', 'filesystem']);
const TEMPLATE_MAX = 500;
const COLS = 'id, key, name, url_template, ext_template, notes, enabled, is_default, ext_direct, sort_order';

// Returns an error message, or null when the template is acceptable.
function templateError(t, { needsExt = false } = {}) {
  if (typeof t !== 'string' || !t.trim()) return 'link is required';
  const v = t.trim();
  if (v.length > TEMPLATE_MAX) return `link must be at most ${TEMPLATE_MAX} characters`;
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(v);
  if (!m) return 'link must start with a scheme, like webextel:// or https://';
  if (BLOCKED_SCHEMES.has(m[1].toLowerCase())) return `${m[1]}: links aren't allowed`;
  if (/[\s<>"]/.test(v.replace(/\{(number|digits|ext)\}/g, ''))) return 'link must not contain spaces, quotes or angle brackets';
  if (needsExt && !v.includes('{ext}')) return 'the extension link must include {ext}';
  return null;
}

router.get('/', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${COLS} FROM calling_apps WHERE enabled ORDER BY sort_order, LOWER(name)`
    );
    const def = r.rows.find((a) => a.is_default) || r.rows.find((a) => a.key === 'phone') || r.rows[0] || null;
    res.json({ apps: r.rows, default_id: def ? def.id : null });
  } catch (err) {
    console.error('calling apps list:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.get('/all', requireRole('Admin'), async (req, res) => {
  try {
    const r = await pool.query(`SELECT ${COLS} FROM calling_apps ORDER BY sort_order, LOWER(name)`);
    res.json(r.rows);
  } catch (err) {
    console.error('calling apps all:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.post('/', requireRole('Admin'), async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: 'name is required' });
    const e1 = templateError(b.url_template);
    if (e1) return res.status(400).json({ error: e1 });
    let ext = null;
    if (b.ext_template) {
      const e2 = templateError(b.ext_template, { needsExt: true });
      if (e2) return res.status(400).json({ error: e2 });
      ext = b.ext_template.trim();
    }
    const r = await pool.query(
      `INSERT INTO calling_apps (name, url_template, ext_template, notes, enabled, ext_direct, sort_order)
       VALUES ($1, $2, $3, $4, TRUE, $5, 200) RETURNING ${COLS}`,
      [name, b.url_template.trim(), ext, String(b.notes || '').trim().slice(0, 300) || null, !!b.ext_direct]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error('calling app create:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.patch('/:id', numericId, requireRole('Admin'), async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const client = await pool.connect();
  try {
    const cur = (await client.query(`SELECT ${COLS} FROM calling_apps WHERE id = $1`, [id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'not found' });
    const sets = {};
    if (b.name !== undefined) {
      const name = String(b.name || '').trim().slice(0, 80);
      if (!name) return res.status(400).json({ error: 'name is required' });
      sets.name = name;
    }
    if (b.url_template !== undefined) {
      const e = templateError(b.url_template);
      if (e) return res.status(400).json({ error: e });
      sets.url_template = b.url_template.trim();
    }
    if (b.ext_template !== undefined) {
      if (!b.ext_template) sets.ext_template = null;
      else {
        const e = templateError(b.ext_template, { needsExt: true });
        if (e) return res.status(400).json({ error: e });
        sets.ext_template = b.ext_template.trim();
      }
    }
    if (b.notes !== undefined) sets.notes = String(b.notes || '').trim().slice(0, 300) || null;
    if (b.ext_direct !== undefined) sets.ext_direct = !!b.ext_direct;
    if (b.sort_order !== undefined && Number.isInteger(Number(b.sort_order))) sets.sort_order = Number(b.sort_order);
    const makeDefault = b.is_default === true;
    if (b.enabled !== undefined) {
      if (!b.enabled && (cur.is_default && !makeDefault)) {
        return res.status(400).json({ error: 'Pick another default before turning this one off' });
      }
      sets.enabled = !!b.enabled;
    }
    if (makeDefault && sets.enabled === false) return res.status(400).json({ error: 'The default app must be turned on' });

    await client.query('BEGIN');
    if (makeDefault && !cur.is_default) {
      await client.query(`UPDATE calling_apps SET is_default = FALSE WHERE is_default`);
      sets.is_default = true;
      sets.enabled = true;
    }
    const keys = Object.keys(sets);
    if (keys.length) {
      await client.query(
        `UPDATE calling_apps SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_at = NOW() WHERE id = $${keys.length + 1}`,
        [...Object.values(sets), id]
      );
    }
    await client.query('COMMIT');
    const r = await pool.query(`SELECT ${COLS} FROM calling_apps WHERE id = $1`, [id]);
    res.json(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('calling app update:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    client.release();
  }
});

router.delete('/:id', numericId, requireRole('Admin'), async (req, res) => {
  try {
    const cur = (await pool.query(`SELECT key, is_default FROM calling_apps WHERE id = $1`, [Number(req.params.id)])).rows[0];
    if (!cur) return res.status(404).json({ error: 'not found' });
    if (cur.key) return res.status(400).json({ error: "Built-in apps can't be removed; turn it off instead" });
    if (cur.is_default) return res.status(400).json({ error: 'Pick another default before removing this one' });
    await pool.query(`DELETE FROM calling_apps WHERE id = $1`, [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (err) {
    console.error('calling app delete:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
module.exports.templateError = templateError;

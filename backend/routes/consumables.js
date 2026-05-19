// Consumables — supply inventory (toner, drums, batteries, etc.).
// Distinct from durable assets so the navbar split makes sense and the
// movement ledger doesn't pollute /api/assets.
//
// Stock invariant: every adjustment goes through POST /:id/move which
// runs the row UPDATE and the consumable_movements INSERT in a single
// transaction. Direct PATCH on current_stock is rejected so the ledger
// stays authoritative.

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const HANDLER_ROLES = ['Admin', 'Manager', 'Tech'];

// GET /api/consumables — list (active by default; ?include_archived=1 to show all)
router.get('/', requireAuth, requireRole(...HANDLER_ROLES), async (req, res) => {
  try {
    const includeArchived = req.query.include_archived === '1';
    const q = req.query.q ? String(req.query.q).trim() : '';
    const params = [];
    const where = [];
    if (!includeArchived) where.push('c.is_archived = FALSE');
    if (q) {
      params.push(`%${q}%`);
      where.push(`(c.part_no ILIKE $${params.length} OR c.title ILIKE $${params.length} OR c.category ILIKE $${params.length})`);
    }
    const sql = `
      SELECT c.id, c.part_no, c.title, c.category, c.vendor_company_id,
             c.current_stock, c.low_stock_threshold, c.is_archived,
             c.created_at, c.updated_at,
             co.name AS vendor_company_name
        FROM consumables c
        LEFT JOIN companies co ON co.id = c.vendor_company_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY c.is_archived ASC, c.category NULLS LAST, c.part_no ASC`;
    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch (err) {
    console.error('consumables list:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/consumables/:id
router.get('/:id(\\d+)', requireAuth, requireRole(...HANDLER_ROLES), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.*, co.name AS vendor_company_name
         FROM consumables c
         LEFT JOIN companies co ON co.id = c.vendor_company_id
        WHERE c.id = $1`,
      [Number(req.params.id)]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('consumable get:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/consumables — create
router.post('/', requireAuth, requireRole(...HANDLER_ROLES), async (req, res) => {
  try {
    const b = req.body || {};
    const part_no = String(b.part_no || '').trim();
    if (!part_no) return res.status(400).json({ error: 'part_no required' });
    const r = await pool.query(
      `INSERT INTO consumables (part_no, title, category, vendor_company_id,
                                current_stock, low_stock_threshold, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        part_no,
        b.title ? String(b.title).trim() : null,
        b.category ? String(b.category).trim() : null,
        b.vendor_company_id != null ? Number(b.vendor_company_id) : null,
        Number.isFinite(Number(b.current_stock)) ? Math.max(0, Math.trunc(Number(b.current_stock))) : 0,
        Number.isFinite(Number(b.low_stock_threshold)) ? Math.max(0, Math.trunc(Number(b.low_stock_threshold))) : 0,
        b.notes ? String(b.notes).trim() : null,
      ]
    );
    res.status(201).json({ id: r.rows[0].id });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'part_no already exists' });
    console.error('consumable create:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/consumables/:id — metadata only (NOT current_stock; use /move).
router.patch('/:id(\\d+)', requireAuth, requireRole(...HANDLER_ROLES), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};
    if (Object.prototype.hasOwnProperty.call(b, 'current_stock')) {
      return res.status(400).json({ error: 'Use POST /:id/move to adjust stock' });
    }
    const fields = ['part_no', 'title', 'category', 'vendor_company_id', 'low_stock_threshold', 'notes', 'is_archived'];
    const sets = [];
    const values = [];
    let p = 1;
    for (const f of fields) {
      if (!Object.prototype.hasOwnProperty.call(b, f)) continue;
      let v = b[f];
      if (f === 'is_archived') v = !!v;
      else if (f === 'vendor_company_id') v = v == null ? null : Number(v);
      else if (f === 'low_stock_threshold') v = v == null ? 0 : Math.max(0, Math.trunc(Number(v)));
      else v = v == null ? null : (typeof v === 'string' ? v.trim() || null : v);
      sets.push(`${f} = $${p++}`);
      values.push(v);
    }
    if (!sets.length) return res.status(400).json({ error: 'no updatable fields supplied' });
    sets.push('updated_at = NOW()');
    values.push(id);
    const r = await pool.query(
      `UPDATE consumables SET ${sets.join(', ')} WHERE id = $${p} RETURNING id`,
      values
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'part_no already exists' });
    console.error('consumable patch:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/consumables/:id — Admin only. Hard delete cascades the
// ledger; admins who don't want that should archive via PATCH instead.
router.delete('/:id(\\d+)', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM consumables WHERE id = $1 RETURNING id`, [Number(req.params.id)]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('consumable delete:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/consumables/:id/move — atomic stock adjustment + ledger.
// Body: { delta (int, +/-), reason?, ticket_id?, note? }
// 400 if delta would push current_stock below 0.
router.post('/:id(\\d+)/move', requireAuth, requireRole(...HANDLER_ROLES), async (req, res) => {
  const id = Number(req.params.id);
  const { delta, reason, ticket_id, note } = req.body || {};
  const d = Number(delta);
  if (!Number.isInteger(d) || d === 0) return res.status(400).json({ error: 'delta must be a non-zero integer' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await client.query('SELECT current_stock FROM consumables WHERE id = $1 FOR UPDATE', [id]);
    if (!row.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
    const next = row.rows[0].current_stock + d;
    if (next < 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Insufficient stock' }); }
    await client.query('UPDATE consumables SET current_stock = $1, updated_at = NOW() WHERE id = $2', [next, id]);
    const ins = await client.query(
      `INSERT INTO consumable_movements (consumable_id, delta, reason, ticket_id, by_user_id, note)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, at`,
      [
        id, d,
        reason ? String(reason).trim().slice(0, 64) : null,
        ticket_id != null ? Number(ticket_id) : null,
        req.session.user.id,
        note ? String(note).trim() : null,
      ]
    );
    await client.query('COMMIT');
    res.status(201).json({ ok: true, movement_id: ins.rows[0].id, at: ins.rows[0].at, current_stock: next });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('consumable move:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    client.release();
  }
});

// GET /api/consumables/:id/movements — ledger, newest-first.
router.get('/:id(\\d+)/movements', requireAuth, requireRole(...HANDLER_ROLES), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT m.id, m.delta, m.reason, m.ticket_id, m.by_user_id, m.at, m.note,
              u.display_name AS by_user_name,
              t.internal_ref AS ticket_ref
         FROM consumable_movements m
         LEFT JOIN users u ON u.id = m.by_user_id
         LEFT JOIN tickets t ON t.id = m.ticket_id
        WHERE m.consumable_id = $1
        ORDER BY m.at DESC
        LIMIT 500`,
      [Number(req.params.id)]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('consumable movements:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/consumables/:id/print-label — render a delivery label for
// this consumable. Optional body: { ticket_id, requestor_name, location }.
// When ticket_id is supplied, the renderer fills the SR ref + submitter
// at print time; otherwise just the consumable info goes on the label.
router.post('/:id(\\d+)/print-label', requireAuth, requireRole(...HANDLER_ROLES), async (req, res) => {
  try {
    const cons = await pool.query(`SELECT * FROM consumables WHERE id = $1`, [Number(req.params.id)]);
    if (!cons.rows[0]) return res.status(404).json({ error: 'not found' });
    const labelPrinter = require('../services/labelPrinter');
    const labelTemplates = require('../services/labelTemplates');
    const cfg = await labelPrinter.getConfig();
    if (!cfg?.enabled) return res.status(400).json({ error: 'Label printer disabled' });
    if (!cfg.host) return res.status(400).json({ error: 'Label printer host not configured' });

    const b = req.body || {};
    let ticket = null;
    if (b.ticket_id) {
      const t = await pool.query(
        `SELECT id, internal_ref FROM tickets WHERE id = $1`,
        [Number(b.ticket_id)]
      );
      if (t.rows[0]) ticket = t.rows[0];
    }

    const zpl = labelTemplates.renderConsumableLabel({
      ticket: ticket || { id: cons.rows[0].id, internal_ref: cons.rows[0].part_no },
      requestor: b.requestor_name ? String(b.requestor_name).trim() : '',
      location: b.location ? String(b.location).trim() : '',
      consumable: {
        part_number: cons.rows[0].part_no,
        title: cons.rows[0].title,
      },
    }, cfg);
    await labelPrinter.print(zpl);
    res.json({ ok: true });
  } catch (err) {
    console.error('consumable print-label:', err);
    res.status(500).json({ error: err.message || 'Print failed' });
  }
});

module.exports = router;

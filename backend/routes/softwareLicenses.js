// Software license management (manual). Licenses, subscriptions and
// contracts the org owns, optionally tied to a title in the software
// inventory so seats in use can be counted from installs.
//
//   GET    /api/software-licenses              — list (Admin / Manager / Tech)
//          ?q=&company_id=|none&status=active|renewing|expired|over|archived&software_key=
//   GET    /api/software-licenses/:id          — one license (no key)
//   GET    /api/software-licenses/:id/key      — reveal the license key (Admin / Manager; audited)
//   POST   /api/software-licenses              — create (Admin / Manager)
//   PATCH  /api/software-licenses/:id          — update (Admin / Manager)
//   DELETE /api/software-licenses/:id          — delete (Admin)
//
// Seats in use = distinct assets with the linked title installed; for a
// license scoped to a company, only that company's assets count. It's an
// install count, so for per-user licenses it's a proxy, not a user count.
// The key is never sent in list / detail responses (has_key only).

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { numericId } = require('../middleware/params');
const { buildWritePatch, decryptRows } = require('../services/fields');
const { auditLog } = require('../services/ticketHelpers');

const router = express.Router();
router.use(requireAuth);

const VIEW = requireRole('Admin', 'Manager', 'Tech');
const EDIT = requireRole('Admin', 'Manager');

const TYPES = ['subscription', 'perpetual', 'per_device', 'per_user', 'site', 'other'];
const PERIODS = ['one_time', 'monthly', 'yearly'];
const RENEWING_DAYS = 30;
const KEY_SQL = `LOWER(COALESCE(NULLIF(s.canonical_name, ''), s.name))`;

// Columns every response carries. seats_used counts installs of the linked
// title (company-scoped when the license is). title_name is the inventory's
// display name for software_key, so a stale key is visible as "not found".
const SELECT = `
  SELECT l.id, l.name, l.software_key, l.vendor, l.license_type, l.seats, l.company_id,
         (l.license_key IS NOT NULL OR l.license_key_enc IS NOT NULL) AS has_key,
         l.notes, l.notes_enc,
         -- Calendar dates as plain strings: no time-zone shift on the way out.
         to_char(l.purchase_date, 'YYYY-MM-DD') AS purchase_date,
         to_char(l.renewal_date, 'YYYY-MM-DD') AS renewal_date,
         l.auto_renew, l.cost, l.cost_period, l.reference,
         l.archived, l.created_at, l.updated_at,
         CASE WHEN l.renewal_date IS NULL THEN NULL ELSE (l.renewal_date - CURRENT_DATE) END AS days_to_renewal,
         u.seats_used, u.title_name
    FROM software_licenses l
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT s.asset_id)::int AS seats_used,
             MODE() WITHIN GROUP (ORDER BY COALESCE(NULLIF(s.canonical_name, ''), s.name)) AS title_name
        FROM asset_software s
        JOIN assets a ON a.id = s.asset_id
       WHERE l.software_key IS NOT NULL
         AND ${KEY_SQL} = l.software_key
         AND (l.company_id IS NULL OR a.company_id = l.company_id)
    ) u ON TRUE`;

async function companyNames(rows) {
  const ids = [...new Set(rows.map((r) => r.company_id).filter(Boolean))];
  if (!ids.length) return {};
  const c = await pool.query('SELECT id, name, name_enc FROM companies WHERE id = ANY($1::int[])', [ids]);
  await decryptRows('companies', c.rows);
  return Object.fromEntries(c.rows.map((r) => [r.id, r.name]));
}

async function shape(rows) {
  await decryptRows('software_licenses', rows);
  const names = await companyNames(rows);
  return rows.map(({ notes_enc: _n, ...r }) => ({
    ...r,
    cost: r.cost == null ? null : Number(r.cost),
    company_name: r.company_id ? names[r.company_id] || null : null,
    seats_used: r.software_key ? r.seats_used || 0 : null,
    over_allocated: r.seats != null && r.software_key != null && (r.seats_used || 0) > r.seats,
  }));
}

// Validate a create / patch body into plain column values. `partial`
// allows missing fields (PATCH); returns { values } or { error }.
function parseBody(body, { partial }) {
  const v = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const str = (k, max) => {
    if (!has(k)) return;
    const x = body[k] == null ? '' : String(body[k]).trim();
    v[k] = x ? x.slice(0, max) : null;
  };
  const date = (k) => {
    if (!has(k)) return undefined;
    if (body[k] == null || body[k] === '') { v[k] = null; return undefined; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body[k])) || isNaN(Date.parse(body[k]))) return `${k} must be a date (YYYY-MM-DD)`;
    v[k] = String(body[k]);
    return undefined;
  };

  if (!partial || has('name')) {
    const name = String(body.name || '').trim();
    if (!name) return { error: 'name required' };
    v.name = name.slice(0, 200);
  }
  str('vendor', 200);
  str('reference', 200);
  str('license_key', 4000);
  str('notes', 10000);
  if (has('software_key')) {
    const k = body.software_key == null ? '' : String(body.software_key).trim().toLowerCase();
    v.software_key = k ? k.slice(0, 500) : null;
  }
  if (has('license_type')) {
    if (!TYPES.includes(body.license_type)) return { error: `license_type must be one of ${TYPES.join(', ')}` };
    v.license_type = body.license_type;
  }
  if (has('seats')) {
    if (body.seats == null || body.seats === '') v.seats = null;
    else {
      const n = Number(body.seats);
      if (!Number.isInteger(n) || n < 0 || n > 10_000_000) return { error: 'seats must be a whole number (blank = unlimited)' };
      v.seats = n;
    }
  }
  if (has('company_id')) {
    if (body.company_id == null || body.company_id === '') v.company_id = null;
    else {
      const n = Number(body.company_id);
      if (!Number.isInteger(n) || n <= 0) return { error: 'invalid company_id' };
      v.company_id = n;
    }
  }
  if (has('cost')) {
    if (body.cost == null || body.cost === '') v.cost = null;
    else {
      const n = Number(body.cost);
      if (!Number.isFinite(n) || n < 0 || n > 9_999_999_999) return { error: 'cost must be a positive amount' };
      v.cost = Math.round(n * 100) / 100;
    }
  }
  if (has('cost_period')) {
    if (body.cost_period == null || body.cost_period === '') v.cost_period = null;
    else if (!PERIODS.includes(body.cost_period)) return { error: `cost_period must be one of ${PERIODS.join(', ')}` };
    else v.cost_period = body.cost_period;
  }
  if (has('auto_renew')) v.auto_renew = !!body.auto_renew;
  if (has('archived')) v.archived = !!body.archived;
  for (const k of ['purchase_date', 'renewal_date']) {
    const e = date(k);
    if (e) return { error: e };
  }
  return { values: v };
}

async function companyExists(id) {
  if (id == null) return true;
  const r = await pool.query('SELECT 1 FROM companies WHERE id = $1', [id]);
  return r.rows.length > 0;
}

router.get('/', VIEW, async (req, res) => {
  try {
    const params = [];
    const conds = [];
    const status = String(req.query.status || 'active');
    if (status === 'archived') conds.push('l.archived');
    else conds.push('NOT l.archived');
    if (status === 'expired') conds.push('l.renewal_date < CURRENT_DATE');
    if (status === 'renewing') conds.push(`l.renewal_date BETWEEN CURRENT_DATE AND CURRENT_DATE + ${RENEWING_DAYS}`);
    if (status === 'over') conds.push('l.seats IS NOT NULL AND l.software_key IS NOT NULL AND COALESCE(u.seats_used, 0) > l.seats');
    const companyId = Number(req.query.company_id);
    if (Number.isInteger(companyId) && companyId > 0) {
      params.push(companyId);
      conds.push(`l.company_id = $${params.length}`);
    } else if (req.query.company_id === 'none') conds.push('l.company_id IS NULL');
    if (req.query.software_key) {
      params.push(String(req.query.software_key).toLowerCase());
      conds.push(`l.software_key = $${params.length}`);
    }
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q) {
      params.push(`%${q}%`);
      const p = `$${params.length}`;
      conds.push(`(LOWER(l.name) LIKE ${p} OR LOWER(COALESCE(l.vendor, '')) LIKE ${p}
                   OR LOWER(COALESCE(l.reference, '')) LIKE ${p} OR LOWER(COALESCE(l.software_key, '')) LIKE ${p})`);
    }
    const r = await pool.query(
      `${SELECT} WHERE ${conds.join(' AND ')}
        ORDER BY l.renewal_date ASC NULLS LAST, LOWER(l.name) ASC
        LIMIT 1000`,
      params
    );
    const items = await shape(r.rows);
    res.json({ items, total: items.length, renewing_days: RENEWING_DAYS });
  } catch (err) {
    console.error('software licenses list error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.get('/:id', numericId, VIEW, async (req, res) => {
  try {
    const r = await pool.query(`${SELECT} WHERE l.id = $1`, [Number(req.params.id)]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json((await shape(r.rows))[0]);
  } catch (err) {
    console.error('software license get error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.get('/:id/key', numericId, EDIT, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const r = await pool.query('SELECT id, name, license_key, license_key_enc FROM software_licenses WHERE id = $1', [id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    await decryptRows('software_licenses', r.rows);
    await auditLog(pool, { userId: req.session.user.id, action: 'license_key_viewed', note: `License #${id} (${r.rows[0].name})` });
    res.json({ license_key: r.rows[0].license_key || null });
  } catch (err) {
    console.error('software license key error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

async function writeAndReturn(client, sql, values) {
  const r = await client.query(sql, values);
  return r.rows[0]?.id;
}

router.post('/', EDIT, async (req, res) => {
  try {
    const { values, error } = parseBody(req.body || {}, { partial: false });
    if (error) return res.status(400).json({ error });
    if (!(await companyExists(values.company_id))) return res.status(400).json({ error: 'company not found' });
    const patch = await buildWritePatch(pool, 'software_licenses', { ...values, created_by: req.session.user.id });
    const ph = patch.cols.map((_, i) => `$${i + 1}`).join(', ');
    const id = await writeAndReturn(pool,
      `INSERT INTO software_licenses (${patch.cols.join(', ')}) VALUES (${ph}) RETURNING id`, patch.values);
    await auditLog(pool, { userId: req.session.user.id, action: 'license_created', note: `License #${id} (${values.name})` });
    const r = await pool.query(`${SELECT} WHERE l.id = $1`, [id]);
    res.status(201).json((await shape(r.rows))[0]);
  } catch (err) {
    console.error('software license create error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.patch('/:id', numericId, EDIT, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { values, error } = parseBody(req.body || {}, { partial: true });
    if (error) return res.status(400).json({ error });
    if (!Object.keys(values).length) return res.status(400).json({ error: 'nothing to update' });
    if (values.company_id !== undefined && !(await companyExists(values.company_id))) {
      return res.status(400).json({ error: 'company not found' });
    }
    const patch = await buildWritePatch(pool, 'software_licenses', values);
    const sets = patch.cols.map((c, i) => `${c} = $${i + 1}`);
    sets.push('updated_at = NOW()');
    const updated = await writeAndReturn(pool,
      `UPDATE software_licenses SET ${sets.join(', ')} WHERE id = $${patch.cols.length + 1} RETURNING id`,
      [...patch.values, id]);
    if (!updated) return res.status(404).json({ error: 'not found' });
    // Name the fields changed, never their values (keys / notes are sensitive).
    await auditLog(pool, { userId: req.session.user.id, action: 'license_updated', note: `License #${id}: ${Object.keys(values).join(', ')}` });
    const r = await pool.query(`${SELECT} WHERE l.id = $1`, [id]);
    res.json((await shape(r.rows))[0]);
  } catch (err) {
    console.error('software license update error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.delete('/:id', numericId, requireRole('Admin'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const r = await pool.query('DELETE FROM software_licenses WHERE id = $1 RETURNING name', [id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    await auditLog(pool, { userId: req.session.user.id, action: 'license_deleted', note: `License #${id} (${r.rows[0].name})` });
    res.json({ ok: true });
  } catch (err) {
    console.error('software license delete error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

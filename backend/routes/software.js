// Software inventory: every title installed across the asset fleet, built
// from the per-asset rows the RMM pulls (asset_software, filled by the
// Action1 / RMM software sync). Titles are grouped by their canonical name
// (software_aliases folds vendor spellings together), falling back to the
// raw name, so one product shows once however many builds are out there.
//
//   GET /api/software                — titles: installs, versions, companies
//       ?q=&company_id=&source=synced|manual|all&sort=name|installs|versions&dir=asc|desc&limit=&offset=
//   GET /api/software/installs?key=  — the assets one title is installed on
//       &company_id=&source=
//   GET /api/software/export.csv     — the title list as CSV (same filters)
//
// `key` is the grouping key: LOWER(COALESCE(canonical_name, name)).

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { decryptRows } = require('../services/fields');

const router = express.Router();
router.use(requireAuth, requireRole('Admin', 'Manager', 'Tech'));

const KEY_SQL = `LOWER(COALESCE(NULLIF(s.canonical_name, ''), s.name))`;
const NAME_SQL = `COALESCE(NULLIF(s.canonical_name, ''), s.name)`;
const VENDOR_SQL = `COALESCE(NULLIF(s.canonical_vendor, ''), NULLIF(s.vendor, ''))`;

const SORTS = {
  name: 'LOWER(name)',
  installs: 'installs',
  versions: 'version_count',
};

// Shared WHERE for the filters every endpoint takes.
function filters(query, params) {
  const conds = [];
  const companyId = Number(query.company_id);
  if (Number.isInteger(companyId) && companyId > 0) {
    params.push(companyId);
    conds.push(`a.company_id = $${params.length}`);
  } else if (query.company_id === 'none') {
    conds.push('a.company_id IS NULL');
  }
  if (query.source === 'manual') conds.push(`a.source_system = 'manual'`);
  else if (query.source === 'synced') conds.push(`a.source_system <> 'manual'`);
  return conds;
}

function titleQuery(query, { paged = true } = {}) {
  const params = [];
  const conds = filters(query, params);
  const q = String(query.q || '').trim().toLowerCase();
  if (q) {
    params.push(`%${q}%`);
    const p = `$${params.length}`;
    conds.push(`(LOWER(s.name) LIKE ${p} OR LOWER(COALESCE(s.canonical_name, '')) LIKE ${p}
                 OR LOWER(COALESCE(s.vendor, '')) LIKE ${p} OR LOWER(COALESCE(s.canonical_vendor, '')) LIKE ${p})`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const sortCol = SORTS[query.sort] || SORTS.name;
  const dir = query.dir === 'desc' ? 'DESC' : 'ASC';
  let page = '';
  if (paged) {
    const limit = Math.max(1, Math.min(500, Number(query.limit) || 100));
    const offset = Math.max(0, Number(query.offset) || 0);
    params.push(limit, offset);
    page = `LIMIT $${params.length - 1} OFFSET $${params.length}`;
  }
  // One row per title. Display name / vendor: the most common spelling in
  // the group. Versions: distinct, newest-seen first, capped for the list.
  const sql = `
    WITH rows AS (
      SELECT ${KEY_SQL} AS key, ${NAME_SQL} AS name, ${VENDOR_SQL} AS vendor,
             s.version, s.asset_id, s.updated_at, a.company_id
        FROM asset_software s
        JOIN assets a ON a.id = s.asset_id
        ${where}
    ), titles AS (
      SELECT key,
             MODE() WITHIN GROUP (ORDER BY name) AS name,
             MODE() WITHIN GROUP (ORDER BY vendor) AS vendor,
             COUNT(DISTINCT asset_id)::int AS installs,
             COUNT(DISTINCT version)::int AS version_count,
             COUNT(DISTINCT company_id)::int AS company_count,
             (ARRAY_AGG(DISTINCT version) FILTER (WHERE version IS NOT NULL AND version <> ''))[1:25] AS versions,
             MAX(updated_at) AS last_seen_at
        FROM rows
       GROUP BY key
    )
    SELECT *, COUNT(*) OVER()::int AS total
      FROM titles
     ORDER BY ${sortCol} ${dir}, LOWER(name) ASC
     ${page}`;
  return { sql, params };
}

router.get('/', async (req, res) => {
  try {
    const { sql, params } = titleQuery(req.query);
    const r = await pool.query(sql, params);
    const total = r.rows[0]?.total || 0;
    res.json({ items: r.rows.map(({ total: _t, ...row }) => row), total });
  } catch (err) {
    console.error('software list error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.get('/installs', async (req, res) => {
  try {
    const key = String(req.query.key || '').trim().toLowerCase();
    if (!key) return res.status(400).json({ error: 'key required' });
    const params = [key];
    const conds = [`${KEY_SQL} = $1`, ...filters(req.query, params)];
    const r = await pool.query(
      `SELECT a.id AS asset_id, a.hostname, a.serial, a.source_system, a.last_seen_at,
              a.company_id,
              s.name AS raw_name, s.version, ${VENDOR_SQL} AS vendor, s.install_date, s.updated_at
         FROM asset_software s
         JOIN assets a ON a.id = s.asset_id
        WHERE ${conds.join(' AND ')}
        ORDER BY LOWER(COALESCE(a.hostname, '')), s.version
        LIMIT 2000`,
      params
    );
    // Company names can be encrypted at rest: read them through decryptRows.
    const companyIds = [...new Set(r.rows.map((x) => x.company_id).filter(Boolean))];
    const names = {};
    if (companyIds.length) {
      const c = await pool.query('SELECT id, name, name_enc FROM companies WHERE id = ANY($1::int[])', [companyIds]);
      await decryptRows('companies', c.rows);
      for (const row of c.rows) names[row.id] = row.name;
    }
    const items = r.rows.map((x) => ({ ...x, company_name: x.company_id ? names[x.company_id] || null : null }));
    res.json({ items, total: items.length });
  } catch (err) {
    console.error('software installs error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

function csvCell(v) {
  if (v == null) return '';
  const s = Array.isArray(v) ? v.join('; ') : v instanceof Date ? v.toISOString() : String(v);
  // Quote, and defuse spreadsheet formulas (=, +, -, @ at the start).
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

router.get('/export.csv', async (req, res) => {
  try {
    const { sql, params } = titleQuery(req.query, { paged: false });
    const r = await pool.query(sql, params);
    const head = ['Software', 'Vendor', 'Installs', 'Versions', 'Companies', 'Version list', 'Last seen'];
    const lines = [head.map(csvCell).join(',')];
    for (const t of r.rows) {
      lines.push([t.name, t.vendor, t.installs, t.version_count, t.company_count, t.versions, t.last_seen_at].map(csvCell).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="software-inventory.csv"');
    res.send(lines.join('\r\n') + '\r\n');
  } catch (err) {
    console.error('software export error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

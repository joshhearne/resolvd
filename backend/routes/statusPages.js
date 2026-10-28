// Status pages: admin-curated views over monitored items (Uptime Kuma
// monitors and any other source that tracks items). Every logged-in
// user can read them; Admin / Manager curate.
//
// A page shows each item's live state (maintenance when a Resolvd
// maintenance window covers it), uptime and response time, the
// alert-driven incidents for those items, and the maintenance windows
// touching them.

const express = require('express');
const { pool, transaction } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { decryptRows } = require('../services/fields');
const { rollupServiceState } = require('../services/monitoredItems');

const router = express.Router();
router.use(requireAuth);

const CURATORS = ['Admin', 'Manager'];
const HISTORY_DAYS = 14;
const UPCOMING_DAYS = 30;

function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'status';
}

async function uniqueSlug(client, base, exceptId) {
  let slug = base;
  for (let n = 2; ; n += 1) {
    const r = await client.query(
      `SELECT 1 FROM status_pages WHERE slug = $1 AND ($2::int IS NULL OR id <> $2)`,
      [slug, exceptId || null]
    );
    if (!r.rows[0]) return slug;
    slug = `${base}-${n}`;
  }
}

// Effective state for display: an active Resolvd maintenance window
// on the item or its parent service wins, then the polled / webhook
// state.
const EFFECTIVE_STATE_SQL = `
  CASE
    WHEN EXISTS (
      SELECT 1 FROM maintenance_window_items mi
        JOIN maintenance_windows w ON w.id = mi.window_id
       WHERE (mi.item_id = i.id OR mi.item_id = i.parent_item_id)
         AND w.starts_at <= NOW() AND w.ends_at > NOW()
    ) THEN 'maintenance'
    ELSE COALESCE(i.last_state, 'unknown')
  END`;

const ITEM_COLS = `
  i.id AS item_id, i.label, i.detail, i.item_type, i.active, i.is_primary,
  i.parent_item_id, i.uptime_1d, i.uptime_30d, i.response_ms, i.cert_days,
  i.polled_at, i.state_since, i.last_seen_at,
  ${EFFECTIVE_STATE_SQL} AS state`;

// Page items for the given pages, with service components attached
// and service state rolled up from them.
async function loadPageItems(pageIds) {
  const items = await pool.query(`
    SELECT spi.page_id, spi.id AS page_item_id, spi.section, spi.display_name, spi.sort_order,
           ${ITEM_COLS}
      FROM status_page_items spi
      JOIN alert_monitored_items i ON i.id = spi.item_id
     WHERE spi.page_id = ANY($1::int[])
     ORDER BY spi.sort_order ASC, COALESCE(spi.display_name, i.label) ASC
  `, [pageIds]);
  const parentIds = [...new Set(items.rows.map((r) => r.item_id))];
  const kids = await pool.query(`
    SELECT ${ITEM_COLS}
      FROM alert_monitored_items i
     WHERE i.parent_item_id = ANY($1::int[]) AND i.active
     ORDER BY i.is_primary DESC, i.label ASC
  `, [parentIds]);
  const byParent = new Map();
  for (const k of kids.rows) {
    if (!byParent.has(k.parent_item_id)) byParent.set(k.parent_item_id, []);
    byParent.get(k.parent_item_id).push(k);
  }
  for (const it of items.rows) {
    it.components = byParent.get(it.item_id) || [];
    if (it.components.length) it.state = rollupServiceState(it.components, it.state);
  }
  return items.rows;
}

// GET /api/status-pages — pages with a down/maintenance summary.
router.get('/', async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, slug, description, sort_order FROM status_pages
        ORDER BY sort_order ASC, name ASC`
    );
    const items = await loadPageItems(r.rows.map((p) => p.id));
    for (const page of r.rows) {
      const mine = items.filter((i) => i.page_id === page.id);
      page.item_count = mine.length;
      page.down_count = mine.filter((i) => i.state === 'down').length;
      page.partial_count = mine.filter((i) => i.state === 'partial').length;
      page.maintenance_count = mine.filter((i) => i.state === 'maintenance').length;
    }
    res.json(r.rows);
  } catch (err) {
    console.error('status pages list:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/status-pages/_meta/items — every monitored item, for the
// page editor and the maintenance item picker.
router.get('/_meta/items', requireRole('Admin', 'Manager', 'Tech'), async (_req, res) => {
  try {
    const r = await pool.query(`
      SELECT i.id, i.label, i.detail, i.item_type, i.last_state, i.active,
             i.parent_item_id, i.is_primary,
             s.id AS source_id, s.name AS source_name
        FROM alert_monitored_items i
        JOIN external_alert_source s ON s.id = i.source_id
       ORDER BY s.name ASC, i.label ASC NULLS LAST
    `);
    res.json(r.rows);
  } catch (err) {
    console.error('status items meta:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/status-pages/:slug — full page.
router.get('/:slug', async (req, res) => {
  try {
    const p = await pool.query(`SELECT * FROM status_pages WHERE slug = $1`, [req.params.slug]);
    const page = p.rows[0];
    if (!page) return res.status(404).json({ error: 'Status page not found' });

    const items = await loadPageItems([page.id]);
    // Incidents and maintenance cover service components too.
    const itemIds = [...new Set(items.flatMap((r) => [r.item_id, ...r.components.map((c) => c.item_id)]))];

    // Incidents = alerts on the page's items. Active: anything still
    // firing / acknowledged. History: recovered alerts that became a
    // ticket (flaps that self-healed inside the rule delay are noise).
    const inc = await pool.query(`
      SELECT a.id, a.state, a.title, a.title_enc, a.first_seen_at, a.recovered_at,
             a.suppression_reason, a.ticket_id,
             t.internal_ref AS ticket_ref, t.internal_status AS ticket_status,
             i.id AS item_id
        FROM alerts a
        JOIN alert_monitored_items i ON i.source_id = a.source_id AND i.item_key = a.item_key
        LEFT JOIN tickets t ON t.id = a.ticket_id
       WHERE i.id = ANY($1::int[])
         AND (
           a.state IN ('firing', 'acknowledged')
           OR (a.state = 'recovered' AND a.ticket_id IS NOT NULL
               AND a.recovered_at > NOW() - ($2::int * INTERVAL '1 day'))
         )
       ORDER BY a.first_seen_at DESC
       LIMIT 100
    `, [itemIds, HISTORY_DAYS]);
    await decryptRows('alerts', inc.rows);
    for (const row of inc.rows) delete row.title_enc;

    const mw = await pool.query(`
      SELECT w.id, w.title, w.description, w.work_notes, w.starts_at, w.ends_at,
             w.ticket_id, t.internal_ref AS ticket_ref,
             u.display_name AS created_by_name,
             ARRAY_AGG(mi.item_id) FILTER (WHERE mi.item_id = ANY($1::int[])) AS item_ids
        FROM maintenance_windows w
        JOIN maintenance_window_items mi ON mi.window_id = w.id
        LEFT JOIN tickets t ON t.id = w.ticket_id
        LEFT JOIN users u ON u.id = w.created_by
       WHERE mi.item_id = ANY($1::int[])
         AND w.ends_at > NOW() - ($2::int * INTERVAL '1 day')
         AND w.starts_at < NOW() + ($3::int * INTERVAL '1 day')
       GROUP BY w.id, t.internal_ref, u.display_name
       ORDER BY w.starts_at DESC
    `, [itemIds, HISTORY_DAYS, UPCOMING_DAYS]);

    res.json({
      page,
      items,
      incidents: inc.rows,
      maintenance: mw.rows,
      history_days: HISTORY_DAYS,
    });
  } catch (err) {
    console.error('status page detail:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

function validatePage(body, partial) {
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'name')) {
    const name = String(body.name || '').trim();
    if (!name) return 'name required';
    if (name.length > 120) return 'name too long (max 120)';
  }
  if (body.description != null && String(body.description).length > 2000) {
    return 'description too long (max 2000)';
  }
  return null;
}

router.post('/', requireRole(...CURATORS), async (req, res) => {
  const body = req.body || {};
  const err = validatePage(body, false);
  if (err) return res.status(400).json({ error: err });
  try {
    const row = await transaction(async (client) => {
      const slug = await uniqueSlug(client, slugify(body.slug || body.name));
      const r = await client.query(
        `INSERT INTO status_pages (name, slug, description, sort_order, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [
          String(body.name).trim(), slug, body.description || null,
          Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 100,
          req.session.user.id,
        ]
      );
      return r.rows[0];
    });
    res.status(201).json(row);
  } catch (e) {
    console.error('status page create:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

router.patch('/:id', requireRole(...CURATORS), async (req, res) => {
  const body = req.body || {};
  const err = validatePage(body, true);
  if (err) return res.status(400).json({ error: err });
  const id = Number(req.params.id);
  try {
    const row = await transaction(async (client) => {
      const sets = [];
      const vals = [];
      let p = 1;
      if (Object.prototype.hasOwnProperty.call(body, 'name')) {
        sets.push(`name = $${p++}`); vals.push(String(body.name).trim());
      }
      if (Object.prototype.hasOwnProperty.call(body, 'description')) {
        sets.push(`description = $${p++}`); vals.push(body.description || null);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'sort_order')) {
        sets.push(`sort_order = $${p++}`); vals.push(Number(body.sort_order) || 100);
      }
      if (body.slug) {
        sets.push(`slug = $${p++}`); vals.push(await uniqueSlug(client, slugify(body.slug), id));
      }
      sets.push('updated_at = NOW()');
      vals.push(id);
      const r = await client.query(
        `UPDATE status_pages SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`,
        vals
      );
      return r.rows[0];
    });
    if (!row) return res.status(404).json({ error: 'Status page not found' });
    res.json(row);
  } catch (e) {
    console.error('status page patch:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

// PUT /api/status-pages/:id/items — replace the page's item list.
// body: { items: [{ item_id, section?, display_name?, sort_order? }] }
router.put('/:id/items', requireRole(...CURATORS), async (req, res) => {
  const list = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!list) return res.status(400).json({ error: 'items array required' });
  if (list.length > 500) return res.status(400).json({ error: 'too many items (max 500)' });
  const id = Number(req.params.id);
  try {
    const count = await transaction(async (client) => {
      const page = await client.query(`SELECT id FROM status_pages WHERE id = $1 FOR UPDATE`, [id]);
      if (!page.rows[0]) return null;
      await client.query(`DELETE FROM status_page_items WHERE page_id = $1`, [id]);
      let n = 0;
      for (const [idx, it] of list.entries()) {
        const itemId = Number(it.item_id);
        if (!Number.isInteger(itemId)) continue;
        await client.query(
          `INSERT INTO status_page_items (page_id, item_id, section, display_name, sort_order)
           SELECT $1, i.id, $3, $4, $5 FROM alert_monitored_items i WHERE i.id = $2
           ON CONFLICT (page_id, item_id) DO NOTHING`,
          [
            id, itemId,
            it.section ? String(it.section).trim().slice(0, 120) : null,
            it.display_name ? String(it.display_name).trim().slice(0, 160) : null,
            Number.isFinite(Number(it.sort_order)) ? Number(it.sort_order) : idx,
          ]
        );
        n += 1;
      }
      await client.query(`UPDATE status_pages SET updated_at = NOW() WHERE id = $1`, [id]);
      return n;
    });
    if (count === null) return res.status(404).json({ error: 'Status page not found' });
    res.json({ ok: true, items: count });
  } catch (e) {
    console.error('status page items:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

router.delete('/:id', requireRole(...CURATORS), async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM status_pages WHERE id = $1 RETURNING id`, [Number(req.params.id)]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Status page not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('status page delete:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

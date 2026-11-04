// Status pages: admin-curated views over monitored items (Uptime Kuma
// monitors and any other source that tracks items). Public pages are
// readable by every logged-in user, private pages by Admin / Manager /
// Tech only; Admin / Manager curate. Users can subscribe to email
// alerts (services/statusPageNotifier.js).
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
const timeline = require('../services/statusTimeline');
const notifier = require('../services/statusPageNotifier');

const router = express.Router();
router.use(requireAuth);

const CURATORS = ['Admin', 'Manager'];
const STAFF = ['Admin', 'Manager', 'Tech'];
const HISTORY_DAYS = 14;
const BUCKET_HOURS = 6; // 14 days → 56 pips per bar

const isStaff = (user) => STAFF.includes(user?.role);
const canViewPage = (user, page) => page.is_public || isStaff(user);
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

// Per-item state timelines over the history window, from
// alert_item_state_changes + maintenance windows. Services with
// components are rolled up from them (same rule as the live state).
// Mutates items: adds timeline (bucket array) + uptime_14d to every
// item and component. Returns outage episodes (down / partial runs,
// including ones that never became an incident) with any ticketed
// incidents that overlap them.
async function buildTimelines(items, incidents) {
  const end = Date.now();
  const start = end - HISTORY_DAYS * 86400000;
  const bucketMs = BUCKET_HOURS * 3600000;
  const startIso = new Date(start).toISOString();
  const allIds = [...new Set(items.flatMap((i) => [i.item_id, ...i.components.map((c) => c.item_id)]))];
  if (!allIds.length) return { start, end, bucketMs, outages: [], matchedIncidentIds: new Set() };

  const [changes, prior, meta, windows] = await Promise.all([
    pool.query(
      `SELECT item_id, from_state, to_state, changed_at FROM alert_item_state_changes
        WHERE item_id = ANY($1::int[]) AND changed_at >= $2 ORDER BY changed_at ASC`,
      [allIds, startIso]
    ),
    pool.query(
      `SELECT DISTINCT ON (item_id) item_id, to_state FROM alert_item_state_changes
        WHERE item_id = ANY($1::int[]) AND changed_at < $2
        ORDER BY item_id, changed_at DESC`,
      [allIds, startIso]
    ),
    pool.query(
      `SELECT id, first_seen_at, last_state, parent_item_id FROM alert_monitored_items WHERE id = ANY($1::int[])`,
      [allIds]
    ),
    pool.query(
      `SELECT mi.item_id, w.starts_at, w.ends_at
         FROM maintenance_window_items mi JOIN maintenance_windows w ON w.id = mi.window_id
        WHERE w.ends_at > $1 AND w.starts_at < NOW()`,
      [startIso]
    ),
  ]);
  const changesBy = new Map();
  for (const c of changes.rows) {
    if (!changesBy.has(c.item_id)) changesBy.set(c.item_id, []);
    changesBy.get(c.item_id).push(c);
  }
  const priorBy = new Map(prior.rows.map((r) => [r.item_id, r.to_state]));
  const metaBy = new Map(meta.rows.map((r) => [r.id, r]));
  const windowsFor = (id) => {
    const parent = metaBy.get(id)?.parent_item_id;
    return windows.rows.filter((w) => w.item_id === id || (parent && w.item_id === parent));
  };
  const segmentsFor = (id) => {
    const m = metaBy.get(id) || {};
    return timeline.itemSegments({
      changes: changesBy.get(id) || [],
      priorState: priorBy.get(id) || null,
      currentState: m.last_state || null,
      firstSeenAt: m.first_seen_at || null,
      maintenance: windowsFor(id),
      start,
      end,
    });
  };
  const pack = (segs) => timeline.bucketize(segs, start, end, bucketMs).map((b) => ({
    s: b.state, d: b.down_s, p: b.partial_s, g: b.degraded_s, m: b.maint_s, k: b.known_s,
  }));

  const outages = [];
  const matchedIncidentIds = new Set();
  for (const it of items) {
    let serviceSegs;
    const compSegs = it.components.map((c) => ({ c, segments: segmentsFor(c.item_id) }));
    for (const { c, segments } of compSegs) {
      c.timeline = pack(segments);
      c.uptime_14d = timeline.uptimeRatio(segments);
    }
    if (compSegs.length) {
      serviceSegs = timeline.rollupSegments(
        compSegs.map(({ c, segments }) => ({ is_primary: c.is_primary, segments })), start, end
      );
    } else {
      serviceSegs = segmentsFor(it.item_id);
    }
    it.timeline = pack(serviceSegs);
    it.uptime_14d = timeline.uptimeRatio(serviceSegs);

    const name = it.display_name || it.label;
    const memberIds = new Set([it.item_id, ...it.components.map((c) => c.item_id)]);
    for (const ep of timeline.episodes(serviceSegs, end)) {
      const epEnd = ep.end ?? end;
      const affected = compSegs
        .filter(({ segments }) => segments.some((sg) => sg.state === 'down' && sg.start < epEnd && sg.end > ep.start))
        .map(({ c }) => c.label);
      const tickets = [];
      for (const inc of incidents) {
        if (!memberIds.has(inc.item_id)) continue;
        const iStart = new Date(inc.first_seen_at).getTime();
        const iEnd = inc.recovered_at ? new Date(inc.recovered_at).getTime() : end;
        if (iStart < epEnd && iEnd > ep.start) {
          if (inc.state === 'recovered') matchedIncidentIds.add(inc.id);
          if (inc.ticket_id && !tickets.some((t) => t.id === inc.ticket_id)) {
            tickets.push({ id: inc.ticket_id, ref: inc.ticket_ref, status: inc.ticket_status });
          }
        }
      }
      outages.push({
        page_item_id: it.page_item_id,
        item_id: it.item_id,
        name,
        section: it.section || null,
        state: ep.state,
        started_at: new Date(ep.start).toISOString(),
        ended_at: ep.end ? new Date(ep.end).toISOString() : null,
        // Already down when the window opened; real start is earlier.
        start_clipped: ep.start <= start,
        components: affected,
        tickets,
      });
    }
  }
  outages.sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
  return { start, end, bucketMs, outages, matchedIncidentIds };
}

// GET /api/status-pages — pages with a down/maintenance summary.
router.get('/', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.id, p.name, p.slug, p.description, p.sort_order, p.is_public,
              (s.id IS NOT NULL) AS subscribed
         FROM status_pages p
         LEFT JOIN status_page_subscriptions s ON s.page_id = p.id AND s.user_id = $1
        WHERE p.is_public OR $2::boolean
        ORDER BY p.sort_order ASC, p.name ASC`,
      [req.session.user.id, isStaff(req.session.user)]
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
    // Private pages 404 (not 403) for non-staff so they can't be probed.
    if (!page || !canViewPage(req.session.user, page)) {
      return res.status(404).json({ error: 'Status page not found' });
    }

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

    const tl = await buildTimelines(items, inc.rows);

    const sub = await pool.query(
      `SELECT notify_state, notify_changes FROM status_page_subscriptions WHERE page_id = $1 AND user_id = $2`,
      [page.id, req.session.user.id]
    );

    res.json({
      page,
      items,
      // Recovered incidents already shown under an outage are dropped
      // here so the history doesn't list them twice.
      incidents: inc.rows.filter((i) => !tl.matchedIncidentIds.has(i.id)),
      outages: tl.outages,
      maintenance: mw.rows,
      history_days: HISTORY_DAYS,
      timeline: { start: tl.start, end: tl.end, bucket_ms: tl.bucketMs },
      subscription: sub.rows[0] || null,
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
        `INSERT INTO status_pages (name, slug, description, sort_order, created_by, is_public)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [
          String(body.name).trim(), slug, body.description || null,
          Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 100,
          req.session.user.id,
          body.is_public !== false,
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
      if (Object.prototype.hasOwnProperty.call(body, 'is_public')) {
        sets.push(`is_public = $${p++}`); vals.push(body.is_public !== false);
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
    let added = [];
    const count = await transaction(async (client) => {
      const page = await client.query(`SELECT id FROM status_pages WHERE id = $1 FOR UPDATE`, [id]);
      if (!page.rows[0]) return null;
      const before = await client.query(`SELECT item_id FROM status_page_items WHERE page_id = $1`, [id]);
      const had = new Set(before.rows.map((r) => r.item_id));
      added = [...new Set(list.map((it) => Number(it.item_id)).filter((n) => Number.isInteger(n) && !had.has(n)))];
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
    res.json({ ok: true, items: count, added: added.length });
    // Page-change emails for subscribers (after commit, never blocks).
    if (added.length) {
      notifier.notifyPageChanged(id, added)
        .catch((err) => console.error('status page change notify:', err.message));
    }
  } catch (e) {
    console.error('status page items:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

// PUT /api/status-pages/:id/subscription — subscribe (or update) the
// caller. body: { notify_state?: bool, notify_changes?: bool }. Both
// false = unsubscribe.
router.put('/:id/subscription', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const p = await pool.query(`SELECT id, is_public FROM status_pages WHERE id = $1`, [id]);
    if (!p.rows[0] || !canViewPage(req.session.user, p.rows[0])) {
      return res.status(404).json({ error: 'Status page not found' });
    }
    const body = req.body || {};
    const notifyState = body.notify_state !== false;
    const notifyChanges = body.notify_changes !== false;
    if (!notifyState && !notifyChanges) {
      await pool.query(`DELETE FROM status_page_subscriptions WHERE page_id = $1 AND user_id = $2`, [id, req.session.user.id]);
      return res.json({ subscription: null });
    }
    const r = await pool.query(
      `INSERT INTO status_page_subscriptions (page_id, user_id, notify_state, notify_changes)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (page_id, user_id) DO UPDATE
         SET notify_state = EXCLUDED.notify_state, notify_changes = EXCLUDED.notify_changes, updated_at = NOW()
       RETURNING notify_state, notify_changes`,
      [id, req.session.user.id, notifyState, notifyChanges]
    );
    res.json({ subscription: r.rows[0] });
  } catch (e) {
    console.error('status page subscribe:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/status-pages/:id/subscription — unsubscribe the caller.
router.delete('/:id/subscription', async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM status_page_subscriptions WHERE page_id = $1 AND user_id = $2`,
      [Number(req.params.id), req.session.user.id]
    );
    res.json({ subscription: null });
  } catch (e) {
    console.error('status page unsubscribe:', e);
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

// Monitored-item state shared by the webhook ingest path and the
// status poller: state transitions (with history), maintenance-window
// lookups, and applying a full poll snapshot from an adapter.

const { pool } = require('../db/pool');

// Record a state change when it differs from the stored one. Returns
// true when a transition was written.
async function setItemState(client, itemId, newState, via) {
  if (!newState) return false;
  const cur = await client.query(
    `SELECT last_state FROM alert_monitored_items WHERE id = $1 FOR UPDATE`,
    [itemId]
  );
  if (!cur.rows[0]) return false;
  const fromState = cur.rows[0].last_state;
  if (fromState === newState) return false;
  await client.query(
    `UPDATE alert_monitored_items SET last_state = $2, state_since = NOW() WHERE id = $1`,
    [itemId, newState]
  );
  await client.query(
    `INSERT INTO alert_item_state_changes (item_id, from_state, to_state, via)
     VALUES ($1, $2, $3, $4)`,
    [itemId, fromState, newState, via || null]
  );
  return true;
}

// The maintenance window currently covering an item, directly or via
// its parent service, if any. Latest ending window wins so callers can
// defer work until it closes.
async function activeMaintenanceFor(client, sourceId, itemKey) {
  if (!itemKey) return null;
  const r = await (client || pool).query(
    `SELECT w.id, w.title, w.ends_at
       FROM maintenance_windows w
       JOIN maintenance_window_items mi ON mi.window_id = w.id
       JOIN alert_monitored_items i ON i.id = mi.item_id OR i.parent_item_id = mi.item_id
      WHERE i.source_id = $1 AND i.item_key = $2
        AND w.starts_at <= NOW() AND w.ends_at > NOW()
      ORDER BY w.ends_at DESC
      LIMIT 1`,
    [sourceId, itemKey]
  );
  return r.rows[0] || null;
}

// Apply one poll snapshot. rows: [{ item_key, label, detail,
// external_id, item_type, state, uptime_1d, uptime_30d, response_ms,
// cert_days }]. Items missing from the snapshot are marked inactive
// rather than deleted so pins and history survive a renamed monitor.
async function applyStatusSnapshot(client, source, rows) {
  let changed = 0;
  for (const row of rows) {
    const r = await client.query(
      `INSERT INTO alert_monitored_items
         (source_id, item_key, label, detail, external_id, item_type,
          uptime_1d, uptime_30d, response_ms, cert_days, polled_at, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), TRUE)
       ON CONFLICT (source_id, item_key) DO UPDATE
         SET label = COALESCE(alert_monitored_items.label, EXCLUDED.label),
             detail = COALESCE(EXCLUDED.detail, alert_monitored_items.detail),
             external_id = EXCLUDED.external_id,
             item_type = EXCLUDED.item_type,
             uptime_1d = EXCLUDED.uptime_1d,
             uptime_30d = EXCLUDED.uptime_30d,
             response_ms = EXCLUDED.response_ms,
             cert_days = EXCLUDED.cert_days,
             polled_at = NOW(),
             active = TRUE
       RETURNING id`,
      [
        source.id, row.item_key, row.label || null, row.detail || null,
        row.external_id || null, row.item_type || null,
        row.uptime_1d ?? null, row.uptime_30d ?? null,
        row.response_ms ?? null, row.cert_days ?? null,
      ]
    );
    if (await setItemState(client, r.rows[0].id, row.state, 'poll')) changed += 1;
  }
  const keys = rows.map((r) => r.item_key);
  const gone = await client.query(
    `UPDATE alert_monitored_items SET active = FALSE
      WHERE source_id = $1 AND active = TRUE AND polled_at IS NOT NULL
        AND NOT (item_key = ANY($2::text[]))
      RETURNING id`,
    [source.id, keys]
  );
  return { items: rows.length, changed, deactivated: gone.rowCount };
}

// Service state from its components' effective states. A primary
// component down takes the service down; otherwise any component down
// is a partial outage (all down = down). Components in maintenance
// count as neither.
function rollupServiceState(components, ownState) {
  if (!components.length) return ownState || 'unknown';
  const states = components.map((c) => c.state);
  if (states.every((st) => st === 'maintenance')) return 'maintenance';
  const live = components.filter((c) => c.state !== 'maintenance');
  const down = live.filter((c) => c.state === 'down');
  const primaries = live.filter((c) => c.is_primary);
  if (primaries.some((c) => c.state === 'down')) return 'down';
  if (down.length && down.length === live.length) return 'down';
  if (down.length) return 'partial';
  if (live.some((c) => c.state === 'pending')) return 'pending';
  if (live.every((c) => c.state === 'unknown')) return 'unknown';
  return 'up';
}

module.exports = { setItemState, activeMaintenanceFor, applyStatusSnapshot, rollupServiceState };

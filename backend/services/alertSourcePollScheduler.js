// Periodic poll for external alert sources whose preset has no push
// channel (Action1). Each source carries its own poll_interval_minutes
// (0 = disabled). Tick runs every 30s, fires sources whose
// last_poll_at + interval has elapsed.
//
// Single-process design: the scheduler runs in-band with the API server.
// If the deployment scales beyond one backend replica, swap this for the
// system_jobs leader-election pattern used by other cron-y services.

const { pool } = require('../db/pool');
const { decryptRow } = require('./fields');
const action1Poll = require('./action1Poll');

const TICK_MS = 30 * 1000;

async function loadDueSources() {
  // poll_interval_minutes > 0 + enabled + (never polled OR interval elapsed).
  const r = await pool.query(`
    SELECT * FROM external_alert_source
     WHERE enabled = TRUE
       AND preset = 'action1'
       AND poll_interval_minutes > 0
       AND (
         last_poll_at IS NULL
         OR last_poll_at < NOW() - (poll_interval_minutes || ' minutes')::interval
       )
  `);
  for (const row of r.rows) await decryptRow('external_alert_source', row);
  return r.rows;
}

async function tickOnce() {
  let sources;
  try {
    sources = await loadDueSources();
  } catch (err) {
    console.error('alertSourcePoll: load error:', err.message);
    return [];
  }
  const results = [];
  for (const source of sources) {
    try {
      const summary = await action1Poll.pollSource(source);
      results.push({ id: source.id, ok: true, ...summary });
    } catch (err) {
      // pollSource already persists api_last_error and bumps last_poll_at.
      results.push({ id: source.id, ok: false, error: err.message });
    }
  }
  // Software auto-sync sweep: each tick picks up to 2 computer-type
  // assets per inventory-enabled source whose software list is stale
  // (NULL or > 7 days). Spread across many ticks so a 30s tick window
  // doesn't hammer the upstream API. Daily-ish coverage per asset
  // emerges naturally from poll_interval_minutes × ticks.
  await sweepStaleSoftware().catch((err) => console.error('software sweep error:', err.message));
  return results;
}

const SOFTWARE_STALE_DAYS = 7;
const SOFTWARE_PER_TICK_PER_SOURCE = 2;
const COMPUTER_TYPE_SLUGS = ['workstation', 'server', 'laptop'];

async function sweepStaleSoftware() {
  // Find inventory-enabled Action1 sources first; for each, grab a
  // few stale computer-type assets and sync them. One sync per asset
  // costs an OAuth + paged GET — acceptable load when capped per tick.
  const inv = await pool.query(`
    SELECT id FROM external_alert_source
     WHERE enabled = TRUE AND preset = 'action1' AND affect_inventory = TRUE
  `);
  if (!inv.rows.length) return;
  const action1Software = require('./action1Software');
  for (const src of inv.rows) {
    const stale = await pool.query(
      `SELECT a.id FROM assets a
         JOIN asset_types at ON at.id = a.asset_type_id
        WHERE a.source_alert_source_id = $1
          AND at.slug = ANY($2::text[])
          AND (a.last_software_sync_at IS NULL
               OR a.last_software_sync_at < NOW() - INTERVAL '${SOFTWARE_STALE_DAYS} days')
        ORDER BY a.last_software_sync_at NULLS FIRST, a.id
        LIMIT $3`,
      [src.id, COMPUTER_TYPE_SLUGS, SOFTWARE_PER_TICK_PER_SOURCE]
    );
    for (const row of stale.rows) {
      await action1Software.syncSoftwareForAsset(row.id).catch((err) =>
        console.error(`auto software sync asset ${row.id}:`, err.message)
      );
    }
  }
}

let _interval = null;
function startScheduler() {
  if (_interval) return;
  _interval = setInterval(() => {
    tickOnce().catch((err) => console.error('alertSourcePoll tick error:', err.message));
  }, TICK_MS);
  // Fire once on boot so a quick restart doesn't waste the user's
  // configured interval.
  tickOnce().catch(() => {});
}

module.exports = { tickOnce, startScheduler };

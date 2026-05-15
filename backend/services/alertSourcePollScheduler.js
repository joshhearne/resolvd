// Periodic poll for integrations whose vendor exposes a pullInventory
// adapter (Action1 today; NinjaOne / Datto / ConnectWise via future
// adapters). Each source carries its own poll_interval_minutes (0 =
// disabled). Tick runs every 30s, fires sources whose last_poll_at +
// interval has elapsed.
//
// Vendor routing goes through services/integrations/registry — no
// hardcoded preset switches here. A source is eligible when:
//   * enabled = TRUE
//   * vendor (COALESCE with legacy preset) maps to a registered
//     adapter that declares the 'inventory' capability
//   * the source row's capabilities array also includes 'inventory'
//     (admin can opt out per integration without disabling it)
//
// Single-process design: the scheduler runs in-band with the API server.
// If the deployment scales beyond one backend replica, swap this for the
// system_jobs leader-election pattern used by other cron-y services.

const { pool } = require('../db/pool');
const { decryptRow } = require('./fields');
const registry = require('./integrations/registry');

const TICK_MS = 30 * 1000;

// Source row -> registered adapter. Falls back to legacy preset when
// the new vendor column hasn't been written yet (covers fresh installs
// between the schema add and the first row save).
function adapterFor(row) {
  const key = row.vendor || row.preset;
  return key ? registry.get(key) : null;
}

// True when the source row + adapter agree on a capability. The
// schema-side capabilities[] is the effective list (admin opt-in);
// adapter capabilities is the declared upper bound.
function hasCapability(row, adapter, cap) {
  if (!adapter || !adapter.capabilities.includes(cap)) return false;
  const rowCaps = Array.isArray(row.capabilities) ? row.capabilities : [];
  if (!rowCaps.length) return true; // legacy rows pre-Phase-0 — trust adapter
  return rowCaps.includes(cap);
}

async function loadDueSources() {
  // Filter for vendors with pullInventory at the SQL layer first so the
  // registry doesn't see rows it can't act on. We still re-check via
  // adapterFor() below because admin can disable a capability per row.
  const inventoryVendors = registry.inventoryVendors().map((a) => a.vendor);
  if (!inventoryVendors.length) return [];
  const r = await pool.query(`
    SELECT * FROM external_alert_source
     WHERE enabled = TRUE
       AND COALESCE(vendor, preset) = ANY($1::text[])
       AND poll_interval_minutes > 0
       AND (
         last_poll_at IS NULL
         OR last_poll_at < NOW() - (poll_interval_minutes || ' minutes')::interval
       )
  `, [inventoryVendors]);
  const out = [];
  for (const row of r.rows) {
    await decryptRow('external_alert_source', row);
    const adapter = adapterFor(row);
    if (!adapter || !hasCapability(row, adapter, 'inventory')) continue;
    out.push({ row, adapter });
  }
  return out;
}

async function tickOnce() {
  let due;
  try {
    due = await loadDueSources();
  } catch (err) {
    console.error('alertSourcePoll: load error:', err.message);
    return [];
  }
  const results = [];
  for (const { row, adapter } of due) {
    try {
      const summary = await adapter.pullInventory(row);
      results.push({ id: row.id, vendor: adapter.vendor, ok: true, ...summary });
    } catch (err) {
      // pullInventory adapters are expected to persist api_last_error
      // and bump last_poll_at themselves (same contract action1Poll
      // already follows).
      results.push({ id: row.id, vendor: adapter.vendor, ok: false, error: err.message });
    }
  }
  // Software auto-sync sweep: each tick picks up to 2 computer-type
  // assets per inventory-enabled source whose software list is stale
  // (NULL or > 7 days). Spread across many ticks so a 30s tick window
  // doesn't hammer the upstream API. Daily-ish coverage per asset
  // emerges naturally from poll_interval_minutes × ticks.
  await sweepStaleSoftware().catch((err) => console.error('software sweep error:', err.message));
  // Delayed alert promotion sweep: rules with delay_minutes > 0 stamp
  // next_evaluation_at on the alert; this loop picks expired ones and
  // re-evaluates. If the alert is still firing and a create_ticket
  // rule still matches, promote.
  await sweepDelayedAlerts().catch((err) => console.error('delayed alert sweep error:', err.message));
  return results;
}

async function sweepDelayedAlerts() {
  const { pickRule } = require('./alertEvaluator');
  const { promoteAlertToTicket } = require('./alertIngest');
  const { transaction } = require('../db/pool');
  const due = await pool.query(`
    SELECT a.id AS alert_id, a.source_id
      FROM alerts a
     WHERE a.state = 'firing'
       AND a.ticket_id IS NULL
       AND a.next_evaluation_at IS NOT NULL
       AND a.next_evaluation_at <= NOW()
     ORDER BY a.next_evaluation_at ASC
     LIMIT 25
  `);
  for (const row of due.rows) {
    try {
      await transaction(async (client) => {
        // Re-lock and re-check inside the transaction.
        const a = await client.query(
          `SELECT a.*, a.title AS title_plain, a.description AS description_plain
             FROM alerts a WHERE a.id = $1 FOR UPDATE`,
          [row.alert_id]
        );
        const alertRow = a.rows[0];
        if (!alertRow) return;
        if (alertRow.state !== 'firing' || alertRow.ticket_id) {
          await client.query(`UPDATE alerts SET next_evaluation_at = NULL WHERE id = $1`, [row.alert_id]);
          return;
        }
        const src = await client.query(`SELECT * FROM external_alert_source WHERE id = $1`, [alertRow.source_id]);
        if (!src.rows[0]) return;
        await decryptRow('external_alert_source', src.rows[0]);
        // Decrypt title/desc for the matcher.
        const { decryptRow: decRow } = require('./fields');
        await decRow('alerts', alertRow);
        const rulesQ = await client.query(
          `SELECT * FROM alert_rules WHERE integration_id = $1 AND enabled = TRUE
            ORDER BY priority ASC, id ASC`,
          [alertRow.source_id]
        );
        const rule = pickRule(rulesQ.rows, alertRow);
        if (rule && rule.action === 'create_ticket') {
          await promoteAlertToTicket(client, src.rows[0], { ...alertRow, event: {} }, rule, null);
        } else {
          // Rule changed / removed — drop the pending eval but leave
          // state=firing so the admin still sees it on the Alerts page.
          await client.query(`UPDATE alerts SET next_evaluation_at = NULL WHERE id = $1`, [row.alert_id]);
        }
      });
    } catch (err) {
      console.error(`delayed alert ${row.alert_id} eval error:`, err.message);
    }
  }
}

const SOFTWARE_STALE_DAYS = 7;
const SOFTWARE_PER_TICK_PER_SOURCE = 2;
const COMPUTER_TYPE_SLUGS = ['workstation', 'server', 'laptop'];

async function sweepStaleSoftware() {
  // Iterate every source whose vendor offers a pullSoftware adapter
  // AND the source has affect_inventory + the 'software' capability.
  // For each, grab a few stale computer-type assets and sync them.
  // One sync per asset costs an OAuth + paged GET — acceptable load
  // when capped per tick.
  const softwareVendors = registry.softwareVendors().map((a) => a.vendor);
  if (!softwareVendors.length) return;
  const inv = await pool.query(`
    SELECT * FROM external_alert_source
     WHERE enabled = TRUE
       AND affect_inventory = TRUE
       AND COALESCE(vendor, preset) = ANY($1::text[])
  `, [softwareVendors]);
  if (!inv.rows.length) return;
  for (const src of inv.rows) {
    const adapter = adapterFor(src);
    if (!adapter || !hasCapability(src, adapter, 'software')) continue;
    await decryptRow('external_alert_source', src);
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
      await adapter.pullSoftware(src, row).catch((err) =>
        console.error(`auto software sync asset ${row.id} (${adapter.vendor}):`, err.message)
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

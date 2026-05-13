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
  return results;
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

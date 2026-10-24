// Background job registry, shared by both runtimes.
//
// Node (Docker): startAll() calls each module's own startScheduler(),
// which runs its setInterval loop in-process.
//
// Cloudflare Workers: there is no long-lived process, so wrangler.toml
// fires a single every-minute Cron Trigger and runCron() runs whichever
// ticks are due for that minute. Cadences match the Node intervals,
// rounded up to Cron's one-minute floor.

const mutedDigest = require('./mutedDigest');
const inboxMonitor = require('./inboxMonitorScheduler');
const autoClose = require('./autoClose');
const notificationOutbox = require('./notificationOutbox');
const sla = require('./sla');
const alertSourcePoll = require('./alertSourcePollScheduler');
const ticketSchedules = require('./ticketSchedules');
const troveKbSnapshots = require('./troveKbSnapshotScheduler');
const troveKb = require('./troveKb');
const rateLimitStore = require('./rateLimitStore');
const { pool } = require('../db/pool');

function startAll() {
  // Muted-vendor digest fires at the configured local time once per day
  // (cadence checked every 5 min).
  mutedDigest.startScheduler();
  // Inbox monitor renewal: walks active subscriptions hourly and renews
  // any within 12h of expiring.
  inboxMonitor.startScheduler();
  // Auto-close tickets sitting in a resolved_pending_close status past
  // their configured grace period. Hourly tick.
  autoClose.startScheduler();
  // Notification outbox flusher: drains buffered email rows for users
  // whose email_digest cadence (hourly / 12h / daily) has elapsed.
  // 5-minute tick.
  notificationOutbox.startScheduler();
  // SLA breach detector: every 5 min, find tickets past their
  // sla_response_due_at / sla_resolve_due_at without being responded /
  // resolved, mark breached, fan out to assignee + followers.
  sla.startScheduler();
  // External alert source poller: pulls policy results from Action1 on
  // each source's configured cadence (Action1 has no webhook channel).
  // 30-second tick; each source fires per its poll_interval_minutes.
  alertSourcePoll.startScheduler();
  // Recurring ticket materialiser: every 60s, fire schedules whose
  // next_fire_at has lapsed, log the run, advance the iterator.
  ticketSchedules.startScheduler();
  troveKbSnapshots.startScheduler();
}

const JOBS = [
  { name: 'alertSourcePoll', every: 'minute', run: () => alertSourcePoll.tickOnce() },
  { name: 'ticketSchedules', every: 'minute', run: () => ticketSchedules.tick() },
  { name: 'mutedDigest', every: '5min', run: () => mutedDigest.tickOnce() },
  { name: 'notificationOutbox', every: '5min', run: () => notificationOutbox.tickOnce() },
  { name: 'sla', every: '5min', run: () => sla.tickSla() },
  { name: 'inboxMonitor', every: 'hour', run: () => inboxMonitor.tickOnce() },
  { name: 'autoClose', every: 'hour', run: () => autoClose.tick() },
  { name: 'troveKbSync', every: 'hour', run: () => troveKb.syncCollections() },
  { name: 'rateLimitPurge', every: 'hour', run: () => rateLimitStore.purgeExpired() },
  // connect-pg-simple prunes on its own timer under Node; see app.js.
  { name: 'sessionPrune', every: 'hour', run: () => pool.query('DELETE FROM session WHERE expire < NOW()') },
  { name: 'troveKbSnapshots', every: 'day', run: () => troveKbSnapshots.refreshSnapshots() },
];

function isDue(every, at) {
  const m = at.getUTCMinutes();
  switch (every) {
    case 'minute': return true;
    case '5min': return m % 5 === 0;
    case 'hour': return m === 0;
    case 'day': return m === 0 && at.getUTCHours() === 3;
    default: return false;
  }
}

// Run every job due at `at` (the cron's scheduled time). One job failing
// doesn't stop the rest.
async function runCron(at = new Date()) {
  const due = JOBS.filter((j) => isDue(j.every, at));
  const results = await Promise.allSettled(due.map((j) => j.run()));
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`${due[i].name} tick error:`, r.reason?.message || r.reason);
  });
  return due.map((j, i) => ({ job: j.name, ok: results[i].status === 'fulfilled' }));
}

module.exports = { startAll, runCron, isDue, JOBS };

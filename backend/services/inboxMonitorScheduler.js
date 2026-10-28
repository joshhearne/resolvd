// Renews provider inbox subscriptions before they expire, and rebuilds
// them when renewal is no longer possible.
//
// Microsoft Graph subscriptions live ~3 days (Mail resource caps at
// 4230 minutes). Gmail watches live 7 days. The scheduler runs once an
// hour and PATCH-renews any subscription within a 12-hour expiry
// window. Idempotent across server restarts via the system_jobs ledger
// (matches the muted-digest pattern).
//
// Recovery: a PATCH can fail permanently — Graph returns 404
// ResourceNotFound once the subscription has lapsed, and a renewal can
// also be rejected while the notification endpoint is unreachable
// (tunnel down, edge 403), after which the subscription expires on its
// own. Previously the hourly tick just logged the error and retried the
// same dead PATCH forever, so inbound mail stayed silently broken until
// an admin toggled the monitor by hand. Now a dead subscription is
// recreated in place, and the Inbox is swept for anything that arrived
// while notifications weren't flowing, since Graph never replays those.

const { pool } = require('../db/pool');
const { decryptRow } = require('./fields');
const graphInbox = require('./graphInbox');
const gmailInbox = require('./gmailInbox');

// How far back a post-recovery sweep is allowed to look, whatever the
// stored timestamps say. Guards against a stale row dragging in weeks of
// old mail as brand-new tickets.
const MAX_SWEEP_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

async function loadMonitoredAccounts() {
  const r = await pool.query(`
    SELECT * FROM email_backend_accounts
     WHERE inbox_monitor_enabled = TRUE
       AND inbox_subscription_id IS NOT NULL
  `);
  for (const row of r.rows) await decryptRow('email_backend_accounts', row);
  return r.rows;
}

function isGoneError(e) {
  const msg = String(e?.message || '');
  return /PATCH 404\b/.test(msg) || /ResourceNotFound/i.test(msg);
}

// Overlap applied to the sweep watermark so a message that landed while
// the previous sweep was mid-flight (or sits just under Graph's
// receivedDateTime rounding) is still picked up. Sweeps are idempotent so
// the overlap only costs a few duplicate lookups.
const SWEEP_OVERLAP_MS = 10 * 60 * 1000;

// Earliest moment we can be sure notifications were still flowing is the
// last successful create/renew; anything after that may have been lost.
// A later successful sweep moves the mark forward so the polling fallback
// doesn't rescan the whole lookback window every hour.
function sweepSince(account) {
  const candidates = [account.inbox_last_renewed_at, account.inbox_subscription_expires_at]
    .map(v => (v ? new Date(v).getTime() : NaN))
    .filter(Number.isFinite);
  const floor = Date.now() - MAX_SWEEP_LOOKBACK_MS;
  let since = candidates.length ? Math.min(...candidates) : floor;
  const swept = account.inbox_last_swept_at ? new Date(account.inbox_last_swept_at).getTime() : NaN;
  if (Number.isFinite(swept)) since = Math.max(since, swept - SWEEP_OVERLAP_MS);
  return new Date(Math.max(since, floor)).toISOString();
}

async function sweepGraph(account, since, label) {
  const startedAt = new Date();
  const sweep = await graphInbox.sweepInbox(account, since);
  console.warn(`inbox monitor: ${label} sweep for account ${account.id}: since=${since} scanned=${sweep.scanned} fed=${sweep.fed} skipped=${sweep.skipped} failed=${sweep.failed}`);
  for (const it of sweep.items) {
    console.warn(`  ${it.error ? 'FAILED' : 'fed   '} ${it.received} | ${it.from} | ${it.subject}${it.error ? ` :: ${it.error}` : ''}`);
  }
  // Watermark = when this sweep started, not when it finished, so mail
  // arriving mid-sweep falls inside the next window.
  if (!sweep.failed) {
    await pool.query(
      `UPDATE email_backend_accounts SET inbox_last_swept_at = $2 WHERE id = $1`,
      [account.id, startedAt]
    );
  }
  return { since, scanned: sweep.scanned, fed: sweep.fed, skipped: sweep.skipped, failed: sweep.failed };
}

async function recreateGraph(account) {
  const since = sweepSince(account);
  const sub = await graphInbox.createSubscription(account);
  console.warn(`inbox monitor: recreated Graph subscription for account ${account.id} (${account.from_address}) -> ${sub.id}; sweeping Inbox since ${since}`);
  return { subscriptionId: sub.id, sweep: await sweepGraph(account, since, 'post-recreate') };
}

// Polling fallback. When the subscription can't be rebuilt (Graph's
// validation ping to our webhook is being rejected upstream — Sep 2026
// this was a Cloudflare edge 403 that lasted for weeks), push
// notifications are simply unavailable. Rather than log the same error
// hourly while mail piles up unseen, fall back to sweeping the Inbox on
// every tick. Slower (up to an hour of lag) but nothing is lost.
async function recreateOrPoll(account, reason) {
  try {
    return { action: 'recreated', reason, ...(await recreateGraph(account)) };
  } catch (e) {
    console.error(`inbox monitor: recreate after ${reason} failed for account ${account.id}:`, e.message);
    const since = sweepSince(account);
    console.warn(`inbox monitor: account ${account.id} (${account.from_address}) has no live subscription; polling Inbox instead`);
    try {
      return { action: 'polled', reason, recreateError: e.message, sweep: await sweepGraph(account, since, 'polling-fallback') };
    } catch (e2) {
      console.error(`inbox monitor: polling fallback failed for account ${account.id}:`, e2.message);
      return { action: 'error', stage: 'recreate', error: e.message, pollError: e2.message };
    }
  }
}

async function tickOnce({ thresholdMs } = {}) {
  const accounts = await loadMonitoredAccounts();
  const results = [];
  for (const account of accounts) {
    const expiry = account.inbox_subscription_expires_at
      ? new Date(account.inbox_subscription_expires_at).getTime()
      : 0;
    const limit = thresholdMs || (account.provider === 'gmail_user'
      ? gmailInbox.RENEWAL_THRESHOLD_MS
      : graphInbox.RENEWAL_THRESHOLD_MS);
    const dueIn = expiry - Date.now();
    if (dueIn > limit) {
      results.push({ id: account.id, action: 'skip', dueIn });
      continue;
    }
    // Already past expiry: Graph has dropped it, don't bother PATCHing.
    if (account.provider === 'graph_user' && dueIn <= 0) {
      results.push({ id: account.id, ...(await recreateOrPoll(account, 'expiry')) });
      continue;
    }
    try {
      if (account.provider === 'graph_user') await graphInbox.renewSubscription(account);
      else if (account.provider === 'gmail_user') await gmailInbox.renewWatch(account);
      results.push({ id: account.id, action: 'renewed' });
    } catch (e) {
      console.error(`inbox renewal failed for account ${account.id}:`, e.message);
      if (account.provider === 'graph_user' && isGoneError(e)) {
        results.push({ id: account.id, ...(await recreateOrPoll(account, '404')) });
      } else {
        results.push({ id: account.id, action: 'error', stage: 'renew', error: e.message });
      }
    }
  }
  await pool.query(
    `UPDATE system_jobs
        SET last_run_at = NOW(),
            last_status = $2,
            metadata = $1::jsonb
      WHERE name = 'inbox_subscription_renewal'`,
    [JSON.stringify({ ran: results.length, results }),
     results.some(r => r.action === 'error') ? 'error' : results.some(r => r.action === 'polled') ? 'degraded' : 'ok']
  );
  return results;
}

let _interval = null;
function startScheduler() {
  if (_interval) return;
  _interval = setInterval(() => {
    tickOnce().catch(err => console.error('inbox renewal tick error:', err.message));
  }, 60 * 60 * 1000); // hourly
  // Fire once on boot so a restart-during-renewal-window catches up.
  tickOnce().catch(() => {});
}

module.exports = { tickOnce, startScheduler, sweepSince, MAX_SWEEP_LOOKBACK_MS };

// Renews provider inbox subscriptions before they expire.
//
// Microsoft Graph subscriptions live ~3 days (Mail resource caps at
// 4230 minutes). Gmail watches live 7 days. The scheduler runs once an
// hour and PATCH-renews any subscription within a 12-hour expiry
// window. Idempotent across server restarts via the system_jobs ledger
// (matches the muted-digest pattern).

const { pool } = require('../db/pool');
const { decryptRow } = require('./fields');
const graphInbox = require('./graphInbox');
const gmailInbox = require('./gmailInbox');

async function loadMonitoredAccounts() {
  const r = await pool.query(`
    SELECT * FROM email_backend_accounts
     WHERE inbox_monitor_enabled = TRUE
       AND inbox_subscription_id IS NOT NULL
  `);
  for (const row of r.rows) await decryptRow('email_backend_accounts', row);
  return r.rows;
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
    try {
      if (account.provider === 'graph_user') await graphInbox.renewSubscription(account);
      else if (account.provider === 'gmail_user') await gmailInbox.renewWatch(account);
      results.push({ id: account.id, action: 'renewed' });
    } catch (e) {
      console.error(`inbox renewal failed for account ${account.id}:`, e.message);
      results.push({ id: account.id, action: 'error', error: e.message });
    }
  }
  await pool.query(
    `UPDATE system_jobs
        SET last_run_at = NOW(),
            last_status = 'ok',
            metadata = $1::jsonb
      WHERE name = 'inbox_subscription_renewal'`,
    [JSON.stringify({ ran: results.length, results })]
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

module.exports = { tickOnce, startScheduler };

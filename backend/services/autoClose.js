// Auto-close pending-resolve tickets after their configured grace period.
//
// Any internal status with semantic_tag='resolved_pending_close' carries
// an auto_close_after_days value. Tickets in those statuses with
// resolved_at older than (now - days) get promoted to the kind's
// terminal status (e.g. Closed), with an audit row + system comment
// recording the auto-close so the trail isn't silent.

const { pool } = require('../db/pool');
const { fanoutFollowUp } = require('./notificationFanout');
const { decryptRow } = require('./fields');

const TICK_MS = 60 * 60 * 1000; // 1 hour

async function findTerminalStatusName() {
  const r = await pool.query(
    `SELECT name FROM statuses
      WHERE kind = 'internal' AND is_terminal = TRUE
      ORDER BY sort_order ASC LIMIT 1`
  );
  return r.rows[0]?.name || 'Closed';
}

// Fire any due follow-up reminders. Notifies the user who scheduled it,
// then clears the followup_at so the same reminder doesn't repeat.
async function runFollowups() {
  const due = await pool.query(`
    SELECT t.id, t.internal_ref, t.title, t.title_enc, t.internal_status,
           t.followup_user_id, u.email AS user_email, u.display_name AS user_name
      FROM tickets t
      JOIN users u ON u.id = t.followup_user_id
     WHERE t.followup_at IS NOT NULL
       AND t.followup_at <= NOW()
       AND t.followup_user_id IS NOT NULL
  `);
  let fired = 0;
  for (const row of due.rows) {
    await decryptRow('tickets', row).catch(() => {});
    try {
      await fanoutFollowUp(pool, {
        ticket: row,
        schedulerUserId: row.followup_user_id,
        schedulerEmail: row.user_email,
        schedulerName: row.user_name,
      });
    } catch (e) {
      console.error('followup fanout failed:', e.message);
    }
    await pool.query(
      `UPDATE tickets SET followup_at = NULL, followup_user_id = NULL WHERE id = $1`,
      [row.id]
    );
    await pool.query(
      `INSERT INTO audit_log (ticket_id, action, note)
       VALUES ($1, 'followup_fired', 'Follow-up reminder fired (notification + email)')`,
      [row.id]
    );
    fired++;
  }
  return { fired };
}

async function runOnce() {
  const target = await findTerminalStatusName();
  // Pull every resolved_pending_close status with its grace period.
  const cfgs = await pool.query(`
    SELECT name, auto_close_after_days
      FROM statuses
     WHERE kind = 'internal'
       AND semantic_tag = 'resolved_pending_close'
       AND auto_close_after_days IS NOT NULL
       AND auto_close_after_days > 0
  `);
  let closed = 0;
  for (const cfg of cfgs.rows) {
    const r = await pool.query(`
      UPDATE tickets
         SET internal_status = $1,
             resolved_at = NULL,
             updated_at = NOW()
       WHERE internal_status = $2
         AND resolved_at IS NOT NULL
         AND resolved_at < NOW() - ($3 || ' days')::interval
       RETURNING id, internal_ref
    `, [target, cfg.name, cfg.auto_close_after_days]);
    for (const row of r.rows) {
      await pool.query(
        `INSERT INTO audit_log (ticket_id, action, old_value, new_value, note)
         VALUES ($1, 'status_change_auto', $2, $3, $4)`,
        [row.id, cfg.name, target, `Auto-closed after ${cfg.auto_close_after_days} day(s) in ${cfg.name}`]
      );
      closed++;
    }
  }
  return { closed };
}

async function tick() {
  const a = await runOnce().catch(err => { console.error('autoClose error:', err.message); return null; });
  const b = await runFollowups().catch(err => { console.error('followup error:', err.message); return null; });
  const result = { closed: a?.closed || 0, fired: b?.fired || 0 };
  await pool.query(
    `UPDATE system_jobs
        SET last_run_at = NOW(),
            last_status = 'ok',
            metadata = $1::jsonb
      WHERE name = 'auto_close'`,
    [JSON.stringify(result)]
  ).catch(() => {});
  return result;
}

let _interval = null;
function startScheduler() {
  if (_interval) return;
  _interval = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  // Fire once on boot to catch up after downtime.
  tick().catch(() => {});
}

module.exports = { runOnce, runFollowups, tick, startScheduler };

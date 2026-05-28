// Recurring ticket materialiser. Polls ticket_schedules every minute,
// fires any whose next_fire_at has lapsed, mints the templated ticket
// in the right project, logs the run, then advances next_fire_at via
// cron-parser. Presets compile to a cron expression at write time, so
// every schedule — preset or raw — is evaluated through the same
// cron iterator. End-condition handling lives here: end_kind='count'
// disables the schedule once fires_count >= end_count; end_kind='date'
// disables once the next_fire_at would land past end_date.

const { CronExpressionParser } = require('cron-parser');
const cronstrue = require('cronstrue');
const { pool, transaction } = require('../db/pool');
const { buildWritePatch, decryptRow, getMode } = require('./fields');
const { nextInternalRef, computePriority } = require('../db/schema');
const blindIndex = require('./blindIndex');
const sla = require('./sla');

// Translate a preset descriptor into a cron expression. preset_config
// shapes (all carry hour + minute integers; some carry day selectors):
//   daily        { hour, minute }
//   weekly       { hour, minute, weekdays: [0..6] } 0=Sun
//   monthly_dom  { hour, minute, day: 1..28 }    capped at 28 so Feb safe
//   monthly_nth  { hour, minute, nth: 1..5, weekday: 0..6 } 5=last
//   yearly       { hour, minute, month: 1..12, day: 1..28 }
function presetToCron(kind, cfg) {
  const cc = cfg || {};
  const h = clamp(parseInt(cc.hour, 10), 0, 23);
  const m = clamp(parseInt(cc.minute, 10), 0, 59);
  switch (kind) {
    case 'daily':
      return `${m} ${h} * * *`;
    case 'weekly': {
      const days = Array.isArray(cc.weekdays) && cc.weekdays.length
        ? cc.weekdays.map((d) => clamp(parseInt(d, 10), 0, 6)).sort().join(',')
        : '1'; // default Monday
      return `${m} ${h} * * ${days}`;
    }
    case 'monthly_dom': {
      const d = clamp(parseInt(cc.day, 10), 1, 28);
      return `${m} ${h} ${d} * *`;
    }
    case 'monthly_nth': {
      // cron doesn't have a native Nth-weekday operator, but most
      // parsers (cron-parser included) support the `#` extension:
      // 5 (Friday) and nth=2 → `5#2`. nth=5 maps to "last" via "L"
      // suffix (e.g. 5L = last Friday). Stay within the subset our
      // cron-parser version supports.
      const nth = clamp(parseInt(cc.nth, 10), 1, 5);
      const wd = clamp(parseInt(cc.weekday, 10), 0, 6);
      const dayField = nth === 5 ? `${wd}L` : `${wd}#${nth}`;
      return `${m} ${h} * * ${dayField}`;
    }
    case 'yearly': {
      const mon = clamp(parseInt(cc.month, 10), 1, 12);
      const d = clamp(parseInt(cc.day, 10), 1, 28);
      return `${m} ${h} ${d} ${mon} *`;
    }
    default:
      throw new Error(`Unknown preset kind: ${kind}`);
  }
}

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

// Public: take whichever shape the admin submitted and return the
// canonical cron expression we store + evaluate against. Throws on
// invalid input so the route returns 400.
function normaliseToCron({ recurrence_kind, cron_expr, preset_kind, preset_config }) {
  if (recurrence_kind === 'cron') {
    if (!cron_expr || typeof cron_expr !== 'string') {
      throw new Error('cron_expr required for recurrence_kind=cron');
    }
    // Trust the parser as the only validator. Throws on bad syntax.
    CronExpressionParser.parse(cron_expr.trim(), { currentDate: new Date(), tz: 'UTC' });
    return cron_expr.trim();
  }
  if (recurrence_kind === 'preset') {
    return presetToCron(preset_kind, preset_config);
  }
  throw new Error('recurrence_kind must be preset|cron');
}

// Compute next_fire_at strictly after `from`. Returns null when the
// next fire would land past end_date OR the schedule has hit its
// end_count (caller checks fires_count). Honors the schedule's tz.
function computeNextFire(cronExpr, tz, from, { endKind, endDate }) {
  const it = CronExpressionParser.parse(cronExpr, { currentDate: from, tz: tz || 'UTC' });
  const next = it.next().toDate();
  if (endKind === 'date' && endDate && next > new Date(endDate)) return null;
  return next;
}

// Human-readable cron summary for the admin UI. cronstrue handles the
// non-standard `L` / `#` extensions; falls back to the raw expression
// if it chokes on something exotic.
function describeCron(cronExpr) {
  try {
    return cronstrue.toString(cronExpr, { use24HourTimeFormat: false });
  } catch {
    return cronExpr;
  }
}

// Materialise a ticket from a schedule row. Mirrors the create path in
// routes/tickets.js (encrypted patch, internal_ref, contacts, follower
// seed, SLA policy). Kept in one transaction so a half-created ticket
// can't leak. Returns the new ticket id.
async function fireSchedule(scheduleRow) {
  return transaction(async (client) => {
    const projRes = await client.query(
      `SELECT id, status FROM projects WHERE id = $1`,
      [scheduleRow.project_id]
    );
    if (!projRes.rows[0] || projRes.rows[0].status !== 'active') {
      throw new Error(`project ${scheduleRow.project_id} archived/missing`);
    }

    const internalRef = await nextInternalRef(client, scheduleRow.project_id);
    const impact = clamp(scheduleRow.impact, 1, 3);
    const urgency = clamp(scheduleRow.urgency, 1, 3);
    const priority = computePriority(impact, urgency);

    const mode = await getMode(client);
    const sensitivePatch = await buildWritePatch(client, 'tickets', {
      title: scheduleRow.title || `Scheduled: ${scheduleRow.name}`,
      description: scheduleRow.description || '',
    });

    const baseCols = [
      'project_id', 'internal_ref', 'submitted_by', 'assigned_to',
      'impact', 'urgency', 'computed_priority', 'effective_priority',
      'title_blind_idx',
    ];
    const submitterId = scheduleRow.requestor_user_id || scheduleRow.created_by || null;
    const baseVals = [
      scheduleRow.project_id, internalRef,
      submitterId,
      scheduleRow.assigned_to || null,
      impact, urgency, priority, priority,
      mode === 'standard' && scheduleRow.title
        ? blindIndex.buildIndex(scheduleRow.title)
        : null,
    ];

    const cols = [...baseCols, ...sensitivePatch.cols];
    const vals = [...baseVals, ...sensitivePatch.values];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const ins = await client.query(
      `INSERT INTO tickets (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`,
      vals
    );
    const ticketId = ins.rows[0].id;

    // Contacts.
    if (Array.isArray(scheduleRow.contact_ids) && scheduleRow.contact_ids.length) {
      for (const cid of scheduleRow.contact_ids) {
        await client.query(
          `INSERT INTO ticket_contacts (ticket_id, contact_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [ticketId, cid]
        ).catch(() => {});
      }
    }

    // Creator follows their template's ticket. Assignee too (mirrors
    // the manual-create path). Pre-pinned followers from the schedule
    // get added on top — admins set these so e.g. a "weekly server
    // patch review" template auto-loops the ops manager every fire
    // without re-adding them.
    const followerSet = new Set();
    if (submitterId) followerSet.add(Number(submitterId));
    if (scheduleRow.assigned_to) followerSet.add(Number(scheduleRow.assigned_to));
    if (Array.isArray(scheduleRow.follower_ids)) {
      for (const fid of scheduleRow.follower_ids) {
        const n = Number(fid);
        if (Number.isInteger(n) && n > 0) followerSet.add(n);
      }
    }
    for (const fid of followerSet) {
      await client.query(
        `INSERT INTO ticket_followers (ticket_id, user_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [ticketId, fid]
      ).catch(() => {});
    }

    // SLA policy (best effort — non-fatal if it falls through).
    try {
      await sla.applyPolicyOnCreate(client, {
        ticketId,
        priority,
        projectId: scheduleRow.project_id,
      });
    } catch (err) {
      console.warn('ticket_schedules: sla apply failed:', err.message);
    }

    // Attach the schedule's runbook (if set + still a runbook). Same
    // shape as POST /api/kb/tickets/:id/runbook-runs so the audit
    // trail (start_at / started_by + step_states) lines up with the
    // manual-attach path. Failure here is non-fatal — we don't want
    // a missing/converted KB article to block the ticket fire.
    if (scheduleRow.runbook_article_id) {
      try {
        const art = await client.query(
          `SELECT id FROM kb_articles WHERE id = $1 AND kind = 'runbook'`,
          [scheduleRow.runbook_article_id]
        );
        if (art.rows[0]) {
          await client.query(
            `INSERT INTO ticket_runbook_runs (ticket_id, article_id, started_by)
             VALUES ($1, $2, $3)
             ON CONFLICT (ticket_id, article_id) DO NOTHING`,
            [ticketId, art.rows[0].id, submitterId]
          );
        }
      } catch (err) {
        console.warn('ticket_schedules: runbook attach failed:', err.message);
      }
    }

    return ticketId;
  });
  // Note: description-side @mentions intentionally do NOT fire on
  // scheduled creation. Templates that mention users would page the
  // same crew on every fire — noise. Mentions in *comments* posted
  // against the fired ticket (e.g. via a canned close response) still
  // route through the normal comment-mention fanout.
}

// One scheduler poll. Fires every schedule whose next_fire_at <=
// NOW(), logs the run, advances next_fire_at OR disables the schedule
// if exhausted. Concurrency is sequential — recurring tickets fire
// rarely (daily/weekly mostly) so we don't need a worker pool.
async function tick() {
  const now = new Date();
  const due = await pool.query(
    `SELECT * FROM ticket_schedules
      WHERE enabled = TRUE
        AND next_fire_at IS NOT NULL
        AND next_fire_at <= NOW()
      ORDER BY next_fire_at ASC
      LIMIT 100`
  );
  let fired = 0;
  for (const row of due.rows) {
    // Decrypt the row in place so fireSchedule sees plaintext title /
    // description. The DB always reads the _enc column when standard
    // mode is on; decryptRow handles either mode.
    await decryptRow('ticket_schedules', row).catch(() => {});
    let ticketId = null;
    let status = 'ok';
    let error = null;
    try {
      ticketId = await fireSchedule(row);
      fired++;
    } catch (err) {
      status = 'error';
      error = err.message || String(err);
      console.error(`ticket_schedules: fire ${row.id} failed:`, error);
    }

    await pool.query(
      `INSERT INTO ticket_schedule_runs (schedule_id, fired_at, ticket_id, status, error_message)
       VALUES ($1, NOW(), $2, $3, $4)`,
      [row.id, ticketId, status, error ? String(error).slice(0, 500) : null]
    ).catch(() => {});

    // Advance state. Even on error we move next_fire_at forward so
    // we don't busy-loop on a permanently broken template — the
    // run row records the failure so the admin can see + fix.
    const nextFiresCount = row.fires_count + 1;
    const endCountHit = row.end_kind === 'count'
      && row.end_count
      && nextFiresCount >= row.end_count;

    let nextFireAt = null;
    let stillEnabled = !endCountHit;
    if (stillEnabled) {
      try {
        nextFireAt = computeNextFire(row.cron_expr, row.timezone, now, {
          endKind: row.end_kind,
          endDate: row.end_date,
        });
        if (!nextFireAt) stillEnabled = false; // end_date exhausted
      } catch (err) {
        console.error(`ticket_schedules: computeNext for ${row.id} failed:`, err.message);
        stillEnabled = false;
      }
    }

    await pool.query(
      `UPDATE ticket_schedules
          SET fires_count = $1,
              last_fired_at = NOW(),
              next_fire_at = $2,
              enabled = $3,
              updated_at = NOW()
        WHERE id = $4`,
      [nextFiresCount, nextFireAt, stillEnabled, row.id]
    ).catch((err) => console.error('ticket_schedules: state advance failed:', err.message));
  }

  await pool.query(
    `UPDATE system_jobs SET last_run_at = NOW(), last_status = 'ok',
            metadata = jsonb_build_object('fired', $1::int)
      WHERE name = 'ticket_schedule_tick'`,
    [fired]
  ).catch(() => {});

  return { fired };
}

let _interval = null;
function startScheduler() {
  if (_interval) return;
  _interval = setInterval(() => {
    tick().catch(err => console.error('ticket_schedule tick error:', err.message));
  }, 60 * 1000);
  tick().catch(() => {});
}

module.exports = {
  presetToCron,
  normaliseToCron,
  computeNextFire,
  describeCron,
  fireSchedule,
  tick,
  startScheduler,
};

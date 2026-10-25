// Technician time tracking — timers, work logs, and the warn scheduler.
// Policy decisions live in timeTrackingRules.js; this file is the
// Postgres side.
//
// Work notes default to private: they land as a ticket_notes row
// (handler-only, never sent outbound). Public entries post a regular
// thread comment instead. Visibility never sets `billable` — that flag
// (default from the admin's billable_by_default, off unless turned on)
// is the sole input a future accounting export (Xero / QuickBooks)
// should read, so making a note public never puts it on an invoice.
// Billable minutes come from the admin's billing rules applied to the
// logged minutes (see computeBillable); logged minutes never change.

const { pool } = require('../db/pool');
const { buildWritePatch, decryptRow, decryptRows } = require('./fields');
const { createNotification } = require('./notifications');
const { auditLog } = require('./ticketHelpers');
const rules = require('./timeTrackingRules');

const TICK_MS = 5 * 60 * 1000;
let _interval = null;

function httpError(status, message) {
  return Object.assign(new Error(message), { httpStatus: status });
}

async function getSettings(db = pool) {
  const r = await db.query('SELECT * FROM time_tracking_settings WHERE id = 1');
  return { ...rules.DEFAULT_SETTINGS, ...(r.rows[0] || {}) };
}

async function patchSettings(body) {
  const patch = rules.cleanSettingsPatch(body || {});
  const keys = Object.keys(patch);
  if (keys.length) {
    const sets = keys.map((k, i) => `${k} = $${i + 1}`);
    sets.push('updated_at = NOW()');
    await pool.query(
      `UPDATE time_tracking_settings SET ${sets.join(', ')} WHERE id = 1`,
      keys.map((k) => patch[k])
    );
  }
  return getSettings();
}

function presentTimer(row, now = new Date()) {
  if (!row) return null;
  return {
    id: row.id,
    ticket_id: row.ticket_id,
    started_at: row.started_at,
    running: !!row.running_since,
    running_since: row.running_since,
    accumulated_seconds: row.accumulated_seconds,
    elapsed_seconds: rules.elapsedSeconds(row, now),
    auto_started: row.auto_started,
    start_trigger: row.start_trigger,
    status_at_start: row.status_at_start,
    pause_reason: row.pause_reason || null,
    warned_at: row.warned_at,
    ...(row.internal_ref !== undefined ? { internal_ref: row.internal_ref, title: row.title } : {}),
  };
}

async function getTimer(db, userId, ticketId) {
  const r = await db.query(
    'SELECT * FROM ticket_timers WHERE user_id = $1 AND ticket_id = $2',
    [userId, ticketId]
  );
  return r.rows[0] || null;
}

async function loadTicket(db, ticketId) {
  const r = await db.query(
    `SELECT t.id, t.internal_ref, t.title, t.title_enc, t.project_id, t.assigned_to,
            t.submitted_by, t.internal_status, s.is_terminal
       FROM tickets t
  LEFT JOIN statuses s ON s.kind = 'internal' AND s.name = t.internal_status
      WHERE t.id = $1`,
    [ticketId]
  );
  return r.rows[0] || null;
}

// Bank the live seconds of every running timer for this user except
// `exceptTicketId`. One clock runs at a time per tech.
async function pauseOthers(db, userId, exceptTicketId) {
  await db.query(
    `UPDATE ticket_timers
        SET accumulated_seconds = accumulated_seconds
              + GREATEST(0, EXTRACT(EPOCH FROM (NOW() - running_since)))::int,
            running_since = NULL,
            pause_reason = 'switched'
      WHERE user_id = $1 AND ticket_id <> $2 AND running_since IS NOT NULL`,
    [userId, exceptTicketId]
  );
}

async function startTimer({ userId, ticketId, auto = false, trigger = 'manual' }) {
  const settings = await getSettings();
  if (!settings.enabled) throw httpError(409, 'Time tracking is turned off');
  const ticket = await loadTicket(pool, ticketId);
  if (!ticket) throw httpError(404, 'Ticket not found');

  const existing = await getTimer(pool, userId, ticketId);
  if (auto) {
    // An existing timer (paused or running) means the tech already has
    // a clock on this ticket — never auto-resume a deliberate pause.
    if (existing) return { timer: presentTimer(existing), started: false, reason: 'exists' };
    const others = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ticket_timers
        WHERE ticket_id = $1 AND user_id <> $2 AND running_since IS NOT NULL`,
      [ticketId, userId]
    );
    const decision = rules.autoStartDecision({
      settings, trigger, ticket, userId,
      othersRunning: others.rows[0].n,
      isTerminal: !!ticket.is_terminal,
    });
    if (!decision.start) return { timer: null, started: false, reason: decision.reason };
  }

  await pauseOthers(pool, userId, ticketId);
  let row;
  if (existing) {
    const r = await pool.query(
      `UPDATE ticket_timers
          SET running_since = COALESCE(running_since, NOW()), pause_reason = NULL
        WHERE id = $1 RETURNING *`,
      [existing.id]
    );
    row = r.rows[0];
  } else {
    const r = await pool.query(
      `INSERT INTO ticket_timers
         (user_id, ticket_id, running_since, auto_started, start_trigger, status_at_start)
       VALUES ($1, $2, NOW(), $3, $4, $5)
       ON CONFLICT (user_id, ticket_id)
         DO UPDATE SET running_since = COALESCE(ticket_timers.running_since, NOW()),
                       pause_reason = NULL
       RETURNING *`,
      [userId, ticketId, !!auto, auto ? trigger : 'manual', ticket.internal_status]
    );
    row = r.rows[0];
  }
  return { timer: presentTimer(row), started: true };
}

async function pauseTimer({ userId, ticketId }) {
  const r = await pool.query(
    `UPDATE ticket_timers
        SET accumulated_seconds = accumulated_seconds
              + GREATEST(0, EXTRACT(EPOCH FROM (NOW() - running_since)))::int,
            running_since = NULL,
            pause_reason = NULL
      WHERE user_id = $1 AND ticket_id = $2 AND running_since IS NOT NULL
      RETURNING *`,
    [userId, ticketId]
  );
  return presentTimer(r.rows[0] || await getTimer(pool, userId, ticketId));
}

async function discardTimer({ userId, ticketId }) {
  const r = await pool.query(
    'DELETE FROM ticket_timers WHERE user_id = $1 AND ticket_id = $2',
    [userId, ticketId]
  );
  return r.rowCount > 0;
}

// A ticket moved into a hold / resolved / terminal status: pause every
// running timer on it, stamping the status as the reason. Runs inside
// the caller's status-change transaction. Never resumes anything.
async function pauseForStatus(client, { ticketId, statusName, tag, isTerminal }) {
  if (!rules.pausesTimers({ tag, isTerminal })) return 0;
  const r = await client.query(
    `UPDATE ticket_timers
        SET accumulated_seconds = accumulated_seconds
              + GREATEST(0, EXTRACT(EPOCH FROM (NOW() - running_since)))::int,
            running_since = NULL,
            pause_reason = $2
      WHERE ticket_id = $1 AND running_since IS NOT NULL`,
    [ticketId, `status:${statusName}`]
  );
  return r.rowCount;
}

// Called when the tech navigates away from (or closes) a ticket. Applies
// the discard-untouched rule; otherwise the timer keeps running — techs
// often leave the page to do the actual work.
async function leaveTicket({ userId, ticketId }) {
  const timer = await getTimer(pool, userId, ticketId);
  if (!timer) return { state: 'none' };
  const settings = await getSettings();
  const ticket = await loadTicket(pool, ticketId);
  if (ticket && rules.shouldDiscardOnLeave({ settings, timer, currentStatus: ticket.internal_status })) {
    await discardTimer({ userId, ticketId });
    return { state: 'discarded' };
  }
  return { state: timer.running_since ? 'running' : 'paused', timer: presentTimer(timer) };
}

async function listUserTimers(userId) {
  const r = await pool.query(
    `SELECT tt.*, t.internal_ref, t.title, t.title_enc
       FROM ticket_timers tt
       JOIN tickets t ON t.id = tt.ticket_id
      WHERE tt.user_id = $1
      ORDER BY tt.running_since DESC NULLS LAST, tt.started_at DESC`,
    [userId]
  );
  await decryptRows('tickets', r.rows);
  const now = new Date();
  return r.rows.map((row) => presentTimer(row, now));
}

function linkedBody(note, minutes) {
  return `${note}\n\n_⏱ ${rules.formatDuration(minutes)} logged_`;
}

async function insertRow(client, table, base, enc) {
  const patch = await buildWritePatch(client, table, enc);
  const cols = [...Object.keys(base), ...patch.cols];
  const values = [...Object.values(base), ...patch.values];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const r = await client.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id, created_at`,
    values
  );
  return r.rows[0];
}

// Log work. Any two of startedAt / endedAt / minutes fix the third
// (minutes alone ends the entry now). `fromTimer` consumes the tech's
// timer on this ticket. The stored start is always end − duration, so a
// timer that was paused along the way logs the time actually worked.
async function logWork({ user, ticketId, minutes, startedAt, endedAt, note, visibility, fromTimer }) {
  const settings = await getSettings();
  if (!settings.enabled) throw httpError(409, 'Time tracking is turned off');
  const times = rules.resolveEntryTimes({ startedAt, endedAt, minutes });
  if (times.error) throw httpError(400, times.error);
  const clean = rules.validateEntry({ minutes: times.minutes, note }, settings);
  if (clean.error) throw httpError(400, clean.error);
  const vis = rules.resolveVisibility({ settings, role: user.role, requested: visibility });

  const client = await pool.connect();
  let entryId;
  let commentId = null;
  try {
    await client.query('BEGIN');
    let source = 'manual';
    if (fromTimer) {
      const t = await client.query(
        'DELETE FROM ticket_timers WHERE user_id = $1 AND ticket_id = $2',
        [user.id, ticketId]
      );
      if (t.rowCount) source = 'timer';
    }

    let noteId = null;
    const body = linkedBody(clean.note, clean.minutes);
    if (vis === 'private') {
      noteId = (await insertRow(client, 'ticket_notes', { ticket_id: ticketId, user_id: user.id }, { body })).id;
    } else {
      commentId = (await insertRow(
        client, 'comments',
        { ticket_id: ticketId, user_id: user.id, is_external_visible: false },
        { body }
      )).id;
    }

    const entry = await insertRow(client, 'time_entries', {
      ticket_id: ticketId,
      user_id: user.id,
      started_at: times.startedAt,
      ended_at: times.endedAt,
      duration_minutes: clean.minutes,
      visibility: vis,
      billable: !!settings.billable_by_default,
      source,
      ticket_note_id: noteId,
      comment_id: commentId,
    }, { note: clean.note });
    entryId = entry.id;

    await client.query('UPDATE tickets SET updated_at = NOW() WHERE id = $1', [ticketId]);
    await auditLog(client, {
      ticketId, userId: user.id, action: 'time_logged',
      newValue: `${rules.formatDuration(clean.minutes)} (${vis})`,
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // A public entry is a real reply on the thread: notify followers and
  // stop the SLA response clock like any handler comment. Best-effort.
  if (commentId) {
    try {
      const ticket = await loadTicket(pool, ticketId);
      await decryptRow('tickets', ticket);
      const { fanoutNewComment } = require('./notificationFanout');
      await fanoutNewComment(pool, {
        ticket,
        comment: linkedBody(clean.note, clean.minutes),
        commentId,
        actorId: user.id,
        actorName: user.displayName || user.email,
      });
      await require('./sla').markResponded(null, ticketId);
    } catch (err) {
      console.error('time entry public fanout:', err.message);
    }
  }
  return getEntry(entryId);
}

async function getEntry(entryId) {
  const r = await pool.query(
    `SELECT e.*, u.display_name AS user_name, u.email AS user_email
       FROM time_entries e
  LEFT JOIN users u ON u.id = e.user_id
      WHERE e.id = $1`,
    [entryId]
  );
  if (!r.rows[0]) return null;
  await decryptRow('time_entries', r.rows[0]);
  delete r.rows[0].note_enc;
  return r.rows[0];
}

async function listEntries(ticketId) {
  const r = await pool.query(
    `SELECT e.*, u.display_name AS user_name, u.email AS user_email
       FROM time_entries e
  LEFT JOIN users u ON u.id = e.user_id
      WHERE e.ticket_id = $1
      ORDER BY e.created_at ASC`,
    [ticketId]
  );
  await decryptRows('time_entries', r.rows);
  const bill = rules.computeBillable(r.rows, await getSettings());
  const totals = {
    minutes: 0, private_minutes: 0, public_minutes: 0,
    // Raw logged minutes on billable entries, then what the billing rules
    // make of them: per-session rounding/minimums, plus any ticket-
    // minimum top-up, summing to billable_minutes.
    billable_logged_minutes: 0,
    billable_session_minutes: bill.sessions,
    billable_topup_minutes: bill.topUp,
    billable_minutes: bill.total,
  };
  for (const row of r.rows) {
    delete row.note_enc;
    row.billable_minutes = bill.perEntry[row.id];
    totals.minutes += row.duration_minutes;
    totals[`${row.visibility}_minutes`] += row.duration_minutes;
    if (row.billable) totals.billable_logged_minutes += row.duration_minutes;
  }
  return { entries: r.rows, totals };
}

// Edit times / note (author or Admin/Manager) and billable (Admin/
// Manager only). Visibility is fixed once logged — a public comment may
// already have reached people, so flipping it would be misleading.
// The linked private note is kept in step; a linked public comment is
// left alone (it was distributed as written).
async function updateEntry({ user, ticketId, entryId, body }) {
  const existing = await getEntry(entryId);
  if (!existing || existing.ticket_id !== ticketId) throw httpError(404, 'Entry not found');
  const isPriv = ['Admin', 'Manager'].includes(user.role);
  if (existing.user_id !== user.id && !isPriv) {
    throw httpError(403, 'Only the author, Admin, or Manager can edit this entry');
  }
  if (existing.invoiced_at) throw httpError(409, 'Entry is already invoiced');
  if (body.visibility !== undefined && body.visibility !== existing.visibility) {
    throw httpError(400, 'Visibility cannot change after logging — delete and re-log instead');
  }
  if (body.billable !== undefined && !isPriv) {
    throw httpError(403, 'Only Admin or Manager can mark time billable');
  }

  const settings = await getSettings();
  // Same triangle as logging. Two or more given → solve from those. One
  // given → keep the existing start (for a new duration) or the existing
  // duration (for a new start or end).
  const given = {
    startedAt: body.started_at,
    endedAt: body.ended_at,
    minutes: body.minutes,
  };
  const count = Object.values(given).filter((v) => v !== undefined).length;
  let input = given;
  if (count === 0) {
    input = { startedAt: existing.started_at, minutes: existing.duration_minutes };
  } else if (count === 1) {
    input = given.minutes !== undefined
      ? { startedAt: existing.started_at, minutes: given.minutes }
      : { ...given, minutes: existing.duration_minutes };
  }
  // Legacy rows may lack a start; anchor on created_at then.
  if (input.startedAt === null) input = { endedAt: existing.ended_at || existing.created_at, minutes: input.minutes };
  const times = rules.resolveEntryTimes(input);
  if (times.error) throw httpError(400, times.error);
  const clean = rules.validateEntry({
    minutes: times.minutes,
    note: body.note !== undefined ? body.note : existing.note,
  }, settings);
  if (clean.error) throw httpError(400, clean.error);

  const patch = await buildWritePatch(pool, 'time_entries', { note: clean.note });
  const cols = ['duration_minutes', 'started_at', 'ended_at', ...patch.cols];
  const values = [clean.minutes, times.startedAt, times.endedAt, ...patch.values];
  if (body.billable !== undefined) { cols.push('billable'); values.push(!!body.billable); }
  const sets = cols.map((c, i) => `${c} = $${i + 1}`);
  sets.push('edited_at = NOW()');
  values.push(entryId);
  await pool.query(`UPDATE time_entries SET ${sets.join(', ')} WHERE id = $${values.length}`, values);

  if (existing.ticket_note_id) {
    const np = await buildWritePatch(pool, 'ticket_notes', { body: linkedBody(clean.note, clean.minutes) });
    const nsets = np.cols.map((c, i) => `${c} = $${i + 1}`);
    nsets.push('edited_at = NOW()');
    await pool.query(
      `UPDATE ticket_notes SET ${nsets.join(', ')} WHERE id = $${np.values.length + 1}`,
      [...np.values, existing.ticket_note_id]
    );
  }
  return getEntry(entryId);
}

async function deleteEntry({ user, ticketId, entryId }) {
  const existing = await getEntry(entryId);
  if (!existing || existing.ticket_id !== ticketId) throw httpError(404, 'Entry not found');
  if (existing.user_id !== user.id && user.role !== 'Admin') {
    throw httpError(403, 'Only the author or an Admin can delete this entry');
  }
  if (existing.invoiced_at) throw httpError(409, 'Entry is already invoiced');
  await pool.query('DELETE FROM time_entries WHERE id = $1', [entryId]);
  if (existing.ticket_note_id) {
    await pool.query('DELETE FROM ticket_notes WHERE id = $1', [existing.ticket_note_id]);
  }
  await auditLog(pool, {
    ticketId, userId: user.id, action: 'time_entry_deleted',
    oldValue: `${rules.formatDuration(existing.duration_minutes)} (${existing.visibility})`,
  });
  return { ok: true, kept_comment: !!existing.comment_id };
}

// Warn techs whose clock has run past the threshold with nothing logged.
// One in-app notification per timer; logging work deletes the timer so a
// fresh one can warn again.
async function tick() {
  const settings = await getSettings();
  if (!settings.enabled || !settings.warn_after_minutes) return;
  const r = await pool.query(
    `SELECT tt.*, t.internal_ref
       FROM ticket_timers tt
       JOIN tickets t ON t.id = tt.ticket_id
      WHERE tt.running_since IS NOT NULL AND tt.warned_at IS NULL`
  );
  const now = new Date();
  for (const timer of r.rows) {
    if (!rules.needsWarning({ settings, timer, now })) continue;
    const mins = Math.floor(rules.elapsedSeconds(timer, now) / 60);
    try {
      await createNotification(pool, {
        userId: timer.user_id,
        type: 'time_tracking_warning',
        title: `Timer on ${timer.internal_ref} has run ${rules.formatDuration(mins)} with no work logged`,
        body: 'Log what you did, pause it, or discard it.',
        data: { ticket_id: timer.ticket_id },
      });
      await pool.query('UPDATE ticket_timers SET warned_at = NOW() WHERE id = $1', [timer.id]);
    } catch (err) {
      console.error('time tracking warn:', err.message);
    }
  }
}

function startScheduler() {
  if (_interval) return;
  _interval = setInterval(() => { tick().catch((e) => console.error('time tracking tick:', e.message)); }, TICK_MS);
}

module.exports = {
  getSettings,
  patchSettings,
  startTimer,
  pauseTimer,
  pauseForStatus,
  discardTimer,
  leaveTicket,
  listUserTimers,
  getTimer: (userId, ticketId) => getTimer(pool, userId, ticketId).then((t) => presentTimer(t)),
  logWork,
  listEntries,
  updateEntry,
  deleteEntry,
  tick,
  startScheduler,
};

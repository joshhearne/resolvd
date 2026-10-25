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

function httpError(status, message, extra) {
  return Object.assign(new Error(message), { httpStatus: status, extra });
}

// --- Work types ---------------------------------------------------------

async function listWorkTypes({ includeInactive = false } = {}) {
  const r = await pool.query(
    `SELECT id, name, billable, active, sort_order
       FROM time_work_types
      ${includeInactive ? '' : 'WHERE active = TRUE'}
      ORDER BY sort_order, lower(name)`
  );
  return r.rows;
}

function cleanWorkType(body, partial) {
  const out = {};
  if (body.name !== undefined || !partial) {
    const name = String(body.name || '').trim();
    if (!name) throw httpError(400, 'Name is required');
    if (name.length > 60) throw httpError(400, 'Name is too long');
    out.name = name;
  }
  for (const k of ['billable', 'active']) {
    if (body[k] !== undefined) {
      if (typeof body[k] !== 'boolean') throw httpError(400, `${k} must be true or false`);
      out[k] = body[k];
    }
  }
  if (body.sort_order !== undefined) {
    const n = Number(body.sort_order);
    if (!Number.isInteger(n)) throw httpError(400, 'sort_order must be a whole number');
    out.sort_order = n;
  }
  return out;
}

async function createWorkType(body) {
  const v = cleanWorkType(body || {}, false);
  const r = await pool.query(
    `INSERT INTO time_work_types (name, billable, active, sort_order)
     VALUES ($1, $2, COALESCE($3, TRUE), COALESCE($4, 0)) RETURNING *`,
    [v.name, !!v.billable, v.active ?? null, v.sort_order ?? null]
  );
  return r.rows[0];
}

async function updateWorkType(id, body) {
  const v = cleanWorkType(body || {}, true);
  const keys = Object.keys(v);
  if (!keys.length) throw httpError(400, 'Nothing to update');
  const r = await pool.query(
    `UPDATE time_work_types SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}
      WHERE id = $${keys.length + 1} RETURNING *`,
    [...keys.map((k) => v[k]), id]
  );
  if (!r.rows[0]) throw httpError(404, 'Work type not found');
  return r.rows[0];
}

// A type already used on entries is retired (inactive) rather than
// deleted, so past entries and exports keep their label.
async function deleteWorkType(id) {
  const used = await pool.query('SELECT 1 FROM time_entries WHERE work_type_id = $1 LIMIT 1', [id]);
  if (used.rows[0]) {
    await pool.query('UPDATE time_work_types SET active = FALSE WHERE id = $1', [id]);
    return { retired: true };
  }
  const r = await pool.query('DELETE FROM time_work_types WHERE id = $1', [id]);
  if (!r.rowCount) throw httpError(404, 'Work type not found');
  return { deleted: true };
}

async function resolveWorkType(id) {
  if (id == null || id === '') return null;
  const r = await pool.query('SELECT * FROM time_work_types WHERE id = $1', [Number(id)]);
  if (!r.rows[0] || !r.rows[0].active) throw httpError(400, 'Work type not found');
  return r.rows[0];
}

// The tech's other entries (any ticket) overlapping [start, end).
async function findOverlaps(userId, start, end, excludeId = null) {
  const r = await pool.query(
    `SELECT e.id, e.ticket_id, e.started_at, e.ended_at, t.internal_ref
       FROM time_entries e
       JOIN tickets t ON t.id = e.ticket_id
      WHERE e.user_id = $1
        AND e.started_at < $3 AND e.ended_at > $2
        AND ($4::int IS NULL OR e.id <> $4)
      ORDER BY e.started_at
      LIMIT 10`,
    [userId, start, end, excludeId]
  );
  return r.rows;
}

async function guardOverlap({ settings, userId, times, excludeId, confirmed }) {
  const overlaps = await findOverlaps(userId, times.startedAt, times.endedAt, excludeId);
  const d = rules.overlapDecision({ settings, overlaps, confirmed });
  if (d.ok) return;
  const msg = d.code === 'overlap_blocked'
    ? 'This overlaps time you already logged'
    : 'This overlaps time you already logged — confirm to save anyway';
  throw httpError(409, msg, { code: d.code, overlaps });
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
async function logWork({ user, ticketId, minutes, startedAt, endedAt, note, visibility, fromTimer, workTypeId, confirmOverlap }) {
  const settings = await getSettings();
  if (!settings.enabled) throw httpError(409, 'Time tracking is turned off');
  const times = rules.resolveEntryTimes({ startedAt, endedAt, minutes });
  if (times.error) throw httpError(400, times.error);
  const clean = rules.validateEntry({ minutes: times.minutes, note }, settings);
  if (clean.error) throw httpError(400, clean.error);
  const vis = rules.resolveVisibility({ settings, role: user.role, requested: visibility });
  const workType = await resolveWorkType(workTypeId);
  await guardOverlap({ settings, userId: user.id, times, confirmed: confirmOverlap === true });

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
      // The work type's default wins; otherwise the org default.
      billable: workType ? workType.billable : !!settings.billable_by_default,
      work_type_id: workType ? workType.id : null,
      billing_rules: JSON.stringify(rules.billingRulesSnapshot(settings)),
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
  // A prepaid block may have just crossed its alert line.
  require('./billing').checkBlockAlertsForTicket(ticketId);
  return getEntry(entryId);
}

async function getEntry(entryId) {
  const r = await pool.query(
    `SELECT e.*, u.display_name AS user_name, u.email AS user_email, wt.name AS work_type_name
       FROM time_entries e
  LEFT JOIN users u ON u.id = e.user_id
  LEFT JOIN time_work_types wt ON wt.id = e.work_type_id
      WHERE e.id = $1`,
    [entryId]
  );
  if (!r.rows[0]) return null;
  await decryptRow('time_entries', r.rows[0]);
  delete r.rows[0].note_enc;
  return r.rows[0];
}

// `viewer` ({ id, role }) lets each row carry `locked`: true when the
// timesheet lock stops this viewer editing or deleting it.
async function listEntries(ticketId, viewer = null) {
  const r = await pool.query(
    `SELECT e.*, u.display_name AS user_name, u.email AS user_email, wt.name AS work_type_name
       FROM time_entries e
  LEFT JOIN users u ON u.id = e.user_id
  LEFT JOIN time_work_types wt ON wt.id = e.work_type_id
      WHERE e.ticket_id = $1
      ORDER BY e.created_at ASC`,
    [ticketId]
  );
  await decryptRows('time_entries', r.rows);
  const settings = await getSettings();
  const tz = (await require('./branding').getBranding().catch(() => null))?.timezone || 'UTC';
  const bill = rules.computeBillable(r.rows, settings, { tz });
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
    const priv = viewer && ['Admin', 'Manager'].includes(viewer.role);
    row.locked = !!row.invoiced_at ||
      (!!row.approved_at && !priv) ||
      (viewer ? rules.isEditLocked({ entry: row, settings, role: viewer.role }) : false);
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
  const settings = await getSettings();
  if (rules.isEditLocked({ entry: existing, settings, role: user.role })) {
    throw httpError(403, `Entries older than ${settings.edit_lock_days} days are locked — ask an Admin or Manager`);
  }
  if (existing.approved_at && !isPriv) {
    throw httpError(403, 'Approved time is locked — ask an Admin or Manager');
  }
  if (body.billable !== undefined && !isPriv) {
    throw httpError(403, 'Only Admin or Manager can mark time billable');
  }

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
  const moved = times.startedAt.getTime() !== new Date(existing.started_at).getTime() ||
    times.endedAt.getTime() !== new Date(existing.ended_at).getTime();
  if (moved) {
    await guardOverlap({
      settings, userId: existing.user_id, times, excludeId: existing.id,
      confirmed: body.confirm_overlap === true,
    });
  }
  let workTypeId;
  // Only validate a change: an entry may keep a type that has since been
  // retired.
  if (body.work_type_id !== undefined && (body.work_type_id ?? null) !== (existing.work_type_id ?? null)) {
    workTypeId = body.work_type_id === null ? null : (await resolveWorkType(body.work_type_id)).id;
  }
  const clean = rules.validateEntry({
    minutes: times.minutes,
    note: body.note !== undefined ? body.note : existing.note,
  }, settings);
  if (clean.error) throw httpError(400, clean.error);

  const patch = await buildWritePatch(pool, 'time_entries', { note: clean.note });
  const cols = ['duration_minutes', 'started_at', 'ended_at', ...patch.cols];
  const values = [clean.minutes, times.startedAt, times.endedAt, ...patch.values];
  if (body.billable !== undefined) { cols.push('billable'); values.push(!!body.billable); }
  if (workTypeId !== undefined) { cols.push('work_type_id'); values.push(workTypeId); }
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
  const settings = await getSettings();
  if (rules.isEditLocked({ entry: existing, settings, role: user.role })) {
    throw httpError(403, `Entries older than ${settings.edit_lock_days} days are locked — ask an Admin or Manager`);
  }
  if (existing.approved_at && !['Admin', 'Manager'].includes(user.role)) {
    throw httpError(403, 'Approved time is locked — ask an Admin or Manager');
  }
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

// CSV of time entries that ended in [from, to). Billable minutes use the
// current rules, computed per ticket over the entries in the range (so a
// ticket minimum applies once per ticket per export). Ticket-minimum
// top-ups get their own row so they can become their own invoice line.
async function exportCsv({ from, to, approvedOnly = false }) {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw httpError(400, 'Give a valid from / to range');
  }
  if (end - start > 366 * 86400000) throw httpError(400, 'Range is limited to one year');
  const r = await pool.query(
    `SELECT e.*, u.display_name AS user_name, u.email AS user_email, wt.name AS work_type_name,
            t.internal_ref, t.title, t.title_enc, p.name AS project_name
       FROM time_entries e
       JOIN tickets t ON t.id = e.ticket_id
  LEFT JOIN projects p ON p.id = t.project_id
  LEFT JOIN users u ON u.id = e.user_id
  LEFT JOIN time_work_types wt ON wt.id = e.work_type_id
      WHERE e.ended_at >= $1 AND e.ended_at < $2
        ${approvedOnly ? 'AND e.approved_at IS NOT NULL' : ''}
      ORDER BY t.internal_ref, e.created_at`,
    [start, end]
  );
  await decryptRows('time_entries', r.rows);
  await decryptRows('tickets', r.rows);
  const settings = await getSettings();
  const branding = await require('./branding').getBranding().catch(() => null);
  const tz = branding?.timezone || 'UTC';
  const msp = branding?.enable_customer_companies === true;
  const byTicket = new Map();
  for (const row of r.rows) {
    if (!byTicket.has(row.ticket_id)) byTicket.set(row.ticket_id, []);
    byTicket.get(row.ticket_id).push(row);
  }
  const inRange = new Set(r.rows.map((e) => e.id));
  const c = rules.csvCell;
  const money = (cents) => (cents == null ? '' : (cents / 100).toFixed(2));

  // MSP mode: price through rate cards + contracts (whole tickets, so
  // ticket minimums and prepaid blocks resolve as on the ticket) and add
  // the columns an accounting import needs. Otherwise minutes only.
  let priced = null;
  let customerNames = {};
  if (msp && byTicket.size) {
    priced = await require('./billing').priceTickets([...byTicket.keys()], { tz });
    const ids = [...new Set(Object.values(priced.customers).filter(Boolean))];
    if (ids.length) {
      const cr = await pool.query('SELECT id, name, name_enc FROM companies WHERE id = ANY($1::int[])', [ids]);
      await decryptRows('companies', cr.rows);
      customerNames = Object.fromEntries(cr.rows.map((x) => [x.id, x.name]));
    }
  }

  const head = ['Ticket', 'Title', 'Project', 'Technician', 'Work type', 'Start', 'End',
    'Logged minutes', 'Billable', 'Billable minutes', 'Visibility', 'Approved', 'Invoiced', 'Note'];
  if (priced) {
    head.push('Customer', 'Contract', 'Contract ref', 'Bill type', 'Bill type code', 'Rate card',
      'Hours', 'Coverage', 'Covered minutes', 'Rate', 'Amount', 'Currency');
  }
  const lines = [head.map(c).join(',')];
  const pricedCols = (ticketId, line) => (priced ? [
    c(customerNames[priced.customers[ticketId]] || ''), c(line?.contract_name), c(line?.contract_ref),
    c(line?.billing_type), c(line?.billing_type_code), c(line?.rate_card),
    c(line?.hours_class), c(line?.coverage), line?.covered_minutes ?? '',
    money(line?.rate_cents), money(line?.amount_cents), c(settings.billing_currency),
  ] : []);
  for (const [ticketId, rows] of byTicket) {
    const bill = rules.computeBillable(rows, settings, { tz });
    for (const e of rows) {
      const line = priced?.byEntry[e.id];
      lines.push([
        c(e.internal_ref), c(e.title), c(e.project_name), c(e.user_name || e.user_email),
        c(e.work_type_name), c(new Date(e.started_at).toISOString()), c(new Date(e.ended_at).toISOString()),
        e.duration_minutes, c(e.billable ? 'yes' : 'no'), line ? line.billable_minutes : bill.perEntry[e.id],
        c(e.visibility), c(e.approved_at ? new Date(e.approved_at).toISOString() : ''),
        c(e.invoiced_at ? new Date(e.invoiced_at).toISOString() : ''), c(e.note),
        ...pricedCols(ticketId, line || (e.billable ? null : { coverage: 'non_billable' })),
      ].join(','));
    }
    const topUps = priced
      ? (priced.topUps[ticketId] || []).filter((t) => inRange.has(t.anchor_entry_id))
      : bill.topUps;
    for (const t of topUps) {
      const first = rows[0];
      lines.push([
        c(first.internal_ref), c(first.title), c(first.project_name), '', c('Ticket minimum'), '', '',
        0, c('yes'), priced ? t.billable_minutes : t.minutes, '', '', '',
        c(`Top-up to the ${settings.billing_ticket_minimum}-minute ticket minimum${t.key && t.key !== 'ticket' ? ` (${t.key})` : ''}`),
        ...pricedCols(ticketId, priced ? t : null),
      ].join(','));
    }
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

// One tech's entries that ended in [from, to), newest first, with ticket
// ref/title. Grouping by day/week is left to the client (its timezone).
async function timesheet({ userId, from, to }) {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw httpError(400, 'Give a valid from / to range');
  }
  if (end - start > 92 * 86400000) throw httpError(400, 'Range is limited to 92 days');
  const r = await pool.query(
    `SELECT e.id, e.ticket_id, e.started_at, e.ended_at, e.duration_minutes, e.visibility,
            e.billable, e.approved_at, e.invoiced_at, e.note, e.note_enc,
            wt.name AS work_type_name, t.internal_ref, t.title, t.title_enc
       FROM time_entries e
       JOIN tickets t ON t.id = e.ticket_id
  LEFT JOIN time_work_types wt ON wt.id = e.work_type_id
      WHERE e.user_id = $1 AND e.ended_at >= $2 AND e.ended_at < $3
      ORDER BY e.started_at DESC`,
    [userId, start, end]
  );
  await decryptRows('time_entries', r.rows);
  await decryptRows('tickets', r.rows);
  for (const row of r.rows) { delete row.note_enc; delete row.title_enc; }
  const u = await pool.query('SELECT id, display_name, email FROM users WHERE id = $1', [userId]);
  return { user: u.rows[0] || null, entries: r.rows };
}

module.exports = {
  timesheet,
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
  listWorkTypes,
  createWorkType,
  updateWorkType,
  deleteWorkType,
  exportCsv,
  deleteEntry,
  tick,
  startScheduler,
};

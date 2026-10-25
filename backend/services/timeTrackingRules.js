// Pure policy helpers for technician time tracking. No DB access so the
// rules can be unit-tested directly; services/timeTracking.js wires them
// to Postgres.

const DISCARD_MODES = ['off', 'auto_started', 'all'];
const VISIBILITIES = ['private', 'public'];
const VISIBILITY_CHOICE = ['admins', 'handlers'];
const PRIV_ROLES = new Set(['Admin', 'Manager']);

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  auto_start_on_take: true,
  auto_start_on_open: false,
  discard_untouched: 'auto_started',
  warn_after_minutes: 30,
  default_visibility: 'private',
  visibility_choice: 'admins',
  min_note_chars: 10,
  billable_by_default: false,
  billing_round_increment: 1,
  billing_round_mode: 'up',
  billing_session_minimum: 0,
  billing_ticket_minimum: 0,
  overlap_policy: 'warn',
  billing_reprice: 'uninvoiced',
  billing_ticket_minimum_scope: 'ticket',
  billing_require_approval: false,
  billing_currency: 'USD',
  edit_lock_days: 0,
});

const OVERLAP_POLICIES = ['allow', 'warn', 'block'];
const REPRICE_MODES = ['uninvoiced', 'at_log'];
const MINIMUM_SCOPES = ['ticket', 'day'];
const BILLING_RULE_KEYS = ['billing_round_increment', 'billing_round_mode', 'billing_session_minimum', 'billing_ticket_minimum'];

const ROUND_INCREMENTS = [1, 5, 6, 10, 15, 30];
const ROUND_MODES = ['up', 'nearest', 'down'];

// Seconds on the clock right now. Paused timers (running_since NULL)
// report only what they banked.
function elapsedSeconds(timer, now = new Date()) {
  if (!timer) return 0;
  const banked = Number(timer.accumulated_seconds) || 0;
  if (!timer.running_since) return banked;
  const since = new Date(timer.running_since).getTime();
  const live = Math.max(0, Math.floor((now.getTime() - since) / 1000));
  return banked + live;
}

// Whole minutes to suggest when logging from a timer. Anything under a
// minute rounds up to one so a quick fix still logs; otherwise nearest.
function suggestedMinutes(seconds) {
  if (seconds <= 0) return 0;
  return Math.max(1, Math.round(seconds / 60));
}

// Should an auto-start fire? `trigger` is 'take' (tech assigned the
// ticket to themselves) or 'open' (tech opened the ticket). "Solo"
// means nobody else is on it: the ticket is unassigned or assigned to
// this tech, and no other user has a running timer on it.
function autoStartDecision({ settings, trigger, ticket, userId, othersRunning, isTerminal }) {
  if (!settings?.enabled) return { start: false, reason: 'disabled' };
  if (trigger === 'take' && !settings.auto_start_on_take) return { start: false, reason: 'off' };
  if (trigger === 'open' && !settings.auto_start_on_open) return { start: false, reason: 'off' };
  if (trigger !== 'take' && trigger !== 'open') return { start: false, reason: 'bad_trigger' };
  if (isTerminal) return { start: false, reason: 'terminal' };
  if (ticket.assigned_to != null && Number(ticket.assigned_to) !== Number(userId)) {
    return { start: false, reason: 'assigned_elsewhere' };
  }
  if (othersRunning > 0) return { start: false, reason: 'not_solo' };
  return { start: true };
}

// When a timer is abandoned (tech leaves the ticket, or starts another
// one) without logging work, does the discard-untouched rule throw it
// away? Only when the ticket status hasn't moved since the timer began.
function shouldDiscardOnLeave({ settings, timer, currentStatus }) {
  const mode = settings?.discard_untouched || 'off';
  if (mode === 'off') return false;
  if (mode === 'auto_started' && !timer.auto_started) return false;
  return (timer.status_at_start || null) === (currentStatus || null);
}

// Warn when the clock has run past the threshold with nothing logged.
// A threshold of 0 turns the warning off.
function needsWarning({ settings, timer, now = new Date() }) {
  const mins = Number(settings?.warn_after_minutes) || 0;
  if (mins <= 0 || !timer?.running_since || timer.warned_at) return false;
  return elapsedSeconds(timer, now) >= mins * 60;
}

// Statuses that pause every running timer on the ticket: the SLA's
// hold tags (waiting on the requester / a vendor, internal hold), plus
// resolved and terminal states. Nothing ever auto-resumes — a reply on
// a held ticket doesn't put the clock back on; the tech does.
const TIMER_PAUSE_TAGS = new Set(['awaiting_input', 'on_hold', 'resolved_pending_close']);

function pausesTimers({ tag, isTerminal }) {
  return !!isTerminal || TIMER_PAUSE_TAGS.has(tag);
}

// Start, end and duration are a triangle: any two fix the third.
// Accepts any two or all three (all three must agree to within a
// minute); with only minutes, the entry ends now. Returns
// { startedAt, endedAt, minutes } or { error }.
const FUTURE_SLACK_MS = 5 * 60 * 1000;
function resolveEntryTimes({ startedAt, endedAt, minutes, now = new Date() }) {
  const toDate = (v) => {
    if (v == null || v === '') return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  };
  let start = toDate(startedAt);
  let end = toDate(endedAt);
  if (start === undefined) return { error: 'Start time is invalid' };
  if (end === undefined) return { error: 'End time is invalid' };
  let mins = minutes == null || minutes === '' ? null : Number(minutes);
  if (mins != null && (!Number.isInteger(mins) || mins <= 0)) {
    return { error: 'Minutes must be a whole number above zero' };
  }

  if (start && end) {
    const span = Math.round((end - start) / 60000);
    if (mins != null && Math.abs((end - start) / 1000 - mins * 60) > 60) {
      return { error: 'Start, end and duration do not agree' };
    }
    mins = mins ?? span;
  } else if (start && mins != null) {
    end = new Date(start.getTime() + mins * 60000);
  } else if (end && mins != null) {
    start = new Date(end.getTime() - mins * 60000);
  } else if (mins != null) {
    end = now;
    start = new Date(now.getTime() - mins * 60000);
  } else {
    return { error: 'Give two of start, end and duration' };
  }

  if (end <= start || mins <= 0) return { error: 'End must be after start' };
  if (end.getTime() > now.getTime() + FUTURE_SLACK_MS) return { error: 'End time is in the future' };
  return { startedAt: start, endedAt: end, minutes: mins };
}

function canChooseVisibility(settings, role) {
  if (PRIV_ROLES.has(role)) return true;
  return settings?.visibility_choice === 'handlers';
}

// Requested visibility is honoured only when the user may choose;
// everyone else gets the org default.
function resolveVisibility({ settings, role, requested }) {
  const fallback = settings?.default_visibility === 'public' ? 'public' : 'private';
  if (!VISIBILITIES.includes(requested)) return fallback;
  return canChooseVisibility(settings, role) ? requested : fallback;
}

function formatDuration(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return `${r}m`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

// Validate a work-log submission. Returns { error } or the cleaned
// { minutes, note }.
function validateEntry({ minutes, note }, settings) {
  const n = Number(minutes);
  if (!Number.isInteger(n) || n <= 0) return { error: 'Minutes must be a whole number above zero' };
  if (n > 24 * 60) return { error: 'A single entry cannot exceed 24 hours' };
  const text = String(note || '').trim();
  const min = Math.max(1, Number(settings?.min_note_chars) || 1);
  if (text.length < min) {
    return { error: `Describe the work done (at least ${min} character${min === 1 ? '' : 's'})` };
  }
  if (text.length > 8000) return { error: 'Note is too long' };
  return { minutes: n, note: text };
}

// Validate an admin PATCH. Unknown keys are ignored; bad values throw a
// 400-flavoured error.
function cleanSettingsPatch(body) {
  const out = {};
  const bad = (msg) => { throw Object.assign(new Error(msg), { httpStatus: 400 }); };
  for (const key of ['enabled', 'auto_start_on_take', 'auto_start_on_open']) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== 'boolean') bad(`${key} must be true or false`);
      out[key] = body[key];
    }
  }
  if (body.discard_untouched !== undefined) {
    if (!DISCARD_MODES.includes(body.discard_untouched)) bad('discard_untouched is invalid');
    out.discard_untouched = body.discard_untouched;
  }
  if (body.default_visibility !== undefined) {
    if (!VISIBILITIES.includes(body.default_visibility)) bad('default_visibility is invalid');
    out.default_visibility = body.default_visibility;
  }
  if (body.visibility_choice !== undefined) {
    if (!VISIBILITY_CHOICE.includes(body.visibility_choice)) bad('visibility_choice is invalid');
    out.visibility_choice = body.visibility_choice;
  }
  if (body.warn_after_minutes !== undefined) {
    const n = Number(body.warn_after_minutes);
    if (!Number.isInteger(n) || n < 0 || n > 24 * 60) bad('warn_after_minutes must be 0–1440');
    out.warn_after_minutes = n;
  }
  if (body.min_note_chars !== undefined) {
    const n = Number(body.min_note_chars);
    if (!Number.isInteger(n) || n < 1 || n > 500) bad('min_note_chars must be 1–500');
    out.min_note_chars = n;
  }
  if (body.billable_by_default !== undefined) {
    if (typeof body.billable_by_default !== 'boolean') bad('billable_by_default must be true or false');
    out.billable_by_default = body.billable_by_default;
  }
  if (body.billing_round_increment !== undefined) {
    const n = Number(body.billing_round_increment);
    if (!ROUND_INCREMENTS.includes(n)) bad(`billing_round_increment must be one of ${ROUND_INCREMENTS.join(', ')}`);
    out.billing_round_increment = n;
  }
  if (body.billing_round_mode !== undefined) {
    if (!ROUND_MODES.includes(body.billing_round_mode)) bad('billing_round_mode is invalid');
    out.billing_round_mode = body.billing_round_mode;
  }
  if (body.overlap_policy !== undefined) {
    if (!OVERLAP_POLICIES.includes(body.overlap_policy)) bad('overlap_policy is invalid');
    out.overlap_policy = body.overlap_policy;
  }
  if (body.billing_ticket_minimum_scope !== undefined) {
    if (!MINIMUM_SCOPES.includes(body.billing_ticket_minimum_scope)) bad('billing_ticket_minimum_scope is invalid');
    out.billing_ticket_minimum_scope = body.billing_ticket_minimum_scope;
  }
  if (body.billing_require_approval !== undefined) {
    if (typeof body.billing_require_approval !== 'boolean') bad('billing_require_approval must be true or false');
    out.billing_require_approval = body.billing_require_approval;
  }
  if (body.billing_currency !== undefined) {
    const c = String(body.billing_currency || '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) bad('billing_currency must be a 3-letter code, e.g. USD');
    out.billing_currency = c;
  }
  if (body.billing_reprice !== undefined) {
    if (!REPRICE_MODES.includes(body.billing_reprice)) bad('billing_reprice is invalid');
    out.billing_reprice = body.billing_reprice;
  }
  if (body.edit_lock_days !== undefined) {
    const n = Number(body.edit_lock_days);
    if (!Number.isInteger(n) || n < 0 || n > 365) bad('edit_lock_days must be 0–365');
    out.edit_lock_days = n;
  }
  for (const key of ['billing_session_minimum', 'billing_ticket_minimum']) {
    if (body[key] !== undefined) {
      const n = Number(body[key]);
      if (!Number.isInteger(n) || n < 0 || n > 8 * 60) bad(`${key} must be 0–480`);
      out[key] = n;
    }
  }
  return out;
}

// Timesheet lock: once an entry ended more than edit_lock_days ago, only
// Admin/Manager may change or delete it. 0 = never locks.
function isEditLocked({ entry, settings, role, now = new Date() }) {
  if (['Admin', 'Manager'].includes(role)) return false;
  const days = Number(settings?.edit_lock_days) || 0;
  if (days <= 0) return false;
  const end = new Date(entry.ended_at || entry.created_at);
  return now.getTime() - end.getTime() > days * 86400000;
}

// Overlap check outcome for a new/edited entry. `overlaps` are the
// tech's other entries whose [start, end) intersects this one.
function overlapDecision({ settings, overlaps, confirmed }) {
  const policy = settings?.overlap_policy || 'warn';
  if (!overlaps.length || policy === 'allow') return { ok: true };
  if (policy === 'block') return { ok: false, code: 'overlap_blocked' };
  return confirmed ? { ok: true } : { ok: false, code: 'overlap_confirm' };
}

// Spreadsheet-safe CSV cell: quoted, quotes doubled, and a leading
// = + - @ (or tab/CR) neutralised so a note can't run as a formula when
// the export is opened in Excel / Sheets.
function csvCell(v) {
  if (v == null) return '';
  let t = String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return `"${t.replace(/"/g, '""')}"`;
}

// --- Billable hours ----------------------------------------------------
// Billing rules never touch what was logged: duration_minutes stays the
// time actually worked. Billable minutes are derived, for entries
// flagged billable only:
//   1. each session rounds to the increment (up / nearest / down),
//   2. then is raised to the per-session minimum,
//   3. the ticket's billable total is raised to the per-ticket minimum
//      (the difference is reported as a separate top-up so invoices can
//      show it as its own line).
// Computed on read, so a rule change re-prices everything not yet
// invoiced; an invoicing export must snapshot the result.

function roundSession(minutes, increment, mode) {
  const inc = Number(increment) || 1;
  if (inc <= 1) return minutes;
  const q = minutes / inc;
  const n = mode === 'down' ? Math.floor(q) : mode === 'nearest' ? Math.round(q) : Math.ceil(q);
  return n * inc;
}

function billableSessionMinutes(minutes, settings) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const rounded = roundSession(Math.max(0, Number(minutes) || 0), s.billing_round_increment, s.billing_round_mode);
  return Math.max(rounded, Number(s.billing_session_minimum) || 0);
}

// entries: [{ id, duration_minutes, billable }]. Returns per-entry
// billable minutes (0 for non-billable), the session sum, the ticket
// minimum top-up, and the ticket total.
// The billing rules in force right now, stored on each entry as it's
// logged (time_entries.billing_rules).
function billingRulesSnapshot(settings) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  return Object.fromEntries(BILLING_RULE_KEYS.map((k) => [k, s[k]]));
}

// billing_reprice decides which rules price an entry:
//   'uninvoiced' (default) — current rules for everything not invoiced;
//   'at_log' — each entry's own snapshot (current rules if it has none).
// In 'at_log' the ticket minimum comes from the first billable entry's
// snapshot, i.e. the rules when billable work on the ticket began.
// Entries are expected in logged order.
// YYYY-MM-DD of `date` in `tz` (falls back to UTC on a bad zone).
function localDay(date, tz) {
  const d = new Date(date);
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

// The ticket minimum applies once per ticket (default) or once per day
// of work on it (billing_ticket_minimum_scope = 'day', days in `tz`) —
// for tickets that run across several visits. `topUps` lists each
// group's top-up and the entry it anchors to (the group's first
// billable entry), so pricing can rate it like that entry.
function computeBillable(entries, settings, { tz } = {}) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const atLog = s.billing_reprice === 'at_log';
  const rulesFor = (e) => (atLog && e.billing_rules ? { ...s, ...e.billing_rules } : s);
  const byDay = s.billing_ticket_minimum_scope === 'day';
  const perEntry = {};
  const groups = new Map();
  let sessions = 0;
  for (const e of entries) {
    if (!e.billable) { perEntry[e.id] = 0; continue; }
    const m = billableSessionMinutes(e.duration_minutes, rulesFor(e));
    perEntry[e.id] = m;
    sessions += m;
    const key = byDay ? localDay(e.started_at || e.created_at, tz) : 'ticket';
    if (!groups.has(key)) groups.set(key, { key, first: e, minutes: 0 });
    groups.get(key).minutes += m;
  }
  const topUps = [];
  for (const g of groups.values()) {
    const floor = Number(rulesFor(g.first).billing_ticket_minimum) || 0;
    const minutes = Math.max(0, floor - g.minutes);
    if (minutes > 0) topUps.push({ key: g.key, minutes, anchorId: g.first.id });
  }
  const topUp = topUps.reduce((a, t) => a + t.minutes, 0);
  return { perEntry, sessions, topUp, topUps, total: sessions + topUp };
}

module.exports = {
  DEFAULT_SETTINGS,
  elapsedSeconds,
  suggestedMinutes,
  autoStartDecision,
  shouldDiscardOnLeave,
  needsWarning,
  pausesTimers,
  resolveEntryTimes,
  canChooseVisibility,
  resolveVisibility,
  formatDuration,
  roundSession,
  isEditLocked,
  overlapDecision,
  csvCell,
  billableSessionMinutes,
  computeBillable,
  localDay,
  billingRulesSnapshot,
  validateEntry,
  cleanSettingsPatch,
};

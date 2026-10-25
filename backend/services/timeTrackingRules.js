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
});

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
  return out;
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
  validateEntry,
  cleanSettingsPatch,
};

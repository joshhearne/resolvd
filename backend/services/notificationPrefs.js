// Shared constants for the notifications matrix. Imported by the schema
// migration, the prefs API defaults, the fanout module, and the outbox
// flusher so the event/channel/cadence vocabulary lives in one place.

const EVENT_TYPES = [
  'assignment',
  'mention',
  'comment',
  'status_change',
  'pending_review',
  'follow_up',
];

// Server-side override: regardless of stored prefs, these events always
// fire on in_app + email. Push remains opt-in. Reflects "locked-on"
// rows in the matrix UI.
const LOCKED_ON = new Set(['pending_review', 'follow_up']);

const CADENCES = ['instant', 'hourly', '12h', 'daily', 'off'];

// Default matrix applied to new users + backfilled into existing
// users.preferences during migration. Sensible new defaults — no
// legacy fold. In-app + email on for everything; push only for mention.
const DEFAULT_NOTIFICATION_PREFS = Object.freeze({
  assignment:     { in_app: true, email: true,  push: false },
  mention:        { in_app: true, email: true,  push: true  },
  comment:        { in_app: true, email: true,  push: false },
  status_change:  { in_app: true, email: true,  push: false },
  pending_review: { in_app: true, email: true,  push: false },
  follow_up:      { in_app: true, email: true,  push: false },
});

const DEFAULT_EMAIL_DIGEST = 'instant';

// Apply defaults + LOCKED_ON override. Always returns a complete
// {in_app,email,push} cell — callers don't need to null-check.
function effectiveMatrix(prefsBlob, eventType) {
  const stored = (prefsBlob && prefsBlob.notification_prefs) || {};
  const row = stored[eventType] || DEFAULT_NOTIFICATION_PREFS[eventType] || {};
  const def = DEFAULT_NOTIFICATION_PREFS[eventType] || { in_app: false, email: false, push: false };
  const cell = {
    in_app: row.in_app === undefined ? def.in_app : !!row.in_app,
    email:  row.email  === undefined ? def.email  : !!row.email,
    push:   row.push   === undefined ? def.push   : !!row.push,
  };
  if (LOCKED_ON.has(eventType)) {
    cell.in_app = true;
    cell.email = true;
  }
  return cell;
}

function digestCadence(prefsBlob) {
  const v = prefsBlob && prefsBlob.email_digest;
  return CADENCES.includes(v) ? v : DEFAULT_EMAIL_DIGEST;
}

module.exports = {
  EVENT_TYPES,
  LOCKED_ON,
  CADENCES,
  DEFAULT_NOTIFICATION_PREFS,
  DEFAULT_EMAIL_DIGEST,
  effectiveMatrix,
  digestCadence,
};

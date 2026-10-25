// Billable-hours maths for the admin preview. Mirrors
// backend/services/timeTrackingRules.js (roundSession /
// billableSessionMinutes / computeBillable) — the server is the source
// of truth; keep the two in step.

export function roundSession(minutes, increment, mode) {
  const inc = Number(increment) || 1;
  if (inc <= 1) return minutes;
  const q = minutes / inc;
  const n = mode === "down" ? Math.floor(q) : mode === "nearest" ? Math.round(q) : Math.ceil(q);
  return n * inc;
}

export function billableSessionMinutes(minutes, s) {
  const rounded = roundSession(Math.max(0, Number(minutes) || 0), s.billing_round_increment, s.billing_round_mode);
  return Math.max(rounded, Number(s.billing_session_minimum) || 0);
}

// sessions: array of logged minutes (all treated as billable).
export function previewBillable(sessions, s) {
  const per = sessions.map((m) => billableSessionMinutes(m, s));
  const total = per.reduce((a, b) => a + b, 0);
  const floor = sessions.length ? Number(s.billing_ticket_minimum) || 0 : 0;
  const topUp = Math.max(0, floor - total);
  return { per, sessions: total, topUp, total: total + topUp };
}

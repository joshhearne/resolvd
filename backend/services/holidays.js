// Holiday rules for business-hours policies. Pure — shared by the SLA
// clock (businessHours.js), billing's hours classes (billingRules.js) and
// the holiday calendar feed (routes/calendar.js).
//
// A holiday row is one of:
//   { kind: 'date', date: 'YYYY-MM-DD', recurring }
//       a calendar date; recurring repeats the month/day every year
//   { kind: 'nth_weekday', month: 1-12, weekday: 0-6 (Sun..Sat),
//     nth: 1-5 | -1 (last) }
//       "the 4th Thursday of November", "the last Monday of May" — every
//       year (a 5th that doesn't exist in a given month is skipped)
// Either may set observed: a holiday landing on Saturday is taken the
// Friday before, one on Sunday the Monday after.
//
// Either may also set:
//   span_days: 1-14  — closed this many consecutive days from the date it's
//                      taken (Thanksgiving Thu + Fri = 4th Thursday, 2 days)
//   closes_at: 'HH:MM' — a partial day: open as normal until this local
//                      time, closed after (an early out). Single-day only.
//
// Callers match local calendar parts in the policy's tz. Date math here is on calendar dates only (Date.UTC
// arithmetic), never wall-clock instants.

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

function weekdayOf(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// Calendar date shifted by `days` → [y, m, d].
function shiftDate(y, m, d, days) {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}

// Day of month of the nth weekday, or null when it doesn't exist.
function nthWeekdayDay(y, m, weekday, nth) {
  if (nth === -1) {
    const last = daysInMonth(y, m);
    return last - ((weekdayOf(y, m, last) - weekday + 7) % 7);
  }
  const first = 1 + ((weekday - weekdayOf(y, m, 1) + 7) % 7);
  const day = first + (nth - 1) * 7;
  return day <= daysInMonth(y, m) ? day : null;
}

const MAX_SPAN = 14;
const spanOf = (h) => (h.span_days == null ? 1 : Number(h.span_days));
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function validRule(h) {
  if (!h) return false;
  const span = spanOf(h);
  if (!Number.isInteger(span) || span < 1 || span > MAX_SPAN) return false;
  if (h.closes_at != null) {
    if (!TIME_RE.test(String(h.closes_at)) || span !== 1) return false;
  }
  if ((h.kind || 'date') === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(String(h.date || ''));
  return h.kind === 'nth_weekday'
    && Number.isInteger(h.month) && h.month >= 1 && h.month <= 12
    && Number.isInteger(h.weekday) && h.weekday >= 0 && h.weekday <= 6
    && [1, 2, 3, 4, 5, -1].includes(h.nth);
}

// The actual (unshifted) date this rule falls on in `year`, or null.
function actualDate(h, year) {
  if ((h.kind || 'date') === 'date') {
    const [y, m, d] = String(h.date).split('-').map(Number);
    if (!h.recurring) return y === year ? [y, m, d] : null;
    // Feb 29 recurring: only in leap years.
    return d <= daysInMonth(year, m) ? [year, m, d] : null;
  }
  const d = nthWeekdayDay(year, h.month, h.weekday, h.nth);
  return d ? [year, h.month, d] : null;
}

function observedDate([y, m, d]) {
  const wd = weekdayOf(y, m, d);
  if (wd === 6) return shiftDate(y, m, d, -1);
  if (wd === 0) return shiftDate(y, m, d, 1);
  return [y, m, d];
}

// Occurrences for a set of rules between two years inclusive, by the
// date they're taken (the first day of a span). [{ date, actual, last,
// holiday }], sorted by date; `last` is the final closed day (= date for
// a single day). An observed shift can cross a year boundary (Sat Jan 1
// → Fri Dec 31), so neighbouring years are computed and filtered.
function occurrences(holidays, fromYear, toYear) {
  const out = [];
  for (const h of holidays || []) {
    if (!validRule(h)) continue;
    for (let y = fromYear - 1; y <= toYear + 1; y++) {
      const actual = actualDate(h, y);
      if (!actual) continue;
      const taken = h.observed ? observedDate(actual) : actual;
      if (taken[0] < fromYear || taken[0] > toYear) continue;
      const last = shiftDate(...taken, spanOf(h) - 1);
      out.push({ date: iso(...taken), actual: iso(...actual), last: iso(...last), holiday: h });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// (year, month, day) → null (open) | { closesAt: null } (closed all day)
// | { closesAt: 'HH:MM' } (early close). Where rules overlap, a whole day
// beats an early close and the earlier close wins. Cached per year.
function holidayClosures(holidays) {
  const rules = (holidays || []).filter(validRule);
  if (!rules.length) return () => null;
  const byYear = new Map();
  const build = (year) => {
    const days = new Map();
    // Spans that start late in the previous year can run into this one.
    for (const o of occurrences(rules, year - 1, year)) {
      const [y, m, d] = o.date.split('-').map(Number);
      for (let i = 0; i < spanOf(o.holiday); i++) {
        const day = iso(...shiftDate(y, m, d, i));
        if (Number(day.slice(0, 4)) !== year) continue;
        const closesAt = o.holiday.closes_at || null;
        const prev = days.get(day);
        if (!prev) days.set(day, { closesAt });
        else if (prev.closesAt && (!closesAt || closesAt < prev.closesAt)) prev.closesAt = closesAt;
      }
    }
    return days;
  };
  return (year, month, day) => {
    if (!byYear.has(year)) byYear.set(year, build(year));
    return byYear.get(year).get(iso(year, month, day)) || null;
  };
}

// (year, month, day) → closed all day? (Early-close days are open.)
function holidayMatcher(holidays) {
  const closure = holidayClosures(holidays);
  return (year, month, day) => {
    const c = closure(year, month, day);
    return !!c && !c.closesAt;
  };
}

// Start date of the next (or current, for a span under way) occurrence
// of the rule, 'YYYY-MM-DD', or null.
function nextOccurrence(h, today) {
  const year = Number(String(today).slice(0, 4));
  const hit = occurrences([h], year - 1, year + 1).find((o) => o.last >= today);
  return hit ? hit.date : null;
}

const ORDINALS = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th', '-1': 'last' };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

// "4th Thursday of November", "Every December 25", "2026-06-08", plus
// " · 2 days" for a span or " · closes 12:00" for an early close.
function describeRule(h) {
  let base;
  if (h.kind === 'nth_weekday') base = `${ORDINALS[h.nth]} ${WEEKDAYS[h.weekday]} of ${MONTHS[h.month - 1]}`;
  else {
    const d = String(h.date || '');
    base = h.recurring ? `Every ${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}` : d;
  }
  if (spanOf(h) > 1) return `${base} · ${spanOf(h)} days`;
  if (h.closes_at) return `${base} · closes ${h.closes_at}`;
  return base;
}

module.exports = {
  holidayMatcher, holidayClosures, occurrences, nextOccurrence, describeRule, validRule, nthWeekdayDay, MAX_SPAN,
};

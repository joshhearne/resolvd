// Helpers for time-entry forms: forgiving time-of-day parsing and the
// start / duration / end "triangle" solve.

// Parse what a tech types into a time field. Accepts "8:30", "830",
// "8.30p", "8p", "20:30", "8:30 am", etc. A trailing a/am/p/pm sets the
// meridiem; without one, 13–23 and 0 read as 24-hour and 1–12 keep
// `pmDefault` (the field's current AM/PM). Returns { h, m } in 24-hour
// time, or null.
export function parseTimeOfDay(text, pmDefault = false) {
  let s = String(text || "").trim().toLowerCase().replace(/\s+/g, "");
  if (!s) return null;
  let mer = null;
  const mm = s.match(/(a|am|p|pm)$/);
  if (mm) {
    mer = mm[1][0];
    s = s.slice(0, -mm[1].length);
  }
  let h;
  let m = 0;
  const sep = s.match(/^(\d{1,2})[:.](\d{1,2})$/);
  if (sep) {
    h = Number(sep[1]);
    m = Number(sep[2]);
  } else if (/^\d{1,4}$/.test(s)) {
    if (s.length <= 2) h = Number(s);
    else if (s.length === 3) { h = Number(s[0]); m = Number(s.slice(1)); }
    else { h = Number(s.slice(0, 2)); m = Number(s.slice(2)); }
  } else {
    return null;
  }
  if (m < 0 || m > 59) return null;
  if (mer) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (mer === "p" ? 12 : 0);
  } else if (h === 0 || (h >= 13 && h <= 23)) {
    // 24-hour input; use as-is.
  } else if (h >= 1 && h <= 12) {
    h = (h % 12) + (pmDefault ? 12 : 0);
  } else {
    return null;
  }
  return { h, m };
}

// `prev` moved to h:m on whichever of its own day / the day before /
// the day after lands closest to it. Keeps "11:50 PM" yesterday from
// jumping a day ahead when a tech nudges it.
export function withTimeOfDay(prev, h, m) {
  const base = new Date(prev);
  let best = null;
  // Same day first so a tie (an AM/PM flip is exactly 12h either way)
  // stays on the day the tech was looking at.
  for (const offset of [0, -1, 1]) {
    const c = new Date(base);
    c.setDate(c.getDate() + offset);
    c.setHours(h, m, 0, 0);
    if (!best || Math.abs(c - base) < Math.abs(best - base)) best = c;
  }
  return best;
}

export function isPm(date) {
  return new Date(date).getHours() >= 12;
}

export function formatTime(date) {
  const d = new Date(date);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h % 12 || 12}:${m} ${h >= 12 ? "PM" : "AM"}`;
}

export function sameDay(a, b) {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

export function formatShortDate(date) {
  return new Date(date).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

// yyyy-mm-dd in local time, for <input type="date">.
export function toDateInput(date) {
  const d = new Date(date);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// --- Triangle solve -------------------------------------------------
// values: { start: Date, end: Date, minutes: number }
// order:  the three keys, least recently edited first. The first one is
//         the piece that gets recomputed from the other two.

export const TRIANGLE_KEYS = ["start", "end", "minutes"];

export function touch(order, key) {
  return [...order.filter((k) => k !== key), key];
}

export function solve(values, order) {
  const { start, end, minutes } = values;
  switch (order[0]) {
    case "start":
      return { ...values, start: new Date(new Date(end).getTime() - minutes * 60000) };
    case "end":
      return { ...values, end: new Date(new Date(start).getTime() + minutes * 60000) };
    default:
      return { ...values, minutes: Math.round((new Date(end) - new Date(start)) / 60000) };
  }
}

// Apply one edit and re-solve. Returns { values, order }.
export function editTriangle(values, order, key, value) {
  const nextOrder = touch(order, key);
  return { values: solve({ ...values, [key]: value }, nextOrder), order: nextOrder };
}

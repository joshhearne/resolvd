// Business hours math for SLA clocks. A bh policy is { tz, days[],
// start_time 'HH:MM', end_time 'HH:MM', enabled }. addBusinessMinutes()
// walks a starting Date forward across allowed weekday windows. When
// the policy is missing / disabled, callers fall back to wall-clock
// math (existing pre-A3 behavior).
//
// DST: the tz-offset is recomputed per iteration, so a window that
// straddles a transition shifts naturally. Edge accuracy across DST
// boundaries is within one hour of expected.

const { pool } = require('../db/pool');

// Resolve the bh policy for a (project_id, fallback) pair. Returns the
// project row when present + enabled; else the org default; else null.
async function policyFor(client, projectId) {
  const db = client || pool;
  if (projectId) {
    const r = await db.query(
      `SELECT * FROM business_hours_policies
        WHERE project_id = $1 AND enabled = TRUE`,
      [projectId]
    );
    if (r.rows[0]) return r.rows[0];
  }
  const def = await db.query(
    `SELECT * FROM business_hours_policies
      WHERE project_id IS NULL AND enabled = TRUE`
  );
  return def.rows[0] || null;
}

// Resolve the bh policy referenced directly by an sla_policy row.
// sla_policies.business_hours_id points to a specific bh row; NULL
// means "ignore business hours, run 24/7".
async function policyById(client, id) {
  if (!id) return null;
  const r = await (client || pool).query(
    `SELECT * FROM business_hours_policies WHERE id = $1 AND enabled = TRUE`,
    [id]
  );
  return r.rows[0] || null;
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function partsInTz(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short', hour12: false,
  });
  const out = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type === 'year') out.year = Number(p.value);
    else if (p.type === 'month') out.month = Number(p.value);
    else if (p.type === 'day') out.day = Number(p.value);
    else if (p.type === 'hour') out.hour = Number(p.value) % 24;
    else if (p.type === 'minute') out.minute = Number(p.value);
    else if (p.type === 'second') out.second = Number(p.value);
    else if (p.type === 'weekday') out.weekday = WEEKDAY_INDEX[p.value];
  }
  return out;
}

// UTC Date corresponding to a wall-clock instant in `tz`. Handles
// month/day overflow via Date.UTC's normalization (e.g. day=32 → next
// month's day=1). Two-step: build a naive UTC, measure tz drift, correct.
function utcFromTzWall(tz, year, month, day, hour, minute) {
  const naive = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const localOfNaive = partsInTz(naive, tz);
  const naiveOfLocal = Date.UTC(
    localOfNaive.year,
    localOfNaive.month - 1,
    localOfNaive.day,
    localOfNaive.hour,
    localOfNaive.minute
  );
  return new Date(naive.getTime() + (naive.getTime() - naiveOfLocal));
}

function parseTime(str) {
  const [h, m] = String(str || '00:00').split(':').map(Number);
  return { hour: h || 0, minute: m || 0 };
}

// Add `minutes` of business time to `start`. Returns a UTC Date. When
// `bh` is null / disabled / malformed, falls back to wall-clock add so
// the caller doesn't need separate branches.
function addBusinessMinutes(start, minutes, bh) {
  const startDate = start instanceof Date ? new Date(start) : new Date(start);
  if (!bh || !bh.enabled || minutes <= 0) {
    return new Date(startDate.getTime() + minutes * 60_000);
  }
  const allowedDays = new Set((bh.days || []).map(Number));
  const tStart = parseTime(bh.start_time);
  const tEnd = parseTime(bh.end_time);
  const startTotal = tStart.hour * 60 + tStart.minute;
  const endTotal = tEnd.hour * 60 + tEnd.minute;
  const windowMin = endTotal - startTotal;
  if (!allowedDays.size || windowMin <= 0) {
    return new Date(startDate.getTime() + minutes * 60_000);
  }

  let cursor = startDate;
  let remaining = minutes;
  // Hard cap on iterations — enough for ~3 years of pure business-day
  // walk. If we hit this, something is wrong (config corruption).
  for (let i = 0; remaining > 0 && i < 2000; i++) {
    const p = partsInTz(cursor, bh.tz);
    if (!allowedDays.has(p.weekday)) {
      cursor = utcFromTzWall(bh.tz, p.year, p.month, p.day + 1, 0, 0);
      continue;
    }
    const winStart = utcFromTzWall(bh.tz, p.year, p.month, p.day, tStart.hour, tStart.minute);
    const winEnd = utcFromTzWall(bh.tz, p.year, p.month, p.day, tEnd.hour, tEnd.minute);
    if (cursor < winStart) {
      cursor = winStart;
      continue;
    }
    if (cursor >= winEnd) {
      cursor = utcFromTzWall(bh.tz, p.year, p.month, p.day + 1, 0, 0);
      continue;
    }
    const availableMs = winEnd.getTime() - cursor.getTime();
    const availableMin = Math.floor(availableMs / 60_000);
    if (remaining <= availableMin) {
      cursor = new Date(cursor.getTime() + remaining * 60_000);
      remaining = 0;
    } else {
      cursor = winEnd;
      remaining -= availableMin;
    }
  }
  return cursor;
}

module.exports = { addBusinessMinutes, policyFor, policyById };

import { useEffect, useMemo, useState } from "react";
import { api } from "../utils/api";

// Shared pieces for the sidebar calendar widget and the /calendar page:
// event types (label + colour), the remembered type filter, the month
// grid, and fetching events for a month.

// Class names are written out in full so Tailwind keeps them.
export const CAL_TYPES = [
  { key: "sla",         label: "SLA deadlines",  dot: "bg-red-500",     chip: "bg-red-500/15 text-red-700 dark:text-red-300" },
  { key: "due",         label: "Due dates",      dot: "bg-orange-500",  chip: "bg-orange-500/15 text-orange-700 dark:text-orange-300" },
  { key: "followup",    label: "Follow-ups",     dot: "bg-sky-500",     chip: "bg-sky-500/15 text-sky-700 dark:text-sky-300" },
  { key: "task",        label: "My tasks",       dot: "bg-pink-500",    chip: "bg-pink-500/15 text-pink-700 dark:text-pink-300" },
  { key: "maintenance", label: "Maintenance",    dot: "bg-amber-500",   chip: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  { key: "scheduled",   label: "Recurring tickets", dot: "bg-indigo-500", chip: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300" },
  { key: "license",     label: "License renewals", dot: "bg-violet-500", chip: "bg-violet-500/15 text-violet-700 dark:text-violet-300" },
  { key: "holiday",     label: "Holidays",       dot: "bg-emerald-500", chip: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
];
export const CAL_TYPE = Object.fromEntries(CAL_TYPES.map((t) => [t.key, t]));

const FILTER_KEY = "resolvd.calendar.hiddenTypes";

// Types the viewer has switched off, remembered per browser. Shared by
// the widget and the page (both read the same key).
export function useCalendarFilters() {
  const [hidden, setHidden] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem(FILTER_KEY) || "[]")); } catch { return new Set(); }
  });
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== FILTER_KEY) return;
      try { setHidden(new Set(JSON.parse(e.newValue || "[]"))); } catch { /* ignore */ }
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("resolvd:calendar-filters", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("resolvd:calendar-filters", onStorage);
    };
  }, []);
  function toggle(key) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      const value = JSON.stringify([...next]);
      try { localStorage.setItem(FILTER_KEY, value); } catch { /* ignore */ }
      // Let the other calendar on the page (widget ⇄ page) follow along.
      window.dispatchEvent(Object.assign(new Event("resolvd:calendar-filters"), { key: FILTER_KEY, newValue: value }));
      return next;
    });
  }
  return { hidden, toggle };
}

const pad = (n) => String(n).padStart(2, "0");
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const sameMonth = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
export function parseDayKey(k) {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// Six Sunday-first weeks covering the month of `month`.
export function monthGrid(month) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

// An all-day value is a bare YYYY-MM-DD (a calendar date, no time zone);
// anything else is an instant shown in local time.
function toLocal(v) {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return parseDayKey(v);
  return new Date(v);
}

// Local day keys an event covers. All-day ends are exclusive; timed
// events cover every day they touch.
export function eventDays(e) {
  const start = toLocal(e.start);
  let end = e.end ? toLocal(e.end) : start;
  if (e.all_day && e.end) end = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1);
  if (end < start) end = start;
  const days = [];
  const d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  for (let i = 0; i < 62 && d <= end; i += 1) {
    days.push(dayKey(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

export function eventTime(e) {
  if (e.all_day || (typeof e.start === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.start))) return "All day";
  return new Date(e.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// Events for the six-week grid around `month`, bucketed by local day and
// filtered by the hidden types. Refetches when the month changes.
export function useMonthEvents(month, hidden) {
  const grid = useMemo(() => monthGrid(month), [month.getFullYear(), month.getMonth()]); // eslint-disable-line react-hooks/exhaustive-deps
  const [data, setData] = useState({ events: [], types: [] });
  const [loading, setLoading] = useState(true);
  const from = dayKey(grid[0]);
  const lastDay = grid[grid.length - 1];
  const to = dayKey(new Date(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate() + 1));
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.get(`/api/calendar/events?from=${from}&to=${to}`)
      .then((r) => {
        // Never let an unexpected reply take the sidebar down.
        if (alive) setData({ events: Array.isArray(r?.events) ? r.events : [], types: Array.isArray(r?.types) ? r.types : [] });
      })
      .catch(() => { if (alive) setData({ events: [], types: [] }); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [from, to, tick]);

  const byDay = useMemo(() => {
    const m = new Map();
    for (const e of data.events) {
      if (hidden.has(e.type)) continue;
      for (const k of eventDays(e)) {
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(e);
      }
    }
    return m;
  }, [data.events, hidden]);

  return { grid, byDay, types: data.types, loading, reload: () => setTick((n) => n + 1) };
}

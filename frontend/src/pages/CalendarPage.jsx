import React, { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  CAL_TYPE, CAL_TYPES, dayKey, eventTime, parseDayKey, sameMonth, useCalendarFilters, useMonthEvents,
} from "../components/calendarShared";

// Full-page month calendar: the same items and filters as the sidebar
// widget, with titles in each day and the selected day's full list.
// ?date=YYYY-MM-DD picks the day (and month) to show.

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX_IN_CELL = 3;

export default function CalendarPage() {
  const [params, setParams] = useSearchParams();
  const initial = /^\d{4}-\d{2}-\d{2}$/.test(params.get("date") || "") ? params.get("date") : dayKey(new Date());
  const [selected, setSelected] = useState(initial);
  const [month, setMonth] = useState(() => { const d = parseDayKey(initial); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const { hidden, toggle } = useCalendarFilters();
  const { grid, byDay, types, loading } = useMonthEvents(month, hidden);
  const today = dayKey(new Date());

  useEffect(() => {
    const q = params.get("date");
    if (q && q !== selected && /^\d{4}-\d{2}-\d{2}$/.test(q)) {
      setSelected(q);
      const d = parseDayKey(q);
      setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
    }
  }, [params.get("date")]); // eslint-disable-line react-hooks/exhaustive-deps

  function pick(k) {
    setSelected(k);
    const d = parseDayKey(k);
    if (!sameMonth(d, month)) setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
    setParams({ date: k }, { replace: true });
  }
  function shift(n) {
    setMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));
  }

  const typeList = CAL_TYPES.filter((t) => types.includes(t.key));
  const dayItems = byDay.get(selected) || [];

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-fg mb-1">Calendar</h1>
          <p className="text-sm text-fg-muted">
            Your SLA deadlines, due dates, follow-ups and tasks, with maintenance, recurring tickets, license renewals and holidays.{" "}
            <Link to="/account/settings/calendar" className="text-brand hover:underline">Subscribe in Outlook or Google</Link>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => shift(-1)} className="btn btn-secondary btn-sm" aria-label="Previous month">‹</button>
          <button type="button" onClick={() => { const n = new Date(); setMonth(new Date(n.getFullYear(), n.getMonth(), 1)); pick(dayKey(n)); }} className="btn btn-secondary btn-sm">Today</button>
          <button type="button" onClick={() => shift(1)} className="btn btn-secondary btn-sm" aria-label="Next month">›</button>
          <h2 className="text-base font-semibold text-fg min-w-[10rem] text-right">
            {month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
          </h2>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show on calendar">
        {typeList.map((t) => {
          const on = !hidden.has(t.key);
          return (
            <button key={t.key} type="button" onClick={() => toggle(t.key)} aria-pressed={on}
              className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border transition-colors ${
                on ? "border-border-strong bg-surface text-fg" : "border-border bg-surface-2 text-fg-dim line-through"}`}>
              <span className={`w-2 h-2 rounded-full ${on ? t.dot : "bg-fg-dim/40"}`} aria-hidden="true" />
              {t.label}
            </button>
          );
        })}
        {loading && <span className="text-xs text-fg-dim self-center">Loading…</span>}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_18rem] gap-4">
        <section className="bg-surface border border-border rounded-lg overflow-hidden">
          <div className="grid grid-cols-7 bg-surface-2 text-xs text-fg-muted">
            {WEEKDAYS.map((d) => <div key={d} className="px-2 py-1.5 font-medium">{d}</div>)}
          </div>
          <div className="grid grid-cols-7">
            {grid.map((d) => {
              const k = dayKey(d);
              const items = byDay.get(k) || [];
              const inMonth = sameMonth(d, month);
              const isSel = k === selected;
              return (
                <div
                  key={k}
                  role="button"
                  tabIndex={0}
                  onClick={() => pick(k)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(k); } }}
                  aria-label={`${d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}, ${items.length} item${items.length === 1 ? "" : "s"}`}
                  className={`min-h-[6.5rem] border-t border-l border-border p-1.5 text-left cursor-pointer transition-colors ${
                    isSel ? "bg-brand/10" : "hover:bg-surface-2/60"} ${inMonth ? "" : "bg-surface-2/30"}`}
                >
                  <div className="flex justify-end mb-1">
                    <span className={`text-xs w-6 h-6 inline-flex items-center justify-center rounded-full ${
                      k === today ? "bg-brand text-brand-fg font-semibold" : inMonth ? "text-fg" : "text-fg-dim"}`}>
                      {d.getDate()}
                    </span>
                  </div>
                  <div className="space-y-0.5">
                    {items.slice(0, MAX_IN_CELL).map((e) => (
                      <div key={e.id} title={`${eventTime(e)} · ${e.title}`}
                        className={`truncate rounded px-1 py-0.5 text-[11px] leading-tight ${CAL_TYPE[e.type]?.chip}`}>
                        {e.title}
                      </div>
                    ))}
                    {items.length > MAX_IN_CELL && (
                      <div className="text-[11px] text-fg-muted px-1">+{items.length - MAX_IN_CELL} more</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <aside className="bg-surface border border-border rounded-lg p-4 self-start" aria-live="polite">
          <h3 className="text-sm font-semibold text-fg mb-3">
            {parseDayKey(selected).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
          </h3>
          {dayItems.length === 0 ? (
            <p className="text-sm text-fg-dim italic">Nothing scheduled.</p>
          ) : (
            <ul className="space-y-2">
              {dayItems.map((e) => {
                const body = (
                  <>
                    <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${CAL_TYPE[e.type]?.dot}`} aria-hidden="true" />
                    <span className="min-w-0">
                      <span className="block text-sm text-fg break-words">{e.title}</span>
                      <span className="block text-xs text-fg-muted">
                        {eventTime(e)} · {CAL_TYPE[e.type]?.label}
                        {e.meta?.breached && <span className="ml-1 text-red-600 dark:text-red-400 font-medium">breached</span>}
                      </span>
                    </span>
                  </>
                );
                return (
                  <li key={e.id}>
                    {e.link
                      ? <Link to={e.link} className="flex gap-2 rounded-md p-1.5 -m-1.5 hover:bg-surface-2">{body}</Link>
                      : <span className="flex gap-2 p-1.5 -m-1.5">{body}</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}

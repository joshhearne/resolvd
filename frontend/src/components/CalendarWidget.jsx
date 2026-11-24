import React, { useState } from "react";
import { Link } from "react-router-dom";
import {
  CAL_TYPE, CAL_TYPES, dayKey, eventTime, sameMonth, useCalendarFilters, useMonthEvents,
} from "./calendarShared";

// Compact month calendar for the sidebar: coloured dots per day, type
// filters, and the selected day's items (linking through). The full
// view lives at /calendar. Collapsed state is remembered per browser.

const COLLAPSE_KEY = "resolvd.calendar.widgetCollapsed";
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const MAX_DAY_ITEMS = 5;

export default function CalendarWidget() {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { return false; }
  });
  const [month, setMonth] = useState(() => new Date());
  const [selected, setSelected] = useState(() => dayKey(new Date()));
  const [showFilters, setShowFilters] = useState(false);
  const { hidden, toggle } = useCalendarFilters();
  const { grid, byDay, types } = useMonthEvents(month, hidden);
  const today = dayKey(new Date());

  function setCollapsedPersist(v) {
    setCollapsed(v);
    try { localStorage.setItem(COLLAPSE_KEY, v ? "1" : "0"); } catch { /* ignore */ }
  }
  function shift(n) {
    setMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));
  }

  const dayItems = byDay.get(selected) || [];
  const typeList = CAL_TYPES.filter((t) => types.includes(t.key));

  return (
    <section className="border-t border-border pt-2 mt-2 text-xs" aria-label="Calendar">
      <div className="flex items-center justify-between px-1 mb-1">
        <button
          type="button"
          onClick={() => setCollapsedPersist(!collapsed)}
          aria-expanded={!collapsed}
          className="flex items-center gap-1 font-semibold text-fg-muted uppercase tracking-wide text-[11px] hover:text-fg"
        >
          <span aria-hidden="true" className={`transition-transform ${collapsed ? "" : "rotate-90"}`}>▸</span>
          Calendar
        </button>
        <Link to={`/calendar?date=${selected}`} className="text-[11px] text-brand hover:underline">Open</Link>
      </div>

      {!collapsed && (
        <>
          <div className="flex items-center justify-between px-1 mb-1">
            <button type="button" onClick={() => shift(-1)} aria-label="Previous month" className="px-1.5 rounded hover:bg-surface-2 text-fg-muted">‹</button>
            <button
              type="button"
              onClick={() => { const n = new Date(); setMonth(n); setSelected(dayKey(n)); }}
              className="font-medium text-fg hover:text-brand"
              title="Go to today"
            >
              {month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
            </button>
            <button type="button" onClick={() => shift(1)} aria-label="Next month" className="px-1.5 rounded hover:bg-surface-2 text-fg-muted">›</button>
          </div>

          <div className="grid grid-cols-7 text-center text-[10px] text-fg-dim mb-0.5" aria-hidden="true">
            {WEEKDAYS.map((d, i) => <span key={i}>{d}</span>)}
          </div>
          <div className="grid grid-cols-7 gap-y-0.5" role="grid">
            {grid.map((d) => {
              const k = dayKey(d);
              const items = byDay.get(k) || [];
              const dotTypes = [...new Set(items.map((e) => e.type))].slice(0, 3);
              const isSel = k === selected;
              const label = `${d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}${items.length ? `, ${items.length} item${items.length === 1 ? "" : "s"}` : ""}`;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => { setSelected(k); if (!sameMonth(d, month)) setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }}
                  aria-label={label}
                  aria-pressed={isSel}
                  className={`h-7 flex flex-col items-center justify-center rounded transition-colors ${
                    isSel ? "bg-brand text-brand-fg" : k === today ? "ring-1 ring-brand text-fg" : "hover:bg-surface-2"
                  } ${sameMonth(d, month) ? (isSel ? "" : "text-fg") : "text-fg-dim/60"}`}
                >
                  <span className="leading-none text-[11px]">{d.getDate()}</span>
                  <span className="flex gap-0.5 h-1 mt-0.5">
                    {dotTypes.map((t) => (
                      <span key={t} className={`w-1 h-1 rounded-full ${isSel ? "bg-brand-fg" : CAL_TYPE[t]?.dot}`} />
                    ))}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="mt-2 px-1">
            <div className="flex items-center justify-between mb-1">
              <span className="font-medium text-fg">
                {selected === today ? "Today" : new Date(`${selected}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
              </span>
              <button type="button" onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters}
                className="text-[11px] text-fg-muted hover:text-fg">
                Filter{hidden.size ? ` (${typeList.filter((t) => !hidden.has(t.key)).length}/${typeList.length})` : ""}
              </button>
            </div>

            {showFilters && (
              <div className="flex flex-col gap-0.5 mb-2">
                {typeList.map((t) => (
                  <label key={t.key} className="flex items-center gap-1.5 cursor-pointer text-fg-muted hover:text-fg">
                    <input type="checkbox" checked={!hidden.has(t.key)} onChange={() => toggle(t.key)} className="h-3 w-3" />
                    <span className={`w-2 h-2 rounded-full ${t.dot}`} aria-hidden="true" />
                    {t.label}
                  </label>
                ))}
              </div>
            )}

            {dayItems.length === 0 ? (
              <p className="text-fg-dim italic">Nothing scheduled.</p>
            ) : (
              <ul className="space-y-1">
                {dayItems.slice(0, MAX_DAY_ITEMS).map((e) => {
                  const body = (
                    <>
                      <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${CAL_TYPE[e.type]?.dot}`} aria-hidden="true" />
                      <span className="min-w-0">
                        <span className="block truncate text-fg">{e.title}</span>
                        <span className="block text-[10px] text-fg-dim">{eventTime(e)}{e.meta?.breached ? " · breached" : ""}</span>
                      </span>
                    </>
                  );
                  return (
                    <li key={e.id}>
                      {e.link
                        ? <Link to={e.link} title={e.title} className="flex gap-1.5 rounded hover:bg-surface-2 px-1 -mx-1">{body}</Link>
                        : <span title={e.title} className="flex gap-1.5 px-1 -mx-1">{body}</span>}
                    </li>
                  );
                })}
                {dayItems.length > MAX_DAY_ITEMS && (
                  <li>
                    <Link to={`/calendar?date=${selected}`} className="text-[11px] text-brand hover:underline">
                      +{dayItems.length - MAX_DAY_ITEMS} more
                    </Link>
                  </li>
                )}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}

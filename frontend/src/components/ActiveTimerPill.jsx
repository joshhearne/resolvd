import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../utils/api";
import { TIMERS_CHANGED, fmtClock } from "./TimeTracker";

// Header pill for the signed-in tech's time-tracking timers, so a clock
// left running on another ticket is never out of sight. Shows the
// running timer (live) or, failing that, how many are paused. Hidden
// when there are none.

export default function ActiveTimerPill() {
  const [timers, setTimers] = useState([]);
  const [fetchedAt, setFetchedAt] = useState(Date.now());
  const [open, setOpen] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api.get("/api/time-tracking/timers/me")
        .then((rows) => {
          if (cancelled) return;
          setTimers(Array.isArray(rows) ? rows : []);
          setFetchedAt(Date.now());
        })
        .catch(() => {});
    load();
    const poll = setInterval(load, 60_000);
    window.addEventListener(TIMERS_CHANGED, load);
    return () => {
      cancelled = true;
      clearInterval(poll);
      window.removeEventListener(TIMERS_CHANGED, load);
    };
  }, []);

  const running = timers.find((t) => t.running);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [running?.id]);

  if (!timers.length) return null;

  const secs = (t) => (t.running ? t.elapsed_seconds + (Date.now() - fetchedAt) / 1000 : t.elapsed_seconds);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1.5 text-xs rounded-full px-2.5 py-1 border ${
          running
            ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
            : "border-border bg-surface-2 text-fg-muted"
        }`}
        title="Your timers"
      >
        <span aria-hidden>⏱</span>
        {running ? (
          <>
            <span className="hidden sm:inline">{running.internal_ref}</span>
            <span className="font-mono tabular-nums">{fmtClock(secs(running))}</span>
          </>
        ) : (
          <span>{timers.length} paused</span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-72 bg-surface border border-border rounded-md shadow-lg z-50">
          <ul className="divide-y divide-border">
            {timers.map((t) => (
              <li key={t.id}>
                <Link
                  to={`/tickets/${t.ticket_id}`}
                  onClick={() => setOpen(false)}
                  className="flex items-center justify-between gap-2 px-3 py-2 text-sm hover:bg-surface-2"
                >
                  <span className="min-w-0">
                    <span className="font-medium text-fg">{t.internal_ref}</span>
                    <span className="block text-xs text-fg-muted truncate">{t.title}</span>
                  </span>
                  <span className={`font-mono tabular-nums text-xs ${t.running ? "text-emerald-700 dark:text-emerald-300" : "text-fg-muted"}`}>
                    {fmtClock(secs(t))}{t.running ? "" : " ⏸"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

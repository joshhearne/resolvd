import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../../utils/api";
import { fmtDateTime } from "../../utils/itemState";

// Subscribable .ics feeds of scheduled work (maintenance windows and
// recurring tickets) and company holidays for Outlook / M365 and Google
// Calendar. One secret link per user; regenerating it cuts off every
// calendar using the old one.

function FeedRow({ label, hint, url }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy. Select the link and copy it manually.");
    }
  }
  return (
    <div className="py-3 space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <div className="text-sm font-medium text-fg">{label}</div>
        {hint && <div className="text-xs text-fg-dim">{hint}</div>}
      </div>
      <div className="flex gap-2">
        <input readOnly value={url} onFocus={(e) => e.target.select()} aria-label={`${label} feed link`}
          className="flex-1 min-w-0 bg-surface-2 border border-border rounded px-2 py-1.5 text-xs font-mono text-fg-muted" />
        <button type="button" onClick={copy} className="btn btn-secondary btn-sm shrink-0">Copy</button>
      </div>
    </div>
  );
}

export default function AccountCalendar() {
  const [feed, setFeed] = useState(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try { setFeed(await api.get("/api/calendar/me")); }
    catch (e) { toast.error(e.message); setFeed({ enabled: false }); }
  }
  useEffect(() => { load(); }, []);

  async function generate() {
    if (feed?.enabled && !window.confirm(
      "Make new links? Calendars subscribed with the current links stop updating until you re-subscribe."
    )) return;
    setBusy(true);
    try { await api.post("/api/calendar/me/token", {}); await load(); toast.success("Calendar links ready"); }
    catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  }

  async function revoke() {
    if (!window.confirm("Turn off your calendar links? Subscribed calendars stop updating.")) return;
    setBusy(true);
    try { await api.delete("/api/calendar/me/token"); await load(); toast.success("Calendar links turned off"); }
    catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  }

  if (!feed) return <div className="text-sm text-fg-dim italic">Loading…</div>;

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-fg">Calendar feeds</h2>
        <p className="text-sm text-fg-muted">
          Subscribe to scheduled work (maintenance windows and recurring tickets) and company holidays
          in Outlook or Google Calendar. The calendar stays read-only and updates on its own.
        </p>
      </div>

      {!feed.enabled ? (
        <div className="card p-4 space-y-3">
          <p className="text-sm text-fg-muted">You don’t have calendar links yet.</p>
          <button onClick={generate} disabled={busy} className="btn btn-primary btn-sm">
            {busy ? "Creating…" : "Create my calendar links"}
          </button>
        </div>
      ) : (
        <>
          <div className="rounded-md border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/40 p-3 text-xs text-amber-900 dark:text-amber-300">
            These links work without signing in. Treat them like a password: don’t share them or post them
            anywhere. If one leaks, make new links below.
          </div>

          <div className="card px-4 divide-y divide-border">
            <FeedRow label="My scheduled work" hint="Windows and recurring tickets assigned to you" url={feed.links.mine} />
            {feed.links.all && (
              <FeedRow label="All scheduled work" hint="Every project" url={feed.links.all} />
            )}
          </div>

          {feed.links.projects.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-fg">Project calendars</h3>
              <div className="card px-4 divide-y divide-border">
                {feed.links.projects.map((p) => (
                  <FeedRow key={p.id} label={`${p.prefix} · ${p.name}`} url={p.url} />
                ))}
              </div>
            </div>
          )}

          {feed.links.holidays?.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-fg">Holiday calendars</h3>
              <div className="card px-4 divide-y divide-border">
                {feed.links.holidays.map((h) => (
                  <FeedRow key={h.id} label={h.title} url={h.url} hint="All-day holidays only" />
                ))}
              </div>
            </div>
          )}

          <div className="card p-4 space-y-2 text-sm text-fg-muted">
            <div className="font-medium text-fg">How to subscribe</div>
            <p>
              <span className="font-medium text-fg">Outlook / Microsoft 365:</span> Calendar → Add calendar →
              Subscribe from web → paste the link → Import.
            </p>
            <p>
              <span className="font-medium text-fg">Google Calendar:</span> Other calendars → + → From URL →
              paste the link → Add calendar.
            </p>
            <p className="text-xs text-fg-dim">
              Outlook and Google decide how often to refresh: usually every few hours, and Google can take
              up to a day. Check Resolvd for last-minute changes.
            </p>
          </div>

          <div className="flex items-center justify-between gap-3 flex-wrap text-xs text-fg-dim">
            <span>
              Created {fmtDateTime(feed.created_at)}
              {" · "}
              {feed.last_used_at ? `last fetched ${fmtDateTime(feed.last_used_at)}` : "not fetched yet"}
            </span>
            <span className="flex gap-2">
              <button onClick={generate} disabled={busy} className="btn btn-secondary btn-sm">Make new links</button>
              <button onClick={revoke} disabled={busy} className="btn btn-ghost btn-sm text-red-600">Turn off</button>
            </span>
          </div>
        </>
      )}
    </div>
  );
}

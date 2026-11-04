import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../utils/api";
import PriorityBadge from "./PriorityBadge";
import HybridTime from "./HybridTime";
import PageShell from "./PageShell";

// Curated dashboard for Submitters (#102). Shows only the caller's own
// submissions and tickets they've been added to as a follower — never
// team-wide counts, SLA analytics, time-in-status or the global activity
// feed. Data: GET /api/dashboard/mine (+ scoped /api/dashboard/activity).

function Stat({ label, value, to, tone = "text-sky-500 dark:text-sky-400", urgent }) {
  return (
    <Link
      to={to}
      className={`card card-hover block p-4 transition-colors ${
        urgent ? "border-amber-400/60 dark:border-amber-500/40 ring-1 ring-amber-400/20" : ""
      }`}
    >
      <div className={`text-3xl font-bold tracking-tight ${urgent ? "text-amber-500 dark:text-amber-400" : tone}`}>
        {value}
      </div>
      <div className="text-xs text-fg-muted mt-1">{label}</div>
    </Link>
  );
}

function TicketSection({ title, rows, emptyText, viewAllTo }) {
  return (
    <div className="card">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        {rows.length > 0 && (
          <Link to={viewAllTo} className="text-xs text-brand hover:underline">
            View all
          </Link>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-fg-dim px-4 py-6 text-center">{emptyText}</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((t) => (
            <li
              key={t.id}
              className={`px-4 py-3 flex items-center justify-between gap-3 hover:bg-surface-2 transition-colors ${
                t.is_live ? "" : "opacity-70"
              }`}
            >
              <div className="min-w-0">
                <div className="flex items-baseline gap-2 min-w-0">
                  <Link
                    to={`/tickets/${t.id}`}
                    className="text-sm font-medium text-brand hover:underline whitespace-nowrap"
                  >
                    {t.internal_ref}
                  </Link>
                  <span className="text-sm text-fg truncate">{t.title}</span>
                </div>
                <div className="text-xs text-fg-dim mt-0.5 flex flex-wrap gap-x-2">
                  <span>{t.internal_status}</span>
                  {t.project_name && <span>· {t.project_name}</span>}
                  <span>
                    · {t.assigned_to_name ? `Assigned to ${t.assigned_to_name}` : "Unassigned"}
                  </span>
                  <span>
                    · updated <HybridTime dt={t.updated_at} />
                  </span>
                </div>
              </div>
              <PriorityBadge
                priority={t.effective_priority}
                override={t.priority_override}
                computed={t.computed_priority}
                showOverrideInfo={false}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function SubmitterDashboard() {
  const [data, setData] = useState(null);
  const [activity, setActivity] = useState([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get("/api/dashboard/mine"),
      api.get("/api/dashboard/activity").catch(() => []),
    ])
      .then(([mine, act]) => {
        setData(mine);
        setActivity(Array.isArray(act) ? act : []);
      })
      .catch(() => setError(true));
  }, []);

  const header = (
    <div className="flex items-start justify-between gap-3 flex-wrap">
      <div>
        <h1 className="text-xl font-semibold text-fg tracking-tight">My Dashboard</h1>
        <p className="text-sm text-fg-muted mt-0.5">
          Tickets you've submitted and tickets you're following.
        </p>
      </div>
      <Link to="/tickets/new" className="btn btn-primary">
        + New Ticket
      </Link>
    </div>
  );

  if (error)
    return (
      <PageShell variant="wide" className="space-y-6">
        {header}
        <div className="text-fg-muted py-12 text-center">Couldn't load your dashboard.</div>
      </PageShell>
    );

  if (!data)
    return (
      <PageShell variant="wide" className="space-y-6">
        {header}
        <div className="text-fg-muted py-12 text-center">Loading dashboard…</div>
      </PageShell>
    );

  const c = data.counts || {};
  return (
    <PageShell variant="wide" className="space-y-6">
      {header}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="My open tickets" value={c.my_open || 0} to="/tickets?preset=submitted_open" />
        <Stat
          label="Waiting on me"
          value={c.my_awaiting || 0}
          urgent={(c.my_awaiting || 0) > 0}
          to="/tickets?preset=submitted_open"
        />
        <Stat
          label="Resolved / closed"
          value={c.my_resolved || 0}
          tone="text-fg-muted"
          to="/tickets?preset=submitted"
        />
        <Stat
          label="Following (open)"
          value={c.following_open || 0}
          tone="text-indigo-500 dark:text-indigo-400"
          to="/tickets?preset=following"
        />
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <TicketSection
          title="My submissions"
          rows={data.my_tickets || []}
          emptyText="You haven't submitted any tickets yet."
          viewAllTo="/tickets?preset=submitted"
        />
        <TicketSection
          title="Following"
          rows={data.following || []}
          emptyText="You're not following any other tickets."
          viewAllTo="/tickets?preset=following"
        />
      </div>

      <div className="card">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-fg">Recent updates on your tickets</h2>
        </div>
        {activity.length === 0 ? (
          <p className="text-sm text-fg-dim px-4 py-6 text-center">No recent updates</p>
        ) : (
          <ul className="divide-y divide-border">
            {activity.map((a) => (
              <li key={a.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-sm">
                    {a.internal_ref && (
                      <Link
                        to={`/tickets/${a.ticket_id}`}
                        className="font-medium text-brand hover:underline mr-1"
                      >
                        {a.internal_ref}
                      </Link>
                    )}
                    <span className="text-fg-muted">{a.action.replace(/_/g, " ")}</span>
                    {a.new_value && <span className="text-fg-dim"> → {a.new_value}</span>}
                  </div>
                  <HybridTime dt={a.created_at} className="text-xs text-fg-dim whitespace-nowrap" />
                </div>
                {a.user_name && <div className="text-xs text-fg-dim mt-0.5">{a.user_name}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </PageShell>
  );
}

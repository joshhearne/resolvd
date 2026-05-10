import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../utils/api";
import PriorityBadge from "../components/PriorityBadge";
import HybridTime from "../components/HybridTime";
import PageShell from "../components/PageShell";

const STAT_TONES = {
  blue: "text-sky-500 dark:text-sky-400",
  indigo: "text-indigo-500 dark:text-indigo-400",
  amber: "text-amber-500 dark:text-amber-400",
  purple: "text-purple-500 dark:text-purple-400",
  red: "text-red-500 dark:text-red-400",
  gray: "text-fg-muted",
};

function StatCard({ label, value, color = "blue", urgent = false, to }) {
  const valueClass = urgent
    ? "text-amber-500 dark:text-amber-400"
    : STAT_TONES[color] || STAT_TONES.gray;
  const inner = (
    <>
      <div className={`text-3xl font-bold tracking-tight ${valueClass}`}>
        {value}
      </div>
      <div className="text-xs text-fg-muted mt-1">{label}</div>
    </>
  );
  const base = `card p-4 transition-colors ${
    urgent
      ? "border-amber-400/60 dark:border-amber-500/40 ring-1 ring-amber-400/20"
      : ""
  }`;
  if (to) {
    return (
      <Link to={to} className={`${base} card-hover block cursor-pointer`}>
        {inner}
      </Link>
    );
  }
  return <div className={base}>{inner}</div>;
}

function SlaBreachCard({ sla }) {
  const live = sla.live || {};
  const mtd = sla.mtd_total || { response: 0, resolve: 0 };
  const byProject = sla.mtd_by_project || [];
  const liveBreached = (live.breached_response || 0) + (live.breached_resolve || 0);
  const mtdTotal = (mtd.response || 0) + (mtd.resolve || 0);
  const allClear = liveBreached === 0 && mtdTotal === 0 && byProject.length === 0;

  const monthLabel = new Date().toLocaleString("default", { month: "long" });

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-fg">
          SLA — {monthLabel} to date
        </h2>
        <span className="text-xs text-fg-dim">
          {sla.scope === "all" ? "All projects" : "Your projects"}
        </span>
      </div>

      {allClear ? (
        <div className="text-sm text-fg-muted py-4 text-center">
          No SLA breaches this month. Nothing currently breached or at risk.
        </div>
      ) : (
        <>
          {/* Top stat row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <div className="rounded-md border border-border bg-surface-2 px-3 py-2">
              <div className="text-xs text-fg-muted">MTD response breaches</div>
              <div className="text-2xl font-bold text-amber-500 dark:text-amber-400">
                {mtd.response || 0}
              </div>
            </div>
            <div className="rounded-md border border-border bg-surface-2 px-3 py-2">
              <div className="text-xs text-fg-muted">MTD resolve breaches</div>
              <div className="text-2xl font-bold text-amber-500 dark:text-amber-400">
                {mtd.resolve || 0}
              </div>
            </div>
            <Link
              to="/tickets?preset=sla_breached"
              className="rounded-md border border-border bg-surface-2 px-3 py-2 hover:bg-surface transition-colors"
            >
              <div className="text-xs text-fg-muted">Currently breached</div>
              <div
                className={`text-2xl font-bold ${
                  liveBreached > 0
                    ? "text-red-500 dark:text-red-400"
                    : "text-fg-muted"
                }`}
              >
                {liveBreached}
              </div>
            </Link>
            <div className="rounded-md border border-border bg-surface-2 px-3 py-2">
              <div className="text-xs text-fg-muted">Open w/ SLA clock</div>
              <div className="text-2xl font-bold text-fg">
                {(live.open_response || 0) + (live.open_resolve || 0)}
              </div>
            </div>
          </div>

          {/* Per-project breakdown */}
          {byProject.length > 0 && (
            <div className="border border-border rounded-md overflow-hidden">
              <div className="bg-surface-2 px-3 py-1.5 text-[11px] uppercase tracking-wider font-semibold text-fg-dim">
                MTD breaches by project
              </div>
              <table className="w-full text-sm">
                <thead className="bg-surface-2 text-xs text-fg-muted border-t border-border">
                  <tr>
                    <th className="text-left px-3 py-1.5 font-medium">Project</th>
                    <th className="text-right px-3 py-1.5 font-medium w-28">Response</th>
                    <th className="text-right px-3 py-1.5 font-medium w-28">Resolve</th>
                    <th className="text-right px-3 py-1.5 font-medium w-20">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {byProject.map((p) => {
                    const total =
                      (p.breached_response || 0) + (p.breached_resolve || 0);
                    return (
                      <tr key={p.project_id} className="border-t border-border">
                        <td className="px-3 py-2">
                          <Link
                            to={`/tickets?project_id=${p.project_id}&preset=sla_breached`}
                            className="text-brand hover:underline font-medium"
                          >
                            {p.project_prefix || p.project_name || `#${p.project_id}`}
                          </Link>
                          {p.project_name && p.project_prefix && (
                            <span className="ml-2 text-fg-muted text-xs">
                              {p.project_name}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right text-fg">
                          {p.breached_response || 0}
                        </td>
                        <td className="px-3 py-2 text-right text-fg">
                          {p.breached_resolve || 0}
                        </td>
                        <td className="px-3 py-2 text-right font-semibold text-amber-500 dark:text-amber-400">
                          {total}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [activity, setActivity] = useState([]);
  const [pendingTickets, setPendingTickets] = useState([]);
  const [sla, setSla] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get("/api/dashboard/stats"),
      api.get("/api/dashboard/activity"),
      api.get(
        "/api/tickets?internal_status=Pending+Review&sort_by=updated_at&sort_dir=desc&limit=10",
      ),
      api.get("/api/sla/dashboard").catch(() => null),
    ])
      .then(([s, a, pt, sl]) => {
        setStats(s);
        setActivity(a);
        setPendingTickets(pt.tickets || []);
        setSla(sl);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading)
    return (
      <div className="text-fg-muted py-12 text-center">Loading dashboard…</div>
    );

  const priorities = [1, 2, 3, 4, 5];
  const priorityMap = {};
  (stats?.priority_distribution || []).forEach((r) => {
    priorityMap[r.effective_priority] = r.count;
  });
  const totalActive = priorities.reduce(
    (sum, p) => sum + (priorityMap[p] || 0),
    0,
  );

  return (
    <PageShell variant="wide" className="space-y-6">
      <h1 className="text-xl font-semibold text-fg tracking-tight">
        Dashboard
      </h1>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        <StatCard
          label="Open"
          value={stats?.total_open || 0}
          color="blue"
          to="/tickets?preset=open"
        />
        <StatCard
          label="In Progress"
          value={stats?.total_in_progress || 0}
          color="indigo"
          to="/tickets?preset=in_progress"
        />
        <StatCard
          label="Awaiting Input"
          value={stats?.total_awaiting_mot || 0}
          color="amber"
          urgent={stats?.total_awaiting_mot > 0}
          to="/tickets?preset=awaiting_mot"
        />
        <StatCard
          label="Pending Review"
          value={stats?.total_pending_review || 0}
          color="purple"
          urgent={stats?.total_pending_review > 0}
          to="/tickets?preset=pending_review"
        />
        <StatCard
          label="Flagged for Review"
          value={stats?.flagged_for_review || 0}
          color="red"
          urgent={stats?.flagged_for_review > 0}
          to="/tickets?preset=flagged"
        />
        <StatCard
          label="Closed"
          value={stats?.total_closed || 0}
          color="gray"
          to="/tickets?preset=closed"
        />
      </div>

      {totalActive > 0 && (
        <div className="card p-4">
          <h2 className="text-sm font-semibold text-fg mb-3">
            Priority Distribution (Active Tickets)
          </h2>
          <div className="flex gap-2 items-end h-16">
            {priorities.map((p) => {
              const count = priorityMap[p] || 0;
              const pct = totalActive > 0 ? (count / totalActive) * 100 : 0;
              const colors = [
                "bg-red-500",
                "bg-orange-500",
                "bg-yellow-500",
                "bg-slate-500",
                "bg-slate-400",
              ];
              return (
                <div
                  key={p}
                  className="flex flex-col items-center gap-1 flex-1"
                >
                  <span className="text-xs font-medium text-fg-muted">
                    {count}
                  </span>
                  <div
                    className={`w-full ${colors[p - 1]} rounded-t transition-all`}
                    style={{ height: `${Math.max(pct, 4)}%` }}
                  />
                  <span className="text-xs text-fg-dim">P{p}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {sla && (
        <SlaBreachCard sla={sla} />
      )}

      <div className="grid lg:grid-cols-2 gap-6">
        {pendingTickets.length > 0 && (
          <div className="card border-purple-400/50 dark:border-purple-500/40">
            <div className="px-4 py-3 border-b border-border bg-purple-50 dark:bg-purple-950/30 rounded-t-xl">
              <h2 className="text-sm font-semibold text-purple-800 dark:text-purple-300">
                Pending Review — Action Required
              </h2>
            </div>
            <ul className="divide-y divide-border">
              {pendingTickets.map((t) => (
                <li
                  key={t.id}
                  className="px-4 py-3 flex items-center justify-between hover:bg-surface-2 transition-colors"
                >
                  <div>
                    <Link
                      to={`/tickets/${t.id}`}
                      className="text-sm font-medium text-brand hover:underline"
                    >
                      {t.internal_ref}
                    </Link>
                    <span className="ml-2 text-sm text-fg">{t.title}</span>
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
          </div>
        )}

        <div className="card">
          <div className="px-4 py-3 border-b border-border">
            <h2 className="text-sm font-semibold text-fg">Recent Activity</h2>
          </div>
          {activity.length === 0 ? (
            <p className="text-sm text-fg-dim px-4 py-6 text-center">
              No activity yet
            </p>
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
                      <span className="text-fg-muted">
                        {a.action.replace(/_/g, " ")}
                      </span>
                      {a.new_value && (
                        <span className="text-fg-dim"> → {a.new_value}</span>
                      )}
                    </div>
                    <HybridTime dt={a.created_at} className="text-xs text-fg-dim whitespace-nowrap" />
                  </div>
                  {a.user_name && (
                    <div className="text-xs text-fg-dim mt-0.5">
                      {a.user_name}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </PageShell>
  );
}

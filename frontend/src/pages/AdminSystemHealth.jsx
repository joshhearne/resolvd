import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import { useAuth } from "../context/AuthContext";
import HybridTime from "../components/HybridTime";
import ChangeList, { ChangeKey } from "../components/ChangeList";

function fmtBytes(n) {
  if (!n) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

function HealthDot({ health }) {
  const map = {
    ok: { color: "bg-emerald-500", label: "OK" },
    stale: { color: "bg-amber-500", label: "Stale" },
    degraded: { color: "bg-amber-500", label: "Degraded (polling)" },
    error: { color: "bg-red-500", label: "Error" },
    never_ran: { color: "bg-fg-dim", label: "Never ran" },
    unknown: { color: "bg-fg-dim", label: "Unknown" },
  };
  const v = map[health] || map.unknown;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span className={`inline-block w-2 h-2 rounded-full ${v.color}`} />
      <span className="text-fg-muted">{v.label}</span>
    </span>
  );
}

function BuildInfoCard() {
  const [info, setInfo] = useState(null);

  useEffect(() => {
    fetch('/api/version', { credentials: 'include' })
      .then((r) => r.json())
      .then(setInfo)
      .catch(() => setInfo({ version: 'unknown', commit: 'unknown', built_at: null }));
  }, []);

  if (!info) {
    return (
      <section className="bg-surface border border-border rounded-lg p-4">
        <div className="text-sm text-fg-dim">Loading build info…</div>
      </section>
    );
  }

  return (
    <section className="bg-surface border border-border rounded-lg overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border bg-surface-2">
        <h2 className="text-sm font-semibold text-fg">Build info</h2>
      </div>
      <div className="p-4 grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-fg-dim">Version</div>
          <div className="font-mono text-fg break-all">{info.version}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-fg-dim">Commit</div>
          <div className="font-mono text-fg break-all">{info.commit}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-fg-dim">Built</div>
          <div className="font-mono text-fg">
            {info.built_at ? <HybridTime value={info.built_at} /> : <span className="text-fg-dim">unknown</span>}
          </div>
        </div>
      </div>
    </section>
  );
}

const CHANNELS = [
  { value: "production", label: "Production", hint: "Installs each new release (main) at the update hour." },
  { value: "development", label: "Development", hint: "Installs the latest dev build each night. For test and staging servers." },
  { value: "manual", label: "Manual", hint: "Never updates on its own. Run the update commands on the server." },
];

const REPORT_TONE = {
  updated: "text-emerald-700 dark:text-emerald-300",
  up_to_date: "text-emerald-700 dark:text-emerald-300",
  waiting: "text-fg-muted",
  manual: "text-fg-muted",
  rolled_back: "text-amber-700 dark:text-amber-300",
  failed: "text-red-700 dark:text-red-400",
};

const EVENT_LABEL = { updated: "Updated", rolled_back: "Rolled back", failed: "Failed" };

// The host updater (deploy/resolvd-update.sh) checks in every 10 minutes.
const HOST_STALE_MS = 30 * 60 * 1000;

function UpdatesCard() {
  const [u, setU] = useState(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      setU(await api.get("/api/system-updates"));
    } catch (e) {
      toast.error(e.message);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 30 * 1000);
    return () => clearInterval(t);
  }, []);

  async function save(patch) {
    setSaving(true);
    setU((prev) => ({ ...prev, ...patch })); // show the choice right away
    try {
      const r = await api.put("/api/system-updates", patch);
      setU((prev) => ({ ...prev, ...r }));
      toast.success("Update settings saved");
    } catch (e) {
      toast.error(e.message);
      load();
    } finally {
      setSaving(false);
    }
  }

  async function updateNow() {
    try {
      const r = await api.post("/api/system-updates/update-now", {});
      setU((prev) => ({ ...prev, ...r }));
      toast.success("Update requested. The server picks it up within 10 minutes.");
    } catch (e) {
      toast.error(e.message);
    }
  }

  if (!u) {
    return (
      <section className="bg-surface border border-border rounded-lg p-4">
        <div className="text-sm text-fg-dim">Loading update settings…</div>
      </section>
    );
  }

  const report = u.last_report;
  const hostSeen = u.host_last_seen_at ? new Date(u.host_last_seen_at) : null;
  const hostStale = hostSeen && Date.now() - hostSeen.getTime() > HOST_STALE_MS;
  const tz = report?.host_tz ? ` (${report.host_tz})` : "";

  return (
    <section className="bg-surface border border-border rounded-lg overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border bg-surface-2 flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-sm font-semibold text-fg">Updates</h2>
        {u.channel !== "manual" && (
          <button
            type="button"
            onClick={updateNow}
            disabled={!!u.update_requested_at || !hostSeen}
            className="btn btn-secondary btn-sm"
          >
            {u.update_requested_at ? "Update requested…" : "Update now"}
          </button>
        )}
      </div>

      {(!u.updater_configured || !hostSeen || hostStale) && (
        <div className="px-4 py-3 border-b border-border text-sm text-amber-700 dark:text-amber-300">
          {!u.updater_configured ? (
            <>
              The host updater isn't installed, so this server only updates manually. On the server, run{" "}
              <code className="font-mono text-xs">sudo deploy/install-updater.sh</code> from the Resolvd folder.
            </>
          ) : !hostSeen ? (
            <>The host updater hasn't checked in yet. It runs every 10 minutes once installed (<code className="font-mono text-xs">systemctl list-timers resolvd-update.timer</code>).</>
          ) : (
            <>
              The host updater last checked in <HybridTime value={u.host_last_seen_at} />. Check it on the server with{" "}
              <code className="font-mono text-xs">journalctl -u resolvd-update.service</code>.
            </>
          )}
        </div>
      )}

      <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-6 text-sm">
        <fieldset className="space-y-2" disabled={saving}>
          <legend className="text-[10px] uppercase tracking-wide text-fg-dim mb-1">Channel</legend>
          {CHANNELS.map((c) => (
            <label key={c.value} className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="update-channel"
                className="mt-1"
                checked={u.channel === c.value}
                onChange={() => save({ channel: c.value })}
              />
              <span>
                <span className="font-medium text-fg">{c.label}</span>
                <span className="block text-xs text-fg-muted">{c.hint}</span>
              </span>
            </label>
          ))}
          {u.channel !== "manual" && (
            <div className="pt-2">
              <label htmlFor="update-hour" className="text-[10px] uppercase tracking-wide text-fg-dim block mb-1">
                Update hour{tz}
              </label>
              <select
                id="update-hour"
                value={u.update_hour}
                onChange={(e) => save({ update_hour: Number(e.target.value) })}
                className="border border-border-strong rounded-md px-2 py-1 text-sm"
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>
                ))}
              </select>
              <p className="text-xs text-fg-muted mt-1">Server time. A short restart happens during the update.</p>
            </div>
          )}
        </fieldset>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-fg-dim">Running</div>
              <div className="font-mono text-fg break-all">{u.running.version}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-fg-dim">Latest available</div>
              <div className="font-mono text-fg break-all">{report?.available_version || <span className="text-fg-dim">unknown</span>}</div>
            </div>
          </div>
          {report && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-fg-dim">Last check</div>
              <p className={REPORT_TONE[report.status] || "text-fg"}>{report.message}</p>
              {hostSeen && <p className="text-xs text-fg-dim"><HybridTime value={u.host_last_seen_at} /></p>}
            </div>
          )}
          {u.channel === "manual" && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-fg-dim mb-1">Update by hand</div>
              <pre className="bg-surface-2 rounded p-2 text-xs font-mono whitespace-pre-wrap">{`git fetch --tags && git checkout <release tag>
# set RESOLVD_IMAGE_TAG=<release tag> in .env
docker compose pull && docker compose up -d`}</pre>
            </div>
          )}
        </div>
      </div>

      {u.pending_changes?.total > 0 && (
        <div className="border-t border-border px-4 py-3">
          <details open={u.pending_changes.total <= 10}>
            <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-fg-dim">
              Coming in <span className="font-mono normal-case">{report?.available_version || "the next update"}</span>
              {" "}· {u.pending_changes.total} change{u.pending_changes.total === 1 ? "" : "s"}
            </summary>
            <div className="mt-3 space-y-3">
              <ChangeList entries={u.pending_changes.entries} />
              {u.pending_changes.total > u.pending_changes.entries.length && (
                <p className="text-xs text-fg-dim">
                  …and {u.pending_changes.total - u.pending_changes.entries.length} more.
                </p>
              )}
              <ChangeKey />
              <p className="text-xs text-fg-dim">Only admins see this preview. Everyone sees the changes that concern them after the update installs.</p>
            </div>
          </details>
        </div>
      )}

      {u.events?.length > 0 && (
        <div className="border-t border-border px-4 py-3">
          <div className="text-[10px] uppercase tracking-wide text-fg-dim mb-2">Recent updates</div>
          <ul className="space-y-1 text-xs">
            {u.events.map((e) => (
              <li key={`${e.at}-${e.to_version}`} className="flex flex-wrap gap-x-2">
                <span className={`font-medium ${REPORT_TONE[e.status] || ""}`}>{EVENT_LABEL[e.status] || e.status}</span>
                <span className="font-mono text-fg-muted">{e.from_version || "?"} → {e.to_version || "?"}</span>
                <span className="text-fg-dim"><HybridTime value={e.at} /></span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function StatCard({ label, value, sub }) {
  return (
    <div className="bg-surface border border-border rounded-lg p-3">
      <div className="text-[11px] uppercase tracking-wider text-fg-dim">{label}</div>
      <div className="text-2xl font-semibold text-fg mt-1">{value}</div>
      {sub && <div className="text-xs text-fg-muted mt-1">{sub}</div>}
    </div>
  );
}

export default function AdminSystemHealth() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    try {
      setData(await api.get("/api/system-health"));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(() => {
      setRefreshing(true);
      load();
    }, 30 * 1000);
    return () => clearInterval(t);
  }, []);

  if (loading) {
    return <div className="text-sm text-fg-dim py-12 text-center">Loading…</div>;
  }
  if (!data) {
    return <div className="text-sm text-red-600 py-12 text-center">Failed to load.</div>;
  }

  const tc = data.ticket_counts || {};
  const ic = data.inbound_counts || {};
  const dbs = data.db_stats || {};

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-fg mb-1">System health</h1>
          <p className="text-sm text-fg-muted">
            Scheduler heartbeats, integrations, and key counts. Auto-refreshes
            every 30 seconds.
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-fg-dim">
          <span>Generated <HybridTime value={data.generated_at} /></span>
          <button
            onClick={() => { setRefreshing(true); load(); }}
            className="btn btn-secondary btn-sm"
            disabled={refreshing}
          >
            {refreshing ? "↻ Refreshing…" : "↻ Refresh"}
          </button>
        </div>
      </div>

      <BuildInfoCard />
      {user?.role === "Admin" && <UpdatesCard />}

      {/* Top-line counters */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard label="Active tickets" value={tc.active ?? 0} sub={`${tc.total ?? 0} total`} />
        <StatCard label="P1 open" value={tc.p1 ?? 0} sub={`${tc.p2 ?? 0} P2`} />
        <StatCard label="Flagged" value={tc.flagged ?? 0} />
        <StatCard label="Inbound queue" value={ic.unmatched ?? 0} sub={`${(ic.matched ?? 0) + (ic.discarded ?? 0) + (ic.spam ?? 0)} processed`} />
        <StatCard label="Active users" value={dbs.active_users ?? 0} sub={`${dbs.active_projects ?? 0} projects`} />
        <StatCard label="DB size" value={fmtBytes(dbs.db_size_bytes)} sub={dbs.db_started_at ? <>up since <HybridTime value={dbs.db_started_at} /></> : null} />
      </div>

      {/* Schedulers */}
      <section className="bg-surface border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 border-b border-border bg-surface-2">
          <h2 className="text-sm font-semibold text-fg">Scheduled jobs</h2>
        </div>
        <table className="min-w-full divide-y divide-border text-sm">
          <thead className="bg-surface-2/50">
            <tr className="text-xs uppercase tracking-wider text-fg-dim">
              <th className="px-4 py-2 text-left font-medium">Job</th>
              <th className="px-4 py-2 text-left font-medium">Health</th>
              <th className="px-4 py-2 text-left font-medium">Last run</th>
              <th className="px-4 py-2 text-left font-medium">Cadence</th>
              <th className="px-4 py-2 text-left font-medium">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.jobs.map((j) => (
              <tr key={j.name}>
                <td className="px-4 py-2 text-fg">{j.label}</td>
                <td className="px-4 py-2"><HealthDot health={j.health} /></td>
                <td className="px-4 py-2 text-fg-muted whitespace-nowrap">
                  {j.last_run_at ? <HybridTime value={j.last_run_at} /> : "never"}
                </td>
                <td className="px-4 py-2 text-xs text-fg-dim whitespace-nowrap">
                  {j.cadence_ms ? `${Math.round(j.cadence_ms / 60000)} min` : "—"}
                </td>
                <td className="px-4 py-2 text-xs text-fg-muted">
                  {j.metadata ? (
                    <code className="text-[11px]">{JSON.stringify(j.metadata)}</code>
                  ) : (
                    <span className="text-fg-dim">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Alert sources */}
      <section className="bg-surface border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 border-b border-border bg-surface-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg">Alert sources</h2>
          <a href="/admin/alert-sources" className="text-xs text-brand hover:underline">
            Manage →
          </a>
        </div>
        {data.alert_sources.length === 0 ? (
          <div className="text-sm text-fg-dim italic px-4 py-3">
            No alert sources configured.
          </div>
        ) : (
          <table className="min-w-full divide-y divide-border text-sm">
            <thead className="bg-surface-2/50">
              <tr className="text-xs uppercase tracking-wider text-fg-dim">
                <th className="px-4 py-2 text-left font-medium">Name</th>
                <th className="px-4 py-2 text-left font-medium">Preset</th>
                <th className="px-4 py-2 text-left font-medium">Status</th>
                <th className="px-4 py-2 text-left font-medium">Events</th>
                <th className="px-4 py-2 text-left font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.alert_sources.map((s) => (
                <tr key={s.id}>
                  <td className="px-4 py-2 text-fg">{s.name}</td>
                  <td className="px-4 py-2 text-fg-muted">{s.preset}</td>
                  <td className="px-4 py-2">
                    {s.enabled ? (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                        enabled
                      </span>
                    ) : (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-fg-dim/15 text-fg-dim">
                        disabled
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-fg-muted">{s.event_count}</td>
                  <td className="px-4 py-2 text-fg-muted whitespace-nowrap">
                    {s.last_seen_at ? <HybridTime value={s.last_seen_at} /> : <span className="text-fg-dim">never</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Email backends */}
      <section className="bg-surface border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 border-b border-border bg-surface-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg">Email backends</h2>
          <a href="/admin/email-backends" className="text-xs text-brand hover:underline">
            Manage →
          </a>
        </div>
        {data.email_accounts.length === 0 ? (
          <div className="text-sm text-fg-dim italic px-4 py-3">
            No email backends connected.
          </div>
        ) : (
          <table className="min-w-full divide-y divide-border text-sm">
            <thead className="bg-surface-2/50">
              <tr className="text-xs uppercase tracking-wider text-fg-dim">
                <th className="px-4 py-2 text-left font-medium">Account</th>
                <th className="px-4 py-2 text-left font-medium">Provider</th>
                <th className="px-4 py-2 text-left font-medium">Active</th>
                <th className="px-4 py-2 text-left font-medium">Inbox monitor</th>
                <th className="px-4 py-2 text-left font-medium">Last test</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.email_accounts.map((a) => (
                <tr key={a.id}>
                  <td className="px-4 py-2 text-fg">
                    {a.display_name || a.from_address}
                    <div className="text-xs text-fg-dim">{a.from_address}</div>
                  </td>
                  <td className="px-4 py-2 text-fg-muted">{a.provider}</td>
                  <td className="px-4 py-2">
                    {a.is_active ? (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-brand/15 text-brand">active</span>
                    ) : (
                      <span className="text-xs text-fg-dim">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs">
                    {a.inbox_monitor_enabled ? (
                      <>
                        <span className="text-emerald-700 dark:text-emerald-400">on</span>
                        {a.inbox_subscription_expires_at && (
                          <div className="text-fg-dim">
                            renews <HybridTime value={a.inbox_subscription_expires_at} />
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-fg-dim">off</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs whitespace-nowrap">
                    {a.last_test_at ? (
                      <>
                        <span className={a.last_test_status === "ok" ? "text-emerald-600" : "text-red-600"}>
                          {a.last_test_status}
                        </span>
                        <div className="text-fg-dim">
                          <HybridTime value={a.last_test_at} />
                        </div>
                      </>
                    ) : (
                      <span className="text-fg-dim">never</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Inbound queue breakdown */}
      <section className="bg-surface border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 border-b border-border bg-surface-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg">Inbound email queue</h2>
          <a href="/admin/inbound" className="text-xs text-brand hover:underline">
            Manage →
          </a>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 p-3">
          {["unmatched", "matched", "discarded", "spam"].map((s) => (
            <div key={s} className="bg-surface-2 rounded p-2 text-center">
              <div className="text-[11px] uppercase tracking-wider text-fg-dim">{s}</div>
              <div className="text-lg font-semibold text-fg">{ic[s] ?? 0}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

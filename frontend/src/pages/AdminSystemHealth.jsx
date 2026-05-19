import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import HybridTime from "../components/HybridTime";

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

// Parse a tag like "v0.8.0" or "v0.8.0-3-gabcdef" into [major, minor,
// patch]. Returns null for non-semver strings ("dev", "unknown", etc).
function parseSemver(s) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(s || ''));
  return m ? [+m[1], +m[2], +m[3]] : null;
}

function compareSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function BuildInfoCard() {
  const [info, setInfo] = useState(null);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState(null);

  useEffect(() => {
    fetch('/api/version', { credentials: 'include' })
      .then((r) => r.json())
      .then(setInfo)
      .catch(() => setInfo({ version: 'unknown', commit: 'unknown', built_at: null }));
  }, []);

  async function checkForUpdates() {
    setChecking(true);
    setCheck(null);
    try {
      const r = await fetch('https://api.github.com/repos/joshhearne/resolvd/releases/latest', {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!r.ok) throw new Error(`GitHub returned ${r.status}`);
      const j = await r.json();
      const remoteTag = j.tag_name || '';
      const remoteVer = parseSemver(remoteTag);
      const localVer = parseSemver(info?.version);
      let status = 'unknown';
      if (!localVer) status = 'local_unparseable';
      else if (!remoteVer) status = 'remote_unparseable';
      else {
        const cmp = compareSemver(localVer, remoteVer);
        status = cmp < 0 ? 'behind' : cmp === 0 ? 'current' : 'ahead';
      }
      setCheck({
        status,
        remoteTag,
        remoteName: j.name || remoteTag,
        remoteUrl: j.html_url,
        publishedAt: j.published_at,
      });
    } catch (e) {
      setCheck({ status: 'error', error: e.message });
    } finally {
      setChecking(false);
    }
  }

  if (!info) {
    return (
      <section className="bg-surface border border-border rounded-lg p-4">
        <div className="text-sm text-fg-dim">Loading build info…</div>
      </section>
    );
  }

  return (
    <section className="bg-surface border border-border rounded-lg overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border bg-surface-2 flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-sm font-semibold text-fg">Build info</h2>
        <button
          type="button"
          onClick={checkForUpdates}
          disabled={checking}
          className="btn btn-secondary btn-sm"
        >
          {checking ? 'Checking…' : 'Check for updates'}
        </button>
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
      {check && (
        <div className="border-t border-border px-4 py-3 text-sm">
          {check.status === 'current' && (
            <p className="text-emerald-700 dark:text-emerald-300">✓ Up to date with the latest release <code className="font-mono text-xs">{check.remoteTag}</code>.</p>
          )}
          {check.status === 'behind' && (
            <p className="text-amber-700 dark:text-amber-300">
              ⚠ New release available:{' '}
              <a href={check.remoteUrl} target="_blank" rel="noopener noreferrer" className="underline font-mono">
                {check.remoteTag}
              </a>
              {check.publishedAt && (
                <> · published <HybridTime value={check.publishedAt} /></>
              )}
            </p>
          )}
          {check.status === 'ahead' && (
            <p className="text-fg-muted">You're ahead of the latest published release ({check.remoteTag}). Pre-release or local build.</p>
          )}
          {check.status === 'local_unparseable' && (
            <p className="text-fg-muted">Local version <code className="font-mono">{info.version}</code> isn't a release tag — built outside the release flow. Latest on main channel: <a href={check.remoteUrl} target="_blank" rel="noopener noreferrer" className="underline font-mono">{check.remoteTag}</a>.</p>
          )}
          {check.status === 'remote_unparseable' && (
            <p className="text-fg-muted">Couldn't parse remote tag {check.remoteTag}.</p>
          )}
          {check.status === 'error' && (
            <p className="text-red-700 dark:text-red-400">Couldn't reach GitHub: {check.error}</p>
          )}
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

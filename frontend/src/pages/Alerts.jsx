import React, { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { api } from "../utils/api";
import toast from "react-hot-toast";

const STATE_BADGE = {
  firing: "bg-red-100 text-red-700 border-red-300 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800",
  recovered: "bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800",
  suppressed: "bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-900/40 dark:text-slate-300 dark:border-slate-700",
};
// DB stores 'firing' for back-compat; UI shows "Problem" to match
// how operators talk about active alerts.
const STATE_LABEL = { firing: "Problem", recovered: "Recovered", suppressed: "Suppressed" };

function StateBadge({ state }) {
  return (
    <span className={`inline-flex items-center text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${STATE_BADGE[state] || ""}`}>
      {STATE_LABEL[state] || state}
    </span>
  );
}

function SeverityPill({ severity }) {
  if (!severity) return null;
  return (
    <span className="text-[10px] uppercase font-medium text-fg-muted bg-surface-2 border border-border rounded px-1.5 py-0.5">
      {severity}
    </span>
  );
}

function relTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso).getTime();
  const diff = Math.floor((Date.now() - d) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function Alerts() {
  const { user } = useAuth();
  const isHandler = ["Admin", "Manager", "Tech"].includes(user?.role);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stateFilter, setStateFilter] = useState("firing");
  const [hasTicketFilter, setHasTicketFilter] = useState("any");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState({});
  const [selected, setSelected] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const isAdmin = user?.role === "Admin";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (stateFilter !== "all") params.set("state", stateFilter);
      if (hasTicketFilter !== "any") params.set("has_ticket", hasTicketFilter);
      if (q.trim()) params.set("q", q.trim());
      const r = await api.get(`/api/alerts?${params.toString()}`);
      setRows(Array.isArray(r) ? r : []);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }, [stateFilter, hasTicketFilter, q]);

  useEffect(() => { load(); }, [load]);
  // Drop selections when filter changes so we don't act on rows that
  // are no longer visible.
  useEffect(() => { setSelected(new Set()); }, [stateFilter, hasTicketFilter, q]);

  function toggleOne(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAllVisible() {
    setSelected((prev) => {
      if (rows.every((r) => prev.has(r.id))) return new Set();
      return new Set(rows.map((r) => r.id));
    });
  }
  async function bulk(action) {
    const ids = Array.from(selected);
    if (!ids.length) return;
    const verb = action === "delete" ? "delete" : action;
    if (!window.confirm(`${verb} ${ids.length} alert${ids.length === 1 ? "" : "s"}?`)) return;
    setBulkBusy(true);
    try {
      const r = await api.post(`/api/alerts/bulk`, { ids, action });
      toast.success(`${r.updated} ${action}ed`);
      setSelected(new Set());
      await load();
    } catch (e) { toast.error(e.message); }
    finally { setBulkBusy(false); }
  }

  async function promote(id) {
    setBusy((b) => ({ ...b, [id]: "promote" }));
    try {
      const r = await api.post(`/api/alerts/${id}/promote`, {});
      toast.success(r.alreadyLinked ? "Already linked" : `Ticket created`);
      await load();
    } catch (e) { toast.error(e.message); }
    finally { setBusy((b) => ({ ...b, [id]: null })); }
  }
  async function suppress(id) {
    if (!window.confirm("Suppress this alert without creating a ticket?")) return;
    setBusy((b) => ({ ...b, [id]: "suppress" }));
    try {
      await api.post(`/api/alerts/${id}/suppress`, { reason: "manual" });
      toast.success("Alert suppressed");
      await load();
    } catch (e) { toast.error(e.message); }
    finally { setBusy((b) => ({ ...b, [id]: null })); }
  }

  if (!isHandler) {
    return (
      <div className="p-6 text-sm text-fg-muted">
        Alerts are visible only to handler roles (Admin / Manager / Tech).
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold text-fg">Alerts</h1>
        <div className="text-xs text-fg-muted">
          Integration-fed alerts. Tickets are only created when a rule promotes one (or you do it manually).
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap text-sm">
        <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}
          className="bg-surface-2 border border-border rounded px-2 py-1 text-xs">
          <option value="firing">Problem</option>
          <option value="recovered">Recovered</option>
          <option value="suppressed">Suppressed</option>
          <option value="all">All states</option>
        </select>
        <select value={hasTicketFilter} onChange={(e) => setHasTicketFilter(e.target.value)}
          className="bg-surface-2 border border-border rounded px-2 py-1 text-xs">
          <option value="any">Any ticket status</option>
          <option value="false">No ticket yet</option>
          <option value="true">Has ticket</option>
        </select>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search title…"
          className="bg-surface-2 border border-border rounded px-2 py-1 text-xs flex-1 min-w-[200px]"
        />
        <button onClick={load} className="btn btn-sm btn-ghost">Refresh</button>
      </div>

      {selected.size > 0 && (
        <div className="flex items-center gap-2 flex-wrap bg-brand/5 border border-brand/30 rounded px-3 py-2 text-sm">
          <span className="text-fg font-medium">{selected.size} selected</span>
          <button onClick={() => bulk("suppress")} disabled={bulkBusy}
            className="text-xs px-2 py-1 rounded bg-surface-2 hover:bg-surface border border-border disabled:opacity-50">
            Suppress
          </button>
          <button onClick={() => bulk("recover")} disabled={bulkBusy}
            className="text-xs px-2 py-1 rounded bg-surface-2 hover:bg-surface border border-border disabled:opacity-50">
            Mark recovered
          </button>
          {isAdmin && (
            <button onClick={() => bulk("delete")} disabled={bulkBusy}
              className="text-xs px-2 py-1 rounded bg-red-100 dark:bg-red-950/40 text-red-700 dark:text-red-300 border border-red-300 dark:border-red-800 hover:bg-red-200 disabled:opacity-50">
              Delete
            </button>
          )}
          <button onClick={() => setSelected(new Set())} className="text-xs text-fg-muted hover:text-fg ml-auto">Clear</button>
        </div>
      )}

      <div className="bg-surface rounded-lg border border-border overflow-hidden">
        {loading ? (
          <div className="p-6 text-sm text-fg-muted text-center">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-sm text-fg-dim text-center">No alerts match this filter.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-fg-muted bg-surface-2">
              <tr>
                <th className="px-3 py-2 w-8">
                  <input
                    type="checkbox"
                    checked={rows.length > 0 && rows.every((r) => selected.has(r.id))}
                    onChange={toggleAllVisible}
                    aria-label="Select all visible"
                  />
                </th>
                <th className="text-left px-3 py-2">State</th>
                <th className="text-left px-3 py-2">Source</th>
                <th className="text-left px-3 py-2">Title</th>
                <th className="text-left px-3 py-2">Severity</th>
                <th className="text-left px-3 py-2">Last seen</th>
                <th className="text-left px-3 py-2">Ticket</th>
                <th className="text-right px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.id} className={`hover:bg-surface-2/50 ${selected.has(r.id) ? "bg-brand/5" : ""}`}>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => toggleOne(r.id)}
                      aria-label={`Select alert ${r.id}`}
                    />
                  </td>
                  <td className="px-3 py-2"><StateBadge state={r.state} /></td>
                  <td className="px-3 py-2 text-xs text-fg-muted whitespace-nowrap">{r.source_name}</td>
                  <td className="px-3 py-2">
                    <Link to={`/alerts/${r.id}`} className="text-fg font-medium hover:text-brand hover:underline truncate max-w-[40ch] block" title={r.title || ""}>
                      {r.title || <span className="text-fg-dim italic">no title</span>}
                    </Link>
                    <div className="text-[10px] text-fg-dim font-mono">#{r.id} · {r.external_ref}</div>
                    {r.next_evaluation_at && r.state === "firing" && (
                      <div className="text-[10px] text-amber-600 dark:text-amber-400">
                        Re-eval at {new Date(r.next_evaluation_at).toLocaleString()}
                      </div>
                    )}
                    {r.suppression_reason && (
                      <div className="text-[10px] text-fg-dim italic">{r.suppression_reason}</div>
                    )}
                  </td>
                  <td className="px-3 py-2"><SeverityPill severity={r.severity} /></td>
                  <td className="px-3 py-2 text-xs text-fg-dim whitespace-nowrap" title={r.last_seen_at}>
                    {relTime(r.last_seen_at)}
                    {r.refire_count > 1 && (
                      <span className="ml-1 text-fg-muted">(×{r.refire_count})</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.ticket_id ? (
                      <Link to={`/tickets/${r.ticket_id}`} className="text-brand hover:underline font-mono">
                        {r.ticket_ref}
                      </Link>
                    ) : (
                      <span className="text-fg-dim">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right space-x-2 whitespace-nowrap">
                    {!r.ticket_id && r.state === "firing" && (
                      <>
                        <button
                          onClick={() => promote(r.id)}
                          disabled={busy[r.id] === "promote"}
                          className="text-xs px-2 py-1 rounded bg-brand text-white hover:opacity-90 disabled:opacity-50"
                        >
                          {busy[r.id] === "promote" ? "…" : "Create ticket"}
                        </button>
                        <button
                          onClick={() => suppress(r.id)}
                          disabled={busy[r.id] === "suppress"}
                          className="text-xs text-fg-muted hover:text-fg disabled:opacity-50"
                        >
                          Suppress
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

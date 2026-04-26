import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";

const TABS = [
  { v: "pending", label: "Pending requests" },
  { v: "active", label: "Active grants" },
  { v: "log", label: "Access log" },
];

export default function AdminSupport() {
  const [tab, setTab] = useState("pending");
  const [items, setItems] = useState([]);
  const [log, setLog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState({});

  async function reload() {
    setLoading(true);
    try {
      if (tab === "log") {
        setLog(await api.get("/api/support/access-log"));
      } else {
        setItems(await api.get(`/api/support/grants?status=${tab}`));
      }
    } catch (e) { toast.error(e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { reload(); }, [tab]);

  async function approve(id) {
    const d = parseInt(days[id] || "3", 10);
    try {
      await api.post(`/api/support/grants/${id}/approve`, { days: d });
      toast.success(`Approved for ${d} day${d === 1 ? "" : "s"}`);
      await reload();
    } catch (e) { toast.error(e.message); }
  }
  async function deny(id) {
    if (!window.confirm("Deny this support access request?")) return;
    try { await api.post(`/api/support/grants/${id}/deny`, {}); await reload(); }
    catch (e) { toast.error(e.message); }
  }
  async function revoke(id) {
    if (!window.confirm("Revoke this active grant immediately?")) return;
    try { await api.post(`/api/support/grants/${id}/revoke`, {}); await reload(); toast.success("Revoked"); }
    catch (e) { toast.error(e.message); }
  }

  return (
    <div>
      <div className="flex items-center gap-1 mb-4 border-b border-border">
        {TABS.map(t => (
          <button key={t.v} onClick={() => setTab(t.v)}
            className={`px-3 py-1.5 text-sm border-b-2 ${tab === t.v ? "border-brand text-brand" : "border-transparent text-fg-muted hover:text-fg"}`}>
            {t.label}
          </button>
        ))}
      </div>

      {loading ? <div className="text-sm text-fg-dim">Loading…</div> :
        tab === "log" ? (
          log.length === 0 ? <div className="text-sm text-fg-dim italic">No support reads recorded.</div> :
            <table className="w-full text-sm">
              <thead className="text-xs text-fg-dim uppercase border-b border-border">
                <tr>
                  <th className="text-left py-2">When</th>
                  <th className="text-left">Who</th>
                  <th className="text-left">Action</th>
                  <th className="text-left">Target</th>
                  <th className="text-left">IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {log.map(l => (
                  <tr key={l.id}>
                    <td className="py-1.5 text-fg-muted whitespace-nowrap">{new Date(l.created_at).toLocaleString()}</td>
                    <td>{l.user_name || l.user_email || "—"}</td>
                    <td><code className="text-xs">{l.action}</code></td>
                    <td className="text-xs text-fg-muted">{l.target_table}{l.target_id ? `:${l.target_id}` : ""}</td>
                    <td className="text-xs text-fg-dim">{l.ip}</td>
                  </tr>
                ))}
              </tbody>
            </table>
        ) :
          (items.length === 0 ?
            <div className="text-sm text-fg-dim italic">No {tab} grants.</div> :
            <div className="space-y-3">
              {items.map(g => (
                <div key={g.id} className="bg-surface border border-border rounded-lg p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-fg">
                        {g.support_user_name || g.support_user_email || "(unattached)"}
                      </div>
                      <div className="text-xs text-fg-muted mt-0.5">{g.reason}</div>
                      <div className="text-xs text-fg-dim mt-1">
                        Filed {new Date(g.requested_at).toLocaleString()}
                        {g.approved_at && <> · approved {new Date(g.approved_at).toLocaleString()} by {g.approved_by_name}</>}
                        {g.expires_at && <> · expires {new Date(g.expires_at).toLocaleString()}</>}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded font-medium ${
                        g.effective_status === "active" ? "bg-brand/15 text-brand" :
                        g.effective_status === "pending" ? "bg-amber-500/15 text-amber-700" :
                        "bg-surface-2 text-fg-muted"
                      }`}>{g.effective_status}</span>
                      {g.effective_status === "pending" && (
                        <div className="flex items-center gap-1">
                          <input type="number" min="1" max="14"
                            placeholder="3"
                            value={days[g.id] || ""}
                            onChange={e => setDays(d => ({ ...d, [g.id]: e.target.value }))}
                            className="bg-surface-2 border border-border rounded px-2 py-1 text-xs w-12" />
                          <span className="text-xs text-fg-dim">days</span>
                          <button onClick={() => approve(g.id)}
                            className="bg-brand text-white text-xs rounded px-2 py-1">Approve</button>
                          <button onClick={() => deny(g.id)}
                            className="text-xs text-red-600 hover:underline">Deny</button>
                        </div>
                      )}
                      {g.effective_status === "active" && (
                        <button onClick={() => revoke(g.id)}
                          className="text-xs text-red-600 hover:underline">Revoke now</button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )
      }
    </div>
  );
}

import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";

// SLA policies admin: edit org-default per-priority targets, add/remove
// per-project overrides. Targets stored as minutes; UI lets the admin
// type "1h 30m" or "2d" and we convert to minutes on save.
//
// Default rows (project_id=null) cannot be deleted — only edited.
// Override rows can be added per (project, priority) and removed.

const PRIORITY_LABELS = {
  1: "P1 (Critical)",
  2: "P2 (High)",
  3: "P3 (Normal)",
  4: "P4 (Low)",
  5: "P5 (Cosmetic)",
};

function fmtMinutes(min) {
  if (min == null) return "";
  const days = Math.floor(min / 1440);
  const hours = Math.floor((min % 1440) / 60);
  const mins = min % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins || parts.length === 0) parts.push(`${mins}m`);
  return parts.join(" ");
}

// Parse "1h 30m" / "2d" / "45m" / "90" → minutes (90 alone = 90m).
function parseDuration(s) {
  if (s == null || s === "") return null;
  const str = String(s).trim().toLowerCase();
  if (/^\d+$/.test(str)) return parseInt(str, 10);
  let total = 0;
  let matched = false;
  const re = /(\d+)\s*(d|h|m)/g;
  let m;
  while ((m = re.exec(str))) {
    matched = true;
    const n = parseInt(m[1], 10);
    if (m[2] === "d") total += n * 1440;
    else if (m[2] === "h") total += n * 60;
    else total += n;
  }
  return matched ? total : null;
}

export default function AdminSlaPolicies() {
  const [policies, setPolicies] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  const [edits, setEdits] = useState({}); // { id: { response: "", resolve: "" } }
  const [newRow, setNewRow] = useState({ project_id: "", priority: 1, response: "", resolve: "" });

  async function load() {
    setLoading(true);
    try {
      const [pList, pjList] = await Promise.all([
        api.get("/api/sla/policies"),
        api.get("/api/projects"),
      ]);
      setPolicies(pList);
      setProjects(pjList);
    } catch (e) {
      toast.error(e.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function saveRow(p) {
    const e = edits[p.id] || {};
    const response = e.response !== undefined ? parseDuration(e.response) : null;
    const resolve = e.resolve !== undefined ? parseDuration(e.resolve) : null;
    if (response == null && resolve == null) return;
    if ((e.response !== undefined && response == null) ||
        (e.resolve !== undefined && resolve == null)) {
      toast.error("Use formats like '30m', '4h', '1d 6h'");
      return;
    }
    setSavingId(p.id);
    try {
      const body = {};
      if (response != null) body.response_target_minutes = response;
      if (resolve != null) body.resolve_target_minutes = resolve;
      await api.patch(`/api/sla/policies/${p.id}`, body);
      toast.success("Saved");
      setEdits(prev => { const n = { ...prev }; delete n[p.id]; return n; });
      await load();
    } catch (err) {
      toast.error(err.message || "Failed");
    } finally {
      setSavingId(null);
    }
  }

  async function addOverride() {
    if (!newRow.project_id) { toast.error("Pick a project"); return; }
    const response = parseDuration(newRow.response);
    const resolve = parseDuration(newRow.resolve);
    if (response == null || resolve == null) {
      toast.error("Both targets required, e.g. '1h' / '4h'");
      return;
    }
    try {
      await api.post("/api/sla/policies", {
        project_id: Number(newRow.project_id),
        priority: Number(newRow.priority),
        response_target_minutes: response,
        resolve_target_minutes: resolve,
      });
      toast.success("Override added");
      setNewRow({ project_id: "", priority: 1, response: "", resolve: "" });
      await load();
    } catch (err) {
      toast.error(err.message || "Failed");
    }
  }

  async function deleteRow(id) {
    if (!confirm("Remove this project override?")) return;
    try {
      await api.delete(`/api/sla/policies/${id}`);
      toast.success("Removed");
      await load();
    } catch (err) {
      toast.error(err.message || "Failed");
    }
  }

  const orgDefaults = policies.filter(p => p.project_id == null);
  const overrides = policies.filter(p => p.project_id != null);

  return (
    <div className="space-y-5">
      <div className="bg-surface border border-border rounded-lg p-4">
        <h2 className="text-base font-semibold text-fg mb-1">Org-default targets</h2>
        <p className="text-xs text-fg-muted mb-3">
          Per-priority response + resolve targets applied to every ticket
          unless a project override exists. Format: <code>30m</code>,{" "}
          <code>4h</code>, <code>1d 6h</code>, etc. Clock pauses while a
          ticket is in any status tagged <code>awaiting_input</code> or{" "}
          <code>on_hold</code>.
        </p>
        {loading ? <div className="text-sm text-fg-muted">Loading…</div> : (
          <table className="w-full text-sm">
            <thead className="text-xs text-fg-muted">
              <tr>
                <th className="text-left py-1">Priority</th>
                <th className="text-left py-1">Response target</th>
                <th className="text-left py-1">Resolve target</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {orgDefaults.map(p => {
                const e = edits[p.id] || {};
                const responseVal = e.response !== undefined ? e.response : fmtMinutes(p.response_target_minutes);
                const resolveVal = e.resolve !== undefined ? e.resolve : fmtMinutes(p.resolve_target_minutes);
                const dirty = e.response !== undefined || e.resolve !== undefined;
                return (
                  <tr key={p.id} className="border-t border-border">
                    <td className="py-2 pr-3 font-medium">{PRIORITY_LABELS[p.priority]}</td>
                    <td className="py-2 pr-3">
                      <input
                        value={responseVal}
                        onChange={ev => setEdits(prev => ({ ...prev, [p.id]: { ...prev[p.id], response: ev.target.value } }))}
                        className="border border-border-strong rounded px-2 py-1 text-sm font-mono w-28"
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <input
                        value={resolveVal}
                        onChange={ev => setEdits(prev => ({ ...prev, [p.id]: { ...prev[p.id], resolve: ev.target.value } }))}
                        className="border border-border-strong rounded px-2 py-1 text-sm font-mono w-28"
                      />
                    </td>
                    <td className="py-2">
                      {dirty && (
                        <button onClick={() => saveRow(p)} disabled={savingId === p.id}
                          className="text-xs px-2 py-1 bg-brand text-white rounded">
                          {savingId === p.id ? "Saving…" : "Save"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="bg-surface border border-border rounded-lg p-4">
        <h2 className="text-base font-semibold text-fg mb-1">Project overrides</h2>
        <p className="text-xs text-fg-muted mb-3">
          Override the default for a specific (project, priority) pair.
          Useful for per-customer SLAs or VIP queues.
        </p>
        {overrides.length === 0 && (
          <div className="text-sm text-fg-muted mb-3">No overrides configured.</div>
        )}
        {overrides.length > 0 && (
          <table className="w-full text-sm mb-3">
            <thead className="text-xs text-fg-muted">
              <tr>
                <th className="text-left py-1">Project</th>
                <th className="text-left py-1">Priority</th>
                <th className="text-left py-1">Response</th>
                <th className="text-left py-1">Resolve</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {overrides.map(p => {
                const e = edits[p.id] || {};
                const responseVal = e.response !== undefined ? e.response : fmtMinutes(p.response_target_minutes);
                const resolveVal = e.resolve !== undefined ? e.resolve : fmtMinutes(p.resolve_target_minutes);
                const dirty = e.response !== undefined || e.resolve !== undefined;
                return (
                  <tr key={p.id} className="border-t border-border">
                    <td className="py-2 pr-3 font-medium">{p.project_prefix} · {p.project_name}</td>
                    <td className="py-2 pr-3">{PRIORITY_LABELS[p.priority]}</td>
                    <td className="py-2 pr-3">
                      <input
                        value={responseVal}
                        onChange={ev => setEdits(prev => ({ ...prev, [p.id]: { ...prev[p.id], response: ev.target.value } }))}
                        className="border border-border-strong rounded px-2 py-1 text-sm font-mono w-24"
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <input
                        value={resolveVal}
                        onChange={ev => setEdits(prev => ({ ...prev, [p.id]: { ...prev[p.id], resolve: ev.target.value } }))}
                        className="border border-border-strong rounded px-2 py-1 text-sm font-mono w-24"
                      />
                    </td>
                    <td className="py-2 flex gap-2">
                      {dirty && (
                        <button onClick={() => saveRow(p)} disabled={savingId === p.id}
                          className="text-xs px-2 py-1 bg-brand text-white rounded">Save</button>
                      )}
                      <button onClick={() => deleteRow(p.id)} className="text-xs px-2 py-1 text-red-600 hover:underline">Remove</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <div className="border-t border-border pt-3">
          <h3 className="text-xs font-semibold text-fg-muted mb-2 uppercase">Add override</h3>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">Project</span>
              <select
                value={newRow.project_id}
                onChange={e => setNewRow(p => ({ ...p, project_id: e.target.value }))}
                className="border border-border-strong rounded px-2 py-1 text-sm"
              >
                <option value="">— pick —</option>
                {projects.filter(pj => pj.status === "active").map(pj => (
                  <option key={pj.id} value={pj.id}>{pj.prefix} · {pj.name}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">Priority</span>
              <select
                value={newRow.priority}
                onChange={e => setNewRow(p => ({ ...p, priority: Number(e.target.value) }))}
                className="border border-border-strong rounded px-2 py-1 text-sm"
              >
                {[1, 2, 3, 4, 5].map(i => <option key={i} value={i}>{PRIORITY_LABELS[i]}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">Response</span>
              <input
                value={newRow.response}
                onChange={e => setNewRow(p => ({ ...p, response: e.target.value }))}
                placeholder="e.g. 1h"
                className="border border-border-strong rounded px-2 py-1 text-sm font-mono w-24"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">Resolve</span>
              <input
                value={newRow.resolve}
                onChange={e => setNewRow(p => ({ ...p, resolve: e.target.value }))}
                placeholder="e.g. 8h"
                className="border border-border-strong rounded px-2 py-1 text-sm font-mono w-24"
              />
            </label>
            <button onClick={addOverride} className="px-3 py-1.5 text-sm bg-brand text-white rounded">Add</button>
          </div>
        </div>
      </div>
    </div>
  );
}

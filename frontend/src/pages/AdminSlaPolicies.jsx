import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";

// SLA policies admin: org-default + per-project (priority, target) rows,
// plus a per-policy warning threshold (% of window elapsed before the
// pre-breach warning fires) and an optional business-hours policy
// pinning the clock to weekday windows. Targets stored as minutes; UI
// accepts "1h 30m" / "2d" / "45m" / "90" formats.

const PRIORITY_LABELS = {
  1: "P1 (Critical)",
  2: "P2 (High)",
  3: "P3 (Normal)",
  4: "P4 (Low)",
  5: "P5 (Cosmetic)",
};

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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

function fmtTime(t) {
  if (!t) return "";
  return String(t).slice(0, 5);
}

export default function AdminSlaPolicies() {
  const [policies, setPolicies] = useState([]);
  const [projects, setProjects] = useState([]);
  const [bhList, setBhList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  const [edits, setEdits] = useState({});
  const [newRow, setNewRow] = useState({ project_id: "", priority: 1, response: "", resolve: "" });

  async function load() {
    setLoading(true);
    try {
      const [pList, pjList, bh] = await Promise.all([
        api.get("/api/sla/policies"),
        api.get("/api/projects"),
        api.get("/api/sla/business-hours"),
      ]);
      setPolicies(pList);
      setProjects(pjList);
      setBhList(bh);
    } catch (e) {
      toast.error(e.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function saveRow(p) {
    const e = edits[p.id] || {};
    const body = {};
    if (e.response !== undefined) {
      const v = parseDuration(e.response);
      if (v == null) { toast.error("Response: use '30m', '4h', '1d 6h'"); return; }
      body.response_target_minutes = v;
    }
    if (e.resolve !== undefined) {
      const v = parseDuration(e.resolve);
      if (v == null) { toast.error("Resolve: use '30m', '4h', '1d 6h'"); return; }
      body.resolve_target_minutes = v;
    }
    if (e.threshold !== undefined) {
      const n = Number(e.threshold);
      if (!Number.isFinite(n) || n < 0 || n > 99) { toast.error("Warning %: 0–99"); return; }
      body.warning_threshold_percent = Math.floor(n);
    }
    if (e.business_hours_id !== undefined) {
      body.business_hours_id = e.business_hours_id === "" ? null : Number(e.business_hours_id);
    }
    if (!Object.keys(body).length) return;
    setSavingId(p.id);
    try {
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
    if (response == null || resolve == null) { toast.error("Both targets required, e.g. '1h' / '4h'"); return; }
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

  function PolicyRow({ p, isOverride }) {
    const e = edits[p.id] || {};
    const responseVal = e.response !== undefined ? e.response : fmtMinutes(p.response_target_minutes);
    const resolveVal = e.resolve !== undefined ? e.resolve : fmtMinutes(p.resolve_target_minutes);
    const thresholdVal = e.threshold !== undefined ? e.threshold : String(p.warning_threshold_percent ?? 80);
    const bhVal = e.business_hours_id !== undefined ? e.business_hours_id : (p.business_hours_id == null ? "" : String(p.business_hours_id));
    const dirty = e.response !== undefined || e.resolve !== undefined || e.threshold !== undefined || e.business_hours_id !== undefined;
    return (
      <tr className="border-t border-border">
        {isOverride && <td className="py-2 pr-3 font-medium">{p.project_prefix} · {p.project_name}</td>}
        <td className="py-2 pr-3 font-medium">{PRIORITY_LABELS[p.priority]}</td>
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
        <td className="py-2 pr-3">
          <input
            type="number" min="0" max="99"
            value={thresholdVal}
            onChange={ev => setEdits(prev => ({ ...prev, [p.id]: { ...prev[p.id], threshold: ev.target.value } }))}
            className="border border-border-strong rounded px-2 py-1 text-sm font-mono w-16"
          />
        </td>
        <td className="py-2 pr-3">
          <select
            value={bhVal}
            onChange={ev => setEdits(prev => ({ ...prev, [p.id]: { ...prev[p.id], business_hours_id: ev.target.value } }))}
            className="border border-border-strong rounded px-2 py-1 text-sm"
          >
            <option value="">24/7 (no bh)</option>
            {bhList.map(bh => (
              <option key={bh.id} value={bh.id}>
                {bh.name}{!bh.enabled ? " (disabled)" : ""}
              </option>
            ))}
          </select>
        </td>
        <td className="py-2 flex gap-2">
          {dirty && (
            <button onClick={() => saveRow(p)} disabled={savingId === p.id}
              className="text-xs px-2 py-1 bg-brand text-white rounded">
              {savingId === p.id ? "Saving…" : "Save"}
            </button>
          )}
          {isOverride && (
            <button onClick={() => deleteRow(p.id)} className="text-xs px-2 py-1 text-red-600 hover:underline">Remove</button>
          )}
        </td>
      </tr>
    );
  }

  return (
    <div className="space-y-5">
      <BusinessHoursSection bhList={bhList} projects={projects} onChange={load} />

      <div className="bg-surface border border-border rounded-lg p-4">
        <h2 className="text-base font-semibold text-fg mb-1">Org-default targets</h2>
        <p className="text-xs text-fg-muted mb-3">
          Per-priority targets applied to every ticket unless a project
          override exists. Format: <code>30m</code>, <code>4h</code>,{" "}
          <code>1d 6h</code>. Warning % fires the pre-breach signal when
          that fraction of the window has elapsed (0 disables). Business
          hours pin the clock to weekday windows; <code>24/7</code> = no
          pause.
        </p>
        {loading ? <div className="text-sm text-fg-muted">Loading…</div> : (
          <table className="w-full text-sm">
            <thead className="text-xs text-fg-muted">
              <tr>
                <th className="text-left py-1">Priority</th>
                <th className="text-left py-1">Response</th>
                <th className="text-left py-1">Resolve</th>
                <th className="text-left py-1">Warn %</th>
                <th className="text-left py-1">Business hours</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {orgDefaults.map(p => <PolicyRow key={p.id} p={p} isOverride={false} />)}
            </tbody>
          </table>
        )}
      </div>

      <div className="bg-surface border border-border rounded-lg p-4">
        <h2 className="text-base font-semibold text-fg mb-1">Project overrides</h2>
        <p className="text-xs text-fg-muted mb-3">
          Override the default for a specific (project, priority) pair.
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
                <th className="text-left py-1">Warn %</th>
                <th className="text-left py-1">Business hours</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {overrides.map(p => <PolicyRow key={p.id} p={p} isOverride={true} />)}
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
          <p className="mt-2 text-xs text-fg-dim">
            After creating, set warning % + business hours via the row's
            edit fields above.
          </p>
        </div>
      </div>
    </div>
  );
}

function BusinessHoursSection({ bhList, projects, onChange }) {
  const [edits, setEdits] = useState({});
  const [addOpen, setAddOpen] = useState(false);
  const [newBh, setNewBh] = useState({
    name: "",
    project_id: "",
    tz: "America/Chicago",
    days: [1, 2, 3, 4, 5],
    start_time: "09:00",
    end_time: "17:00",
  });

  function toggleDay(rowState, day, setRowState) {
    const days = new Set(rowState.days || []);
    if (days.has(day)) days.delete(day);
    else days.add(day);
    setRowState({ ...rowState, days: Array.from(days).sort() });
  }

  async function saveBh(b) {
    const e = edits[b.id];
    if (!e) return;
    try {
      await api.patch(`/api/sla/business-hours/${b.id}`, e);
      toast.success("Saved");
      setEdits(prev => { const n = { ...prev }; delete n[b.id]; return n; });
      await onChange();
    } catch (err) {
      toast.error(err.message || "Failed");
    }
  }

  async function deleteBh(id) {
    if (!confirm("Delete this business hours policy? Any SLA policies pinning it will fall back to 24/7.")) return;
    try {
      await api.delete(`/api/sla/business-hours/${id}`);
      toast.success("Deleted");
      await onChange();
    } catch (err) {
      toast.error(err.message || "Failed");
    }
  }

  async function addBh() {
    if (!newBh.name.trim()) { toast.error("Name required"); return; }
    if (!newBh.tz.trim()) { toast.error("Timezone required"); return; }
    if (!newBh.days.length) { toast.error("Pick at least one day"); return; }
    try {
      await api.post("/api/sla/business-hours", {
        ...newBh,
        project_id: newBh.project_id ? Number(newBh.project_id) : null,
      });
      toast.success("Added");
      setNewBh({
        name: "", project_id: "", tz: "America/Chicago",
        days: [1, 2, 3, 4, 5], start_time: "09:00", end_time: "17:00",
      });
      setAddOpen(false);
      await onChange();
    } catch (err) {
      toast.error(err.message || "Failed");
    }
  }

  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-base font-semibold text-fg">Business hours</h2>
        <button onClick={() => setAddOpen(o => !o)} className="text-xs px-2 py-1 border border-border rounded hover:bg-surface-2">
          {addOpen ? "Cancel" : "+ Add policy"}
        </button>
      </div>
      <p className="text-xs text-fg-muted mb-3">
        Pinned by SLA policies. Clock skips outside the configured days &
        times. The org default is seeded Mon–Fri 9–5 CT; edit or disable
        it, or add per-project rows. Pin a policy to an SLA via the{" "}
        <b>Business hours</b> column below.
      </p>

      {addOpen && (
        <div className="border border-border rounded p-3 mb-3 space-y-2 bg-surface-2/40">
          <div className="flex flex-wrap gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">Name</span>
              <input value={newBh.name} onChange={e => setNewBh(p => ({ ...p, name: e.target.value }))}
                placeholder="e.g. MOT Tier-1 9–5" className="border border-border-strong rounded px-2 py-1 text-sm w-56" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">Project (blank = org default)</span>
              <select value={newBh.project_id} onChange={e => setNewBh(p => ({ ...p, project_id: e.target.value }))}
                className="border border-border-strong rounded px-2 py-1 text-sm">
                <option value="">— org default —</option>
                {projects.filter(pj => pj.status === "active").map(pj => (
                  <option key={pj.id} value={pj.id}>{pj.prefix} · {pj.name}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">Timezone (IANA)</span>
              <input value={newBh.tz} onChange={e => setNewBh(p => ({ ...p, tz: e.target.value }))}
                placeholder="America/Chicago" className="border border-border-strong rounded px-2 py-1 text-sm font-mono w-48" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">Start</span>
              <input type="time" value={newBh.start_time} onChange={e => setNewBh(p => ({ ...p, start_time: e.target.value }))}
                className="border border-border-strong rounded px-2 py-1 text-sm font-mono w-28" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">End</span>
              <input type="time" value={newBh.end_time} onChange={e => setNewBh(p => ({ ...p, end_time: e.target.value }))}
                className="border border-border-strong rounded px-2 py-1 text-sm font-mono w-28" />
            </label>
          </div>
          <div>
            <div className="text-xs text-fg-muted mb-1">Days</div>
            <div className="flex gap-1">
              {DAY_LABELS.map((d, i) => (
                <button key={i} type="button"
                  onClick={() => toggleDay(newBh, i, setNewBh)}
                  className={`px-2 py-1 text-xs rounded border ${newBh.days.includes(i) ? "bg-brand text-white border-brand" : "border-border hover:bg-surface-2"}`}>
                  {d}
                </button>
              ))}
            </div>
          </div>
          <button onClick={addBh} className="text-sm px-3 py-1.5 bg-brand text-white rounded">Save policy</button>
        </div>
      )}

      {bhList.length === 0 ? (
        <div className="text-sm text-fg-muted">No business hours policies yet.</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-xs text-fg-muted">
            <tr>
              <th className="text-left py-1">Name</th>
              <th className="text-left py-1">Scope</th>
              <th className="text-left py-1">TZ</th>
              <th className="text-left py-1">Days</th>
              <th className="text-left py-1">Window</th>
              <th className="text-left py-1">Enabled</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {bhList.map(b => {
              const e = edits[b.id] || {};
              const merged = { ...b, ...e };
              const dirty = !!Object.keys(e).length;
              return (
                <tr key={b.id} className="border-t border-border">
                  <td className="py-2 pr-3">
                    <input value={merged.name || ""}
                      onChange={ev => setEdits(prev => ({ ...prev, [b.id]: { ...prev[b.id], name: ev.target.value } }))}
                      className="border border-border-strong rounded px-2 py-1 text-sm w-44" />
                  </td>
                  <td className="py-2 pr-3 text-fg-muted">
                    {b.project_id == null ? <span className="text-fg-dim">org default</span> : `${b.project_prefix} · ${b.project_name}`}
                  </td>
                  <td className="py-2 pr-3">
                    <input value={merged.tz}
                      onChange={ev => setEdits(prev => ({ ...prev, [b.id]: { ...prev[b.id], tz: ev.target.value } }))}
                      className="border border-border-strong rounded px-2 py-1 text-sm font-mono w-40" />
                  </td>
                  <td className="py-2 pr-3">
                    <div className="flex gap-0.5">
                      {DAY_LABELS.map((d, i) => {
                        const days = merged.days || [];
                        const on = days.includes(i);
                        return (
                          <button key={i} type="button"
                            onClick={() => {
                              const next = new Set(days);
                              if (on) next.delete(i); else next.add(i);
                              setEdits(prev => ({ ...prev, [b.id]: { ...prev[b.id], days: Array.from(next).sort() } }));
                            }}
                            className={`px-1.5 py-0.5 text-[10px] rounded border ${on ? "bg-brand text-white border-brand" : "border-border hover:bg-surface-2"}`}>
                            {d.slice(0, 1)}
                          </button>
                        );
                      })}
                    </div>
                  </td>
                  <td className="py-2 pr-3">
                    <div className="flex items-center gap-1">
                      <input type="time" value={fmtTime(merged.start_time)}
                        onChange={ev => setEdits(prev => ({ ...prev, [b.id]: { ...prev[b.id], start_time: ev.target.value } }))}
                        className="border border-border-strong rounded px-1.5 py-0.5 text-xs font-mono w-24" />
                      <span className="text-fg-dim">→</span>
                      <input type="time" value={fmtTime(merged.end_time)}
                        onChange={ev => setEdits(prev => ({ ...prev, [b.id]: { ...prev[b.id], end_time: ev.target.value } }))}
                        className="border border-border-strong rounded px-1.5 py-0.5 text-xs font-mono w-24" />
                    </div>
                  </td>
                  <td className="py-2 pr-3">
                    <input type="checkbox" checked={!!merged.enabled}
                      onChange={ev => setEdits(prev => ({ ...prev, [b.id]: { ...prev[b.id], enabled: ev.target.checked } }))} />
                  </td>
                  <td className="py-2 flex gap-2">
                    {dirty && <button onClick={() => saveBh(b)} className="text-xs px-2 py-1 bg-brand text-white rounded">Save</button>}
                    {b.project_id != null && (
                      <button onClick={() => deleteBh(b.id)} className="text-xs px-2 py-1 text-red-600 hover:underline">Delete</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

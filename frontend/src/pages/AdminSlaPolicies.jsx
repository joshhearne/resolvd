import { Fragment, useEffect, useState } from "react";
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
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  const [edits, setEdits] = useState({});
  const [newRow, setNewRow] = useState({ project_id: "", priority: 1, response: "", resolve: "" });

  async function load() {
    setLoading(true);
    try {
      const [pList, pjList, bh, locs] = await Promise.all([
        api.get("/api/sla/policies"),
        api.get("/api/projects"),
        api.get("/api/sla/business-hours"),
        api.get("/api/companies/locations").catch(() => []),
      ]);
      setPolicies(pList);
      setProjects(pjList);
      setBhList(bh);
      setLocations(locs);
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
      <BusinessHoursSection bhList={bhList} projects={projects} locations={locations} onChange={load} />
      <SlaWebhooksSection projects={projects} />

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

// Scope select value: "" = org default, "p:<id>" = project, "l:<id>" = location.
function scopeToBody(scope) {
  if (scope.startsWith("p:")) return { project_id: Number(scope.slice(2)), location_id: null };
  if (scope.startsWith("l:")) return { project_id: null, location_id: Number(scope.slice(2)) };
  return { project_id: null, location_id: null };
}

function scopeLabel(b) {
  if (b.location_id != null) return `Location · ${b.location_name || `#${b.location_id}`}`;
  if (b.project_id != null) return `${b.project_prefix} · ${b.project_name}`;
  return null;
}

function HolidaysEditor({ bh, onChange }) {
  const [draft, setDraft] = useState({ date: "", name: "", recurring: false });
  const [saving, setSaving] = useState(false);

  async function add() {
    if (!draft.date) { toast.error("Pick a date"); return; }
    setSaving(true);
    try {
      await api.post(`/api/sla/business-hours/${bh.id}/holidays`, draft);
      setDraft({ date: "", name: "", recurring: false });
      await onChange();
    } catch (err) {
      toast.error(err.message || "Failed");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id) {
    try {
      await api.delete(`/api/sla/business-hours/${bh.id}/holidays/${id}`);
      await onChange();
    } catch (err) {
      toast.error(err.message || "Failed");
    }
  }

  const holidays = bh.holidays || [];
  return (
    <div className="space-y-2">
      <p className="text-xs text-fg-muted">
        Closed all day in {bh.tz}. SLA clocks and escalation delays skip
        these like a weekend. <b>Every year</b> repeats the month and day.
      </p>
      {holidays.length === 0 ? (
        <div className="text-xs text-fg-dim italic">No holidays yet.</div>
      ) : (
        <ul className="divide-y divide-border border border-border rounded">
          {holidays.map((h) => (
            <li key={h.id} className="flex items-center gap-3 px-2 py-1 text-sm">
              <span className="font-mono text-xs w-24">
                {h.recurring ? h.date.slice(5) : h.date}
              </span>
              <span className="flex-1 min-w-0 truncate">{h.name || <span className="text-fg-dim">—</span>}</span>
              {h.recurring && <span className="text-[11px] text-fg-muted">every year</span>}
              <button onClick={() => remove(h.id)} className="text-xs text-red-600 hover:underline">Remove</button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input type="date" value={draft.date}
          onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))}
          className="border border-border-strong rounded px-2 py-1 text-sm font-mono" />
        <input value={draft.name} placeholder="Name (optional)"
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          className="border border-border-strong rounded px-2 py-1 text-sm w-48" />
        <label className="flex items-center gap-1 text-xs text-fg-muted">
          <input type="checkbox" checked={draft.recurring}
            onChange={(e) => setDraft((d) => ({ ...d, recurring: e.target.checked }))} />
          Every year
        </label>
        <button onClick={add} disabled={saving}
          className="text-xs px-2 py-1 bg-brand text-white rounded disabled:opacity-50">
          Add holiday
        </button>
      </div>
    </div>
  );
}

function BusinessHoursSection({ bhList, projects, locations, onChange }) {
  const [edits, setEdits] = useState({});
  const [addOpen, setAddOpen] = useState(false);
  const [holidaysOpen, setHolidaysOpen] = useState(null);
  const [newBh, setNewBh] = useState({
    name: "",
    scope: "",
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
      const { scope, ...rest } = newBh;
      await api.post("/api/sla/business-hours", { ...rest, ...scopeToBody(scope) });
      toast.success("Added");
      setNewBh({
        name: "", scope: "", tz: "America/Chicago",
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
        times and on each policy's holidays. The org default is seeded
        Mon–Fri 9–5 CT; edit or disable it, or add per-project rows. Pin a
        policy to an SLA via the <b>Business hours</b> column below. A{" "}
        <b>location</b> row overrides the pinned hours for tickets at that
        site (24/7 SLA policies stay 24/7).
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
              <span className="text-xs text-fg-muted">Scope</span>
              <select value={newBh.scope} onChange={e => setNewBh(p => ({ ...p, scope: e.target.value }))}
                className="border border-border-strong rounded px-2 py-1 text-sm">
                <option value="">— org default —</option>
                <optgroup label="Project">
                  {projects.filter(pj => pj.status === "active").map(pj => (
                    <option key={pj.id} value={`p:${pj.id}`}>{pj.prefix} · {pj.name}</option>
                  ))}
                </optgroup>
                {locations.length > 0 && (
                  <optgroup label="Location">
                    {locations.map(l => (
                      <option key={l.id} value={`l:${l.id}`}>
                        {l.company_name ? `${l.company_name} · ` : ""}{l.name}
                      </option>
                    ))}
                  </optgroup>
                )}
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
              const scoped = b.project_id != null || b.location_id != null;
              return (
                <Fragment key={b.id}>
                <tr className="border-t border-border">
                  <td className="py-2 pr-3">
                    <input value={merged.name || ""}
                      onChange={ev => setEdits(prev => ({ ...prev, [b.id]: { ...prev[b.id], name: ev.target.value } }))}
                      className="border border-border-strong rounded px-2 py-1 text-sm w-44" />
                  </td>
                  <td className="py-2 pr-3 text-fg-muted">
                    {scopeLabel(b) || <span className="text-fg-dim">org default</span>}
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
                    <button onClick={() => setHolidaysOpen(o => (o === b.id ? null : b.id))}
                      className="text-xs px-2 py-1 border border-border rounded hover:bg-surface-2 whitespace-nowrap">
                      Holidays ({(b.holidays || []).length})
                    </button>
                    {scoped && (
                      <button onClick={() => deleteBh(b.id)} className="text-xs px-2 py-1 text-red-600 hover:underline">Delete</button>
                    )}
                  </td>
                </tr>
                {holidaysOpen === b.id && (
                  <tr className="bg-surface-2/40">
                    <td colSpan={7} className="px-3 py-3">
                      <HolidaysEditor bh={b} onChange={onChange} />
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

const WEBHOOK_KINDS = [
  { value: "slack", label: "Slack", target: "Incoming webhook URL", placeholder: "https://hooks.slack.com/services/…" },
  { value: "teams", label: "Microsoft Teams", target: "Workflows webhook URL", placeholder: "https://…logic.azure.com/…" },
  { value: "pagerduty", label: "PagerDuty", target: "Integration key (Events API v2)", placeholder: "32-character routing key" },
  { value: "generic", label: "Generic JSON", target: "URL", placeholder: "https://example.com/hooks/resolvd" },
];
const WEBHOOK_EVENTS = [
  { value: "breach_response", label: "Response breached" },
  { value: "breach_resolve", label: "Resolve breached" },
  { value: "warning_response", label: "Response at risk" },
  { value: "warning_resolve", label: "Resolve at risk" },
];
const kindMeta = (k) => WEBHOOK_KINDS.find((x) => x.value === k) || WEBHOOK_KINDS[0];

function emptyWebhook() {
  return { name: "", kind: "slack", target: "", secret: "", project_id: "", events: ["breach_response", "breach_resolve"], max_priority: 5 };
}

function WebhookForm({ value, onChange, projects, isNew }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const meta = kindMeta(value.kind);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-fg-muted">Name</span>
          <input value={value.name} onChange={(e) => set({ name: e.target.value })}
            placeholder="e.g. #support-alerts" className="border border-border-strong rounded px-2 py-1 text-sm w-48" />
        </label>
        {isNew && (
          <label className="flex flex-col gap-1">
            <span className="text-xs text-fg-muted">Destination</span>
            <select value={value.kind} onChange={(e) => set({ kind: e.target.value })}
              className="border border-border-strong rounded px-2 py-1 text-sm">
              {WEBHOOK_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1 flex-1 min-w-[16rem]">
          <span className="text-xs text-fg-muted">
            {meta.target}{!isNew && " (leave blank to keep)"}
          </span>
          <input value={value.target} onChange={(e) => set({ target: e.target.value })}
            placeholder={isNew ? meta.placeholder : value.target_hint || meta.placeholder}
            autoComplete="off" className="border border-border-strong rounded px-2 py-1 text-sm font-mono" />
        </label>
        {value.kind === "generic" && (
          <label className="flex flex-col gap-1">
            <span className="text-xs text-fg-muted">
              Signing secret (optional{!isNew && value.has_secret ? "; set — type to replace" : ""})
            </span>
            <input value={value.secret} onChange={(e) => set({ secret: e.target.value })}
              autoComplete="off" type="password" className="border border-border-strong rounded px-2 py-1 text-sm font-mono w-48" />
          </label>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-fg-muted">Project</span>
          <select value={value.project_id ?? ""} onChange={(e) => set({ project_id: e.target.value })}
            className="border border-border-strong rounded px-2 py-1 text-sm">
            <option value="">All projects</option>
            {projects.filter((p) => p.status === "active").map((p) => (
              <option key={p.id} value={p.id}>{p.prefix} · {p.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-fg-muted">Priorities</span>
          <select value={value.max_priority} onChange={(e) => set({ max_priority: Number(e.target.value) })}
            className="border border-border-strong rounded px-2 py-1 text-sm">
            {[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>{p === 1 ? "P1 only" : p === 5 ? "All (P1–P5)" : `P1–P${p}`}</option>)}
          </select>
        </label>
        <div className="flex flex-wrap gap-2">
          {WEBHOOK_EVENTS.map((ev) => (
            <label key={ev.value} className="flex items-center gap-1 text-xs text-fg-muted">
              <input type="checkbox" checked={value.events.includes(ev.value)}
                onChange={(e) => set({
                  events: e.target.checked
                    ? [...value.events, ev.value]
                    : value.events.filter((x) => x !== ev.value),
                })} />
              {ev.label}
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

function webhookBody(v, isNew) {
  const body = {
    name: v.name,
    project_id: v.project_id ? Number(v.project_id) : null,
    events: v.events,
    max_priority: Number(v.max_priority),
  };
  if (isNew) body.kind = v.kind;
  if (isNew || v.target.trim()) body.target = v.target.trim();
  if (v.kind === "generic" && (isNew ? v.secret : v.secret !== "")) body.secret = v.secret;
  return body;
}

function WebhookDeliveries({ hookId }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    api.get(`/api/sla/webhooks/${hookId}/deliveries`).then(setRows).catch(() => setRows([]));
  }, [hookId]);
  if (!rows) return <div className="text-xs text-fg-dim">Loading…</div>;
  if (!rows.length) return <div className="text-xs text-fg-dim italic">Nothing sent yet.</div>;
  return (
    <ul className="text-xs divide-y divide-border border border-border rounded">
      {rows.map((d) => (
        <li key={d.id} className="flex flex-wrap gap-2 px-2 py-1">
          <span className={d.ok ? "text-green-700 dark:text-green-400" : "text-red-600"}>{d.ok ? "sent" : "failed"}</span>
          <span className="text-fg-muted">{new Date(d.created_at).toLocaleString()}</span>
          <span>{WEBHOOK_EVENTS.find((e) => e.value === d.event)?.label || d.event}</span>
          {d.ticket_ref && <span className="font-mono">{d.ticket_ref}</span>}
          {d.resolved_at && <span className="text-fg-muted">· resolved in PagerDuty</span>}
          {d.error && <span className="text-red-600 truncate max-w-full">{d.error}</span>}
        </li>
      ))}
    </ul>
  );
}

function SlaWebhooksSection({ projects }) {
  const [hooks, setHooks] = useState([]);
  const [draft, setDraft] = useState(null);
  const [editing, setEditing] = useState({});
  const [logOpen, setLogOpen] = useState(null);
  const [busy, setBusy] = useState(null);

  async function load() {
    try {
      setHooks(await api.get("/api/sla/webhooks"));
    } catch (err) {
      toast.error(err.message || "Failed to load webhooks");
    }
  }
  useEffect(() => { load(); }, []);

  async function create() {
    if (!draft.name.trim() || !draft.target.trim()) { toast.error("Name and destination required"); return; }
    if (!draft.events.length) { toast.error("Pick at least one event"); return; }
    try {
      await api.post("/api/sla/webhooks", webhookBody(draft, true));
      toast.success("Webhook added");
      setDraft(null);
      await load();
    } catch (err) {
      toast.error(err.message || "Failed");
    }
  }

  async function save(h) {
    const v = editing[h.id];
    if (!v.events.length) { toast.error("Pick at least one event"); return; }
    try {
      await api.patch(`/api/sla/webhooks/${h.id}`, webhookBody(v, false));
      toast.success("Saved");
      setEditing((p) => { const n = { ...p }; delete n[h.id]; return n; });
      await load();
    } catch (err) {
      toast.error(err.message || "Failed");
    }
  }

  async function toggle(h) {
    try {
      await api.patch(`/api/sla/webhooks/${h.id}`, { enabled: !h.enabled });
      await load();
    } catch (err) {
      toast.error(err.message || "Failed");
    }
  }

  async function remove(h) {
    if (!confirm(`Delete webhook "${h.name}"?`)) return;
    try {
      await api.delete(`/api/sla/webhooks/${h.id}`);
      await load();
    } catch (err) {
      toast.error(err.message || "Failed");
    }
  }

  async function test(h) {
    setBusy(h.id);
    try {
      const r = await api.post(`/api/sla/webhooks/${h.id}/test`, {});
      if (r.ok) toast.success("Test delivered");
      else toast.error(`Test failed: ${r.error}`);
      await load();
    } catch (err) {
      toast.error(err.message || "Failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-base font-semibold text-fg">Breach notifications</h2>
        {!draft && (
          <button onClick={() => setDraft(emptyWebhook())}
            className="text-xs px-2 py-1 border border-border rounded hover:bg-surface-2">+ Add webhook</button>
        )}
      </div>
      <p className="text-xs text-fg-muted mb-3">
        Post to Slack, Microsoft Teams, PagerDuty or any JSON endpoint when a
        ticket breaches (or is about to breach) its SLA, alongside the
        in-app and email alerts. PagerDuty incidents resolve automatically
        once the ticket is resolved. Generic webhooks are signed with
        HMAC-SHA256 over <code>timestamp.body</code> in{" "}
        <code>X-Resolvd-Signature</code> when a secret is set. URLs and keys
        are stored encrypted and need the master key (Admin → Encryption).
      </p>

      {draft && (
        <div className="border border-border rounded p-3 mb-3 space-y-2 bg-surface-2/40">
          <WebhookForm value={draft} onChange={setDraft} projects={projects} isNew />
          <div className="flex gap-2">
            <button onClick={create} className="text-sm px-3 py-1.5 bg-brand text-white rounded">Save webhook</button>
            <button onClick={() => setDraft(null)} className="text-sm px-3 py-1.5 border border-border rounded">Cancel</button>
          </div>
        </div>
      )}

      {hooks.length === 0 && !draft ? (
        <div className="text-sm text-fg-muted">No webhooks yet.</div>
      ) : (
        <div className="divide-y divide-border">
          {hooks.map((h) => (
            <div key={h.id} className="py-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-fg">{h.name}</span>
                <span className="text-xs px-1.5 py-0.5 rounded bg-surface-2 text-fg-muted">{kindMeta(h.kind).label}</span>
                <span className="text-xs font-mono text-fg-dim">{h.target_hint}</span>
                <span className="text-xs text-fg-muted">
                  · {h.project_id ? `${h.project_prefix}` : "all projects"}
                  {" · "}{h.max_priority === 5 ? "all priorities" : `P1–P${h.max_priority}`}
                  {" · "}{h.events.map((e) => WEBHOOK_EVENTS.find((x) => x.value === e)?.label || e).join(", ")}
                </span>
                {h.last_sent_at && (
                  <span className={`text-xs ${h.last_ok ? "text-green-700 dark:text-green-400" : "text-red-600"}`}
                    title={h.last_error || ""}>
                    · last {h.last_ok ? "sent" : "failed"} {new Date(h.last_sent_at).toLocaleString()}
                  </span>
                )}
                <div className="ml-auto flex items-center gap-2">
                  <label className="flex items-center gap-1 text-xs text-fg-muted">
                    <input type="checkbox" checked={h.enabled} onChange={() => toggle(h)} /> Enabled
                  </label>
                  <button onClick={() => test(h)} disabled={busy === h.id}
                    className="text-xs px-2 py-1 border border-border rounded hover:bg-surface-2 disabled:opacity-50">
                    {busy === h.id ? "Sending…" : "Send test"}
                  </button>
                  <button onClick={() => setLogOpen((o) => (o === h.id ? null : h.id))}
                    className="text-xs px-2 py-1 border border-border rounded hover:bg-surface-2">Log</button>
                  {!editing[h.id] && (
                    <button onClick={() => setEditing((p) => ({
                      ...p,
                      [h.id]: { ...h, target: "", secret: "", project_id: h.project_id ?? "" },
                    }))} className="text-xs px-2 py-1 border border-border rounded hover:bg-surface-2">Edit</button>
                  )}
                  <button onClick={() => remove(h)} className="text-xs px-2 py-1 text-red-600 hover:underline">Delete</button>
                </div>
              </div>
              {editing[h.id] && (
                <div className="border border-border rounded p-3 space-y-2 bg-surface-2/40">
                  <WebhookForm value={editing[h.id]} projects={projects}
                    onChange={(v) => setEditing((p) => ({ ...p, [h.id]: v }))} />
                  <div className="flex gap-2">
                    <button onClick={() => save(h)} className="text-sm px-3 py-1.5 bg-brand text-white rounded">Save</button>
                    <button onClick={() => setEditing((p) => { const n = { ...p }; delete n[h.id]; return n; })}
                      className="text-sm px-3 py-1.5 border border-border rounded">Cancel</button>
                  </div>
                </div>
              )}
              {logOpen === h.id && <WebhookDeliveries hookId={h.id} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

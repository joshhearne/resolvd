import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";

// Escalation chain admin. Step rows are grouped by (priority, project,
// trigger) for readability; each row's step_order drives execution
// order inside its group. delay_minutes is the grace period after the
// trigger fires before this step runs.

const PRIORITY_LABELS = {
  1: "P1 (Critical)",
  2: "P2 (High)",
  3: "P3 (Normal)",
  4: "P4 (Low)",
  5: "P5 (Cosmetic)",
};

const TRIGGER_LABELS = {
  warning_response: "Warning — response",
  warning_resolve: "Warning — resolve",
  breach_response: "Breach — response",
  breach_resolve: "Breach — resolve",
};

const ACTIONS = [
  { value: "notify_user", label: "Notify user" },
  { value: "notify_role", label: "Notify role" },
  { value: "reassign_user", label: "Reassign to user" },
  { value: "reassign_role", label: "Reassign to role" },
];

const TARGETABLE_ROLES = ["Admin", "Manager", "Tech"];

export default function AdminEscalationPolicies() {
  const [steps, setSteps] = useState([]);
  const [projects, setProjects] = useState([]);
  const [globalAgents, setGlobalAgents] = useState([]);
  const [agentsByProject, setAgentsByProject] = useState({});
  const [loading, setLoading] = useState(true);
  const [edits, setEdits] = useState({});
  const [newRow, setNewRow] = useState({
    priority: 1,
    project_id: "",
    trigger: "warning_response",
    step_order: 1,
    delay_minutes: 0,
    action: "notify_role",
    target_user_id: "",
    target_role: "Manager",
  });

  async function loadProjectAgents(projectId) {
    if (!projectId || agentsByProject[projectId]) return;
    try {
      const list = await api.get(`/api/agents/project/${projectId}`);
      setAgentsByProject((prev) => ({ ...prev, [projectId]: list }));
    } catch (e) {
      toast.error(e.message || "Failed to load agents");
    }
  }

  async function load() {
    setLoading(true);
    try {
      const [list, pjs, agents] = await Promise.all([
        api.get("/api/escalation-policies"),
        api.get("/api/projects"),
        api.get("/api/agents"),
      ]);
      setSteps(list);
      setProjects(pjs);
      setGlobalAgents(agents);
      const ids = Array.from(new Set(list.filter((s) => s.project_id).map((s) => s.project_id)));
      for (const pid of ids) {
        api.get(`/api/agents/project/${pid}`)
          .then((agents) => setAgentsByProject((prev) => ({ ...prev, [pid]: agents })))
          .catch(() => {});
      }
    } catch (e) {
      toast.error(e.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (newRow.project_id) loadProjectAgents(newRow.project_id);
  }, [newRow.project_id]);

  function usersForStep(s) {
    return s.project_id ? (agentsByProject[s.project_id] || []) : globalAgents;
  }

  const grouped = useMemo(() => {
    const map = new Map();
    for (const s of steps) {
      const key = `${s.project_id ?? "org"}|${s.priority}|${s.trigger}`;
      if (!map.has(key)) map.set(key, { key, project: s.project_id == null ? null : { id: s.project_id, name: s.project_name, prefix: s.project_prefix }, priority: s.priority, trigger: s.trigger, items: [] });
      map.get(key).items.push(s);
    }
    return Array.from(map.values()).map((g) => ({
      ...g,
      items: g.items.sort((a, b) => a.step_order - b.step_order || a.id - b.id),
    }));
  }, [steps]);

  async function saveStep(s) {
    const e = edits[s.id];
    if (!e) return;
    const body = { ...e };
    // Normalize select-empty-string → null for the optional fields.
    if (body.target_user_id === "") body.target_user_id = null;
    else if (body.target_user_id !== undefined) body.target_user_id = Number(body.target_user_id);
    if (body.target_role === "") body.target_role = null;
    if (body.delay_minutes !== undefined) body.delay_minutes = Number(body.delay_minutes);
    if (body.step_order !== undefined) body.step_order = Number(body.step_order);
    try {
      await api.patch(`/api/escalation-policies/${s.id}`, body);
      toast.success("Saved");
      setEdits((prev) => { const n = { ...prev }; delete n[s.id]; return n; });
      await load();
    } catch (err) {
      toast.error(err.message || "Failed");
    }
  }

  async function deleteStep(id) {
    if (!confirm("Delete this step?")) return;
    try {
      await api.delete(`/api/escalation-policies/${id}`);
      toast.success("Deleted");
      await load();
    } catch (err) {
      toast.error(err.message || "Failed");
    }
  }

  async function addStep() {
    try {
      const body = {
        priority: Number(newRow.priority),
        project_id: newRow.project_id ? Number(newRow.project_id) : null,
        trigger: newRow.trigger,
        step_order: Number(newRow.step_order) || 1,
        delay_minutes: Number(newRow.delay_minutes) || 0,
        action: newRow.action,
        target_user_id: newRow.target_user_id ? Number(newRow.target_user_id) : null,
        target_role: newRow.target_role || null,
        enabled: true,
      };
      await api.post("/api/escalation-policies", body);
      toast.success("Step added");
      setNewRow((p) => ({ ...p, step_order: p.step_order + 1 }));
      await load();
    } catch (err) {
      toast.error(err.message || "Failed");
    }
  }

  function targetNeedsUser(action) {
    return action === "notify_user" || action === "reassign_user";
  }
  function targetNeedsRole(action) {
    return action === "notify_role" || action === "reassign_role";
  }

  function StepRow({ s }) {
    const e = edits[s.id] || {};
    const merged = { ...s, ...e };
    const dirty = !!Object.keys(e).length;
    const users = usersForStep(s);
    return (
      <tr className="border-t border-border align-top">
        <td className="py-2 pr-3">
          <input
            type="number" min="1"
            value={merged.step_order}
            onChange={(ev) => setEdits((prev) => ({ ...prev, [s.id]: { ...prev[s.id], step_order: ev.target.value } }))}
            className="border border-border-strong rounded px-2 py-1 text-sm font-mono w-16"
          />
        </td>
        <td className="py-2 pr-3">
          <input
            type="number" min="0"
            value={merged.delay_minutes}
            onChange={(ev) => setEdits((prev) => ({ ...prev, [s.id]: { ...prev[s.id], delay_minutes: ev.target.value } }))}
            className="border border-border-strong rounded px-2 py-1 text-sm font-mono w-20"
          />
          <span className="ml-1 text-xs text-fg-muted">min</span>
        </td>
        <td className="py-2 pr-3">
          <select
            value={merged.action}
            onChange={(ev) => setEdits((prev) => ({ ...prev, [s.id]: { ...prev[s.id], action: ev.target.value } }))}
            className="border border-border-strong rounded px-2 py-1 text-sm"
          >
            {ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
        </td>
        <td className="py-2 pr-3 min-w-[12rem]">
          {targetNeedsUser(merged.action) && (
            <select
              value={merged.target_user_id || ""}
              onChange={(ev) => setEdits((prev) => ({ ...prev, [s.id]: { ...prev[s.id], target_user_id: ev.target.value } }))}
              className="border border-border-strong rounded px-2 py-1 text-sm w-full"
            >
              <option value="">— pick user —</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.display_name} ({u.role})</option>)}
            </select>
          )}
          {targetNeedsRole(merged.action) && (
            <select
              value={merged.target_role || ""}
              onChange={(ev) => setEdits((prev) => ({ ...prev, [s.id]: { ...prev[s.id], target_role: ev.target.value } }))}
              className="border border-border-strong rounded px-2 py-1 text-sm w-full"
            >
              <option value="">— pick role —</option>
              {TARGETABLE_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          )}
        </td>
        <td className="py-2 pr-3">
          <input
            type="checkbox" checked={!!merged.enabled}
            onChange={(ev) => setEdits((prev) => ({ ...prev, [s.id]: { ...prev[s.id], enabled: ev.target.checked } }))}
          />
        </td>
        <td className="py-2 flex gap-2">
          {dirty && <button onClick={() => saveStep(s)} className="text-xs px-2 py-1 bg-brand text-white rounded">Save</button>}
          <button onClick={() => deleteStep(s.id)} className="text-xs px-2 py-1 text-red-600 hover:underline">Delete</button>
        </td>
      </tr>
    );
  }

  return (
    <div className="space-y-5">
      <div className="bg-surface border border-border rounded-lg p-4">
        <h2 className="text-base font-semibold text-fg mb-1">Escalation chains</h2>
        <p className="text-xs text-fg-muted mb-3">
          Steps fire when an SLA trigger occurs on a matching ticket
          (priority + project). Project-scoped steps run alongside org
          defaults additively — both apply. <code>delay_minutes</code>{" "}
          is the grace period after the trigger before the step fires.
          Steps within a group execute by <code>step_order</code> and
          only fire once per ticket.
        </p>

        <div className="border border-border rounded p-3 mb-4 bg-surface-2/40">
          <h3 className="text-xs font-semibold text-fg-muted mb-2 uppercase">Add step</h3>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">Scope</span>
              <select value={newRow.project_id} onChange={(e) => setNewRow((p) => ({ ...p, project_id: e.target.value }))}
                className="border border-border-strong rounded px-2 py-1 text-sm">
                <option value="">Org default</option>
                {projects.filter((pj) => pj.status === "active").map((pj) => (
                  <option key={pj.id} value={pj.id}>{pj.prefix} · {pj.name}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">Priority</span>
              <select value={newRow.priority} onChange={(e) => setNewRow((p) => ({ ...p, priority: Number(e.target.value) }))}
                className="border border-border-strong rounded px-2 py-1 text-sm">
                {[1, 2, 3, 4, 5].map((i) => <option key={i} value={i}>{PRIORITY_LABELS[i]}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">Trigger</span>
              <select value={newRow.trigger} onChange={(e) => setNewRow((p) => ({ ...p, trigger: e.target.value }))}
                className="border border-border-strong rounded px-2 py-1 text-sm">
                {Object.entries(TRIGGER_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">Step order</span>
              <input type="number" min="1" value={newRow.step_order}
                onChange={(e) => setNewRow((p) => ({ ...p, step_order: e.target.value }))}
                className="border border-border-strong rounded px-2 py-1 text-sm font-mono w-20" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">Delay (min)</span>
              <input type="number" min="0" value={newRow.delay_minutes}
                onChange={(e) => setNewRow((p) => ({ ...p, delay_minutes: e.target.value }))}
                className="border border-border-strong rounded px-2 py-1 text-sm font-mono w-20" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">Action</span>
              <select value={newRow.action} onChange={(e) => setNewRow((p) => ({ ...p, action: e.target.value }))}
                className="border border-border-strong rounded px-2 py-1 text-sm">
                {ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
            </label>
            {targetNeedsUser(newRow.action) && (
              <label className="flex flex-col gap-1">
                <span className="text-xs text-fg-muted">User</span>
                <select value={newRow.target_user_id} onChange={(e) => setNewRow((p) => ({ ...p, target_user_id: e.target.value }))}
                  className="border border-border-strong rounded px-2 py-1 text-sm">
                  <option value="">— pick —</option>
                  {(newRow.project_id ? (agentsByProject[newRow.project_id] || []) : globalAgents).map((u) => (
                    <option key={u.id} value={u.id}>{u.display_name} ({u.role})</option>
                  ))}
                </select>
              </label>
            )}
            {targetNeedsRole(newRow.action) && (
              <label className="flex flex-col gap-1">
                <span className="text-xs text-fg-muted">Role</span>
                <select value={newRow.target_role} onChange={(e) => setNewRow((p) => ({ ...p, target_role: e.target.value }))}
                  className="border border-border-strong rounded px-2 py-1 text-sm">
                  {TARGETABLE_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </label>
            )}
            <button onClick={addStep} className="px-3 py-1.5 text-sm bg-brand text-white rounded">Add</button>
          </div>
        </div>

        {loading ? (
          <div className="text-sm text-fg-muted">Loading…</div>
        ) : grouped.length === 0 ? (
          <div className="text-sm text-fg-muted">No escalation steps configured.</div>
        ) : (
          <div className="space-y-4">
            {grouped.map((g) => (
              <div key={g.key} className="border border-border rounded">
                <div className="px-3 py-2 bg-surface-2/40 text-xs text-fg-muted flex items-center gap-3 flex-wrap">
                  <span>{g.project ? <b>{g.project.prefix} · {g.project.name}</b> : <b className="italic">Org default</b>}</span>
                  <span>·</span>
                  <span>{PRIORITY_LABELS[g.priority]}</span>
                  <span>·</span>
                  <span>{TRIGGER_LABELS[g.trigger]}</span>
                  <span className="ml-auto">{g.items.length} step{g.items.length === 1 ? "" : "s"}</span>
                </div>
                <table className="w-full text-sm">
                  <thead className="text-xs text-fg-muted">
                    <tr>
                      <th className="text-left py-1 pl-3">Order</th>
                      <th className="text-left py-1">Delay</th>
                      <th className="text-left py-1">Action</th>
                      <th className="text-left py-1">Target</th>
                      <th className="text-left py-1">On</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.items.map((s) => <StepRow key={s.id} s={s} />)}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";

// Escalation chain admin. Step rows grouped by (priority, project,
// trigger). delay_minutes = grace period after the trigger fires.
// Each step now carries an actions[] array — fan out to multiple
// targets on the same (trigger, delay) without duplicating rows.

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

const ACTION_KINDS = [
  { value: "notify_assignee", label: "Notify assignee" },
  { value: "notify_user", label: "Notify user" },
  { value: "notify_role", label: "Notify role" },
  { value: "reassign_user", label: "Reassign to user" },
  { value: "reassign_role", label: "Reassign to role" },
];

const PRIORITY_OPS = ["=", "<=", ">=", "<", ">"];
const TARGETABLE_ROLES = ["Admin", "Manager", "Tech"];

function needsUser(kind) {
  return kind === "notify_user" || kind === "reassign_user";
}
function needsRole(kind) {
  return kind === "notify_role" || kind === "reassign_role";
}
function defaultAction() {
  return { kind: "notify_assignee" };
}
function actionSummary(a) {
  if (!a?.kind) return "(empty)";
  if (a.kind === "notify_assignee") return "Notify assignee";
  if (a.kind === "notify_user") return `Notify user #${a.target_user_id ?? "?"}`;
  if (a.kind === "notify_role") return `Notify ${a.target_role ?? "?"}`;
  if (a.kind === "reassign_user") return `Reassign → user #${a.target_user_id ?? "?"}`;
  if (a.kind === "reassign_role") return `Reassign → first ${a.target_role ?? "?"}`;
  return a.kind;
}

export default function AdminEscalationPolicies() {
  const [steps, setSteps] = useState([]);
  const [projects, setProjects] = useState([]);
  const [globalAgents, setGlobalAgents] = useState([]);
  const [agentsByProject, setAgentsByProject] = useState({});
  const [loading, setLoading] = useState(true);
  const [edits, setEdits] = useState({});
  const [newRow, setNewRow] = useState({
    priority: 1,
    priority_op: "=",
    project_id: "",
    trigger: "warning_response",
    step_order: 1,
    delay_minutes: 0,
    actions: [defaultAction()],
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
          .then((a) => setAgentsByProject((prev) => ({ ...prev, [pid]: a })))
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
      const op = s.priority_op || "=";
      const key = `${s.project_id ?? "org"}|${op}${s.priority}|${s.trigger}`;
      if (!map.has(key)) map.set(key, {
        key,
        project: s.project_id == null ? null : { id: s.project_id, name: s.project_name, prefix: s.project_prefix },
        priority: s.priority,
        priority_op: op,
        trigger: s.trigger,
        items: [],
      });
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
    if (body.delay_minutes !== undefined) body.delay_minutes = Number(body.delay_minutes);
    if (body.step_order !== undefined) body.step_order = Number(body.step_order);
    // Validate every action target before sending.
    const actions = body.actions ?? s.actions ?? [];
    for (const a of actions) {
      if (needsUser(a.kind) && !a.target_user_id) {
        toast.error(`${a.kind}: pick a user`);
        return;
      }
      if (needsRole(a.kind) && !a.target_role) {
        toast.error(`${a.kind}: pick a role`);
        return;
      }
    }
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
    for (const a of newRow.actions) {
      if (needsUser(a.kind) && !a.target_user_id) { toast.error(`${a.kind}: pick a user`); return; }
      if (needsRole(a.kind) && !a.target_role) { toast.error(`${a.kind}: pick a role`); return; }
    }
    try {
      const body = {
        priority: Number(newRow.priority),
        priority_op: newRow.priority_op,
        project_id: newRow.project_id ? Number(newRow.project_id) : null,
        trigger: newRow.trigger,
        step_order: Number(newRow.step_order) || 1,
        delay_minutes: Number(newRow.delay_minutes) || 0,
        actions: newRow.actions.map((a) => ({
          kind: a.kind,
          ...(a.target_user_id ? { target_user_id: Number(a.target_user_id) } : {}),
          ...(a.target_role ? { target_role: a.target_role } : {}),
        })),
        enabled: true,
      };
      await api.post("/api/escalation-policies", body);
      toast.success("Step added");
      setNewRow((p) => ({
        ...p,
        step_order: p.step_order + 1,
        actions: [defaultAction()],
      }));
      await load();
    } catch (err) {
      toast.error(err.message || "Failed");
    }
  }

  // Action-list editor — shared between StepRow edit + Add-step form.
  function ActionList({ actions, onChange, users }) {
    function setAction(i, patch) {
      const next = actions.map((a, idx) => idx === i ? { ...a, ...patch } : a);
      onChange(next);
    }
    function removeAction(i) {
      if (actions.length === 1) return; // keep at least one row
      onChange(actions.filter((_, idx) => idx !== i));
    }
    function addAction() {
      onChange([...actions, defaultAction()]);
    }
    return (
      <div className="space-y-1.5">
        {actions.map((a, i) => (
          <div key={i} className="flex flex-wrap items-center gap-1.5">
            <select
              value={a.kind}
              onChange={(e) => {
                const k = e.target.value;
                setAction(i, {
                  kind: k,
                  target_user_id: needsUser(k) ? a.target_user_id : undefined,
                  target_role: needsRole(k) ? a.target_role : undefined,
                });
              }}
              className="border border-border-strong rounded px-2 py-1 text-sm"
            >
              {ACTION_KINDS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
            {needsUser(a.kind) && (
              <select
                value={a.target_user_id || ""}
                onChange={(e) => setAction(i, { target_user_id: e.target.value })}
                className="border border-border-strong rounded px-2 py-1 text-sm min-w-[10rem]"
              >
                <option value="">— pick user —</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.display_name} ({u.role})</option>)}
              </select>
            )}
            {needsRole(a.kind) && (
              <select
                value={a.target_role || ""}
                onChange={(e) => setAction(i, { target_role: e.target.value })}
                className="border border-border-strong rounded px-2 py-1 text-sm"
              >
                <option value="">— pick role —</option>
                {TARGETABLE_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            )}
            {actions.length > 1 && (
              <button type="button" onClick={() => removeAction(i)}
                className="text-xs text-red-600 hover:underline px-1">×</button>
            )}
          </div>
        ))}
        <button type="button" onClick={addAction}
          className="text-xs text-brand hover:underline">+ Add action</button>
      </div>
    );
  }

  function StepRow({ s }) {
    const e = edits[s.id] || {};
    const merged = { ...s, ...e };
    const dirty = !!Object.keys(e).length;
    const users = usersForStep(s);
    const actions = Array.isArray(merged.actions) && merged.actions.length
      ? merged.actions
      : [defaultAction()];

    function setEdit(patch) {
      setEdits((prev) => ({ ...prev, [s.id]: { ...prev[s.id], ...patch } }));
    }

    return (
      <tr className="border-t border-border align-top">
        <td className="py-2 pr-3">
          <input
            type="number" min="1"
            value={merged.step_order}
            onChange={(ev) => setEdit({ step_order: ev.target.value })}
            className="border border-border-strong rounded px-2 py-1 text-sm font-mono w-16"
          />
        </td>
        <td className="py-2 pr-3">
          <input
            type="number" min="0"
            value={merged.delay_minutes}
            onChange={(ev) => setEdit({ delay_minutes: ev.target.value })}
            className="border border-border-strong rounded px-2 py-1 text-sm font-mono w-20"
          />
          <span className="ml-1 text-xs text-fg-muted">min</span>
        </td>
        <td className="py-2 pr-3 min-w-[18rem]">
          <ActionList
            actions={actions}
            users={users}
            onChange={(next) => setEdit({ actions: next })}
          />
        </td>
        <td className="py-2 pr-3">
          <input
            type="checkbox" checked={!!merged.enabled}
            onChange={(ev) => setEdit({ enabled: ev.target.checked })}
          />
        </td>
        <td className="py-2 flex gap-2">
          {dirty && <button onClick={() => saveStep(s)} className="text-xs px-2 py-1 bg-brand text-white rounded">Save</button>}
          <button onClick={() => deleteStep(s.id)} className="text-xs px-2 py-1 text-red-600 hover:underline">Delete</button>
        </td>
      </tr>
    );
  }

  const newRowUsers = newRow.project_id
    ? (agentsByProject[newRow.project_id] || [])
    : globalAgents;

  return (
    <div className="space-y-5">
      <div className="bg-surface border border-border rounded-lg p-4">
        <h2 className="text-base font-semibold text-fg mb-1">Escalation chains</h2>
        <p className="text-xs text-fg-muted mb-3">
          Steps fire when an SLA trigger occurs on a matching ticket
          (priority + project). Project-scoped steps run alongside
          Org-Wide steps additively — both apply.{" "}
          <code>delay_minutes</code> is the grace period after the
          trigger before the step fires. Each step can run{" "}
          <b>multiple actions</b> (notify + reassign + notify) on the
          same firing. <b>Role targets</b> (Notify role / Reassign role)
          always resolve to <i>the triggering ticket's</i> project
          members — Org-Wide steps don't broadcast across every project.
        </p>

        <div className="border border-border rounded p-3 mb-4 bg-surface-2/40">
          <h3 className="text-xs font-semibold text-fg-muted mb-2 uppercase">Add step</h3>
          <div className="flex flex-wrap items-end gap-2 mb-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">Scope</span>
              <select value={newRow.project_id} onChange={(e) => setNewRow((p) => ({ ...p, project_id: e.target.value }))}
                className="border border-border-strong rounded px-2 py-1 text-sm">
                <option value="">Org-Wide</option>
                {projects.filter((pj) => pj.status === "active").map((pj) => (
                  <option key={pj.id} value={pj.id}>{pj.prefix} · {pj.name}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">Op</span>
              <select value={newRow.priority_op} onChange={(e) => setNewRow((p) => ({ ...p, priority_op: e.target.value }))}
                className="border border-border-strong rounded px-2 py-1 text-sm font-mono w-16">
                {PRIORITY_OPS.map((op) => <option key={op} value={op}>{op}</option>)}
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
          </div>
          <div className="space-y-1">
            <span className="text-xs text-fg-muted">Actions (fire all on each trigger)</span>
            <ActionList
              actions={newRow.actions}
              users={newRowUsers}
              onChange={(next) => setNewRow((p) => ({ ...p, actions: next }))}
            />
          </div>
          <div className="mt-3">
            <button onClick={addStep} className="px-3 py-1.5 text-sm bg-brand text-white rounded">Add step</button>
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
                  <span>{g.project ? <b>{g.project.prefix} · {g.project.name}</b> : <b className="italic">Org-Wide</b>}</span>
                  <span>·</span>
                  <span>
                    <code className="font-mono">{g.priority_op}</code> {PRIORITY_LABELS[g.priority]}
                  </span>
                  <span>·</span>
                  <span>{TRIGGER_LABELS[g.trigger]}</span>
                  <span className="ml-auto">{g.items.length} step{g.items.length === 1 ? "" : "s"}</span>
                </div>
                <table className="w-full text-sm">
                  <thead className="text-xs text-fg-muted">
                    <tr>
                      <th className="text-left py-1 pl-3">Order</th>
                      <th className="text-left py-1">Delay</th>
                      <th className="text-left py-1">Actions</th>
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

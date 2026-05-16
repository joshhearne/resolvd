import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";

// Auto-assignment policies admin. Per (priority, project) pick a
// strategy (round_robin / case_load / specific_user) and an agent pool.
// On ticket create, an explicit assignee in the request always wins;
// otherwise the policy is consulted; otherwise the project default
// fills in. No rows are seeded — assignment is opt-in.

const PRIORITY_LABELS = {
  1: "P1 (Critical)",
  2: "P2 (High)",
  3: "P3 (Normal)",
  4: "P4 (Low)",
  5: "P5 (Cosmetic)",
};

const STRATEGIES = [
  { value: "round_robin", label: "Round-robin" },
  { value: "case_load", label: "Lowest case load" },
  { value: "specific_user", label: "Specific user" },
];

const PRIORITY_OPS = ["=", "<=", ">=", "<", ">"];

// Eligible assignees are project members with is_agent = TRUE. For
// project-scoped policies we fetch agents on that specific project;
// for org-default policies we use the global agent set (anyone who is
// an agent on at least one project). The previous role-based filter
// (Admin/Manager/Tech) is replaced by this opt-in flag so admins can
// fine-tune assignability without changing a user's global role.

export default function AdminAssignmentPolicies() {
  const [policies, setPolicies] = useState([]);
  const [projects, setProjects] = useState([]);
  const [globalAgents, setGlobalAgents] = useState([]);
  // Cache of project_id → agents[] so we only fetch per-project lists
  // on demand and don't re-fetch each render.
  const [agentsByProject, setAgentsByProject] = useState({});
  const [loading, setLoading] = useState(true);
  const [newRow, setNewRow] = useState({ priority: 3, priority_op: "=", project_id: "", strategy: "specific_user" });
  const [edits, setEdits] = useState({});

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
      const [pList, pjList, agents] = await Promise.all([
        api.get("/api/assignment-policies"),
        api.get("/api/projects"),
        api.get("/api/agents"),
      ]);
      setPolicies(pList);
      setProjects(pjList);
      setGlobalAgents(agents);
      // Pre-warm cache for projects already referenced by existing policies.
      const projectIds = Array.from(new Set(pList.filter((p) => p.project_id).map((p) => p.project_id)));
      for (const pid of projectIds) {
        api.get(`/api/agents/project/${pid}`)
          .then((list) => setAgentsByProject((prev) => ({ ...prev, [pid]: list })))
          .catch(() => {});
      }
    } catch (e) {
      toast.error(e.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);
  // Prefetch agents when the user picks a project for the "add policy" form.
  useEffect(() => {
    if (newRow.project_id) loadProjectAgents(newRow.project_id);
  }, [newRow.project_id]);

  function usersForPolicy(p) {
    return p.project_id ? (agentsByProject[p.project_id] || []) : globalAgents;
  }

  async function saveRow(p) {
    const e = edits[p.id];
    if (!e) return;
    try {
      await api.patch(`/api/assignment-policies/${p.id}`, e);
      toast.success("Saved");
      setEdits((prev) => { const n = { ...prev }; delete n[p.id]; return n; });
      await load();
    } catch (err) {
      toast.error(err.message || "Failed");
    }
  }

  async function addPolicy() {
    try {
      const body = {
        priority: Number(newRow.priority),
        priority_op: newRow.priority_op,
        project_id: newRow.project_id ? Number(newRow.project_id) : null,
        strategy: newRow.strategy,
        agent_pool: [],
        enabled: true,
      };
      await api.post("/api/assignment-policies", body);
      toast.success("Policy added — set pool / user below");
      setNewRow({ priority: 3, priority_op: "=", project_id: "", strategy: "specific_user" });
      await load();
    } catch (err) {
      toast.error(err.message || "Failed");
    }
  }

  async function deletePolicy(id) {
    if (!confirm("Delete this policy?")) return;
    try {
      await api.delete(`/api/assignment-policies/${id}`);
      toast.success("Deleted");
      await load();
    } catch (err) {
      toast.error(err.message || "Failed");
    }
  }

  function PolicyRow({ p }) {
    const e = edits[p.id] || {};
    const merged = { ...p, ...e };
    const dirty = !!Object.keys(e).length;
    const pool = merged.agent_pool || [];
    const users = usersForPolicy(p);
    return (
      <tr className="border-t border-border align-top">
        <td className="py-2 pr-3">
          {p.project_id == null
            ? <span className="text-fg-dim italic">Org default</span>
            : `${p.project_prefix} · ${p.project_name}`}
        </td>
        <td className="py-2 pr-3 whitespace-nowrap">
          <div className="flex items-center gap-1">
            <select
              value={merged.priority_op || "="}
              onChange={(ev) => setEdits((prev) => ({ ...prev, [p.id]: { ...prev[p.id], priority_op: ev.target.value } }))}
              className="border border-border-strong rounded px-1.5 py-1 text-sm font-mono w-14"
              title="Priority operator"
            >
              {PRIORITY_OPS.map((op) => <option key={op} value={op}>{op}</option>)}
            </select>
            <span className="font-medium">{PRIORITY_LABELS[p.priority]}</span>
          </div>
        </td>
        <td className="py-2 pr-3">
          <select
            value={merged.strategy}
            onChange={(ev) => setEdits((prev) => ({ ...prev, [p.id]: { ...prev[p.id], strategy: ev.target.value } }))}
            className="border border-border-strong rounded px-2 py-1 text-sm"
          >
            {STRATEGIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </td>
        <td className="py-2 pr-3 min-w-[14rem]">
          {merged.strategy === "specific_user" ? (
            <select
              value={merged.specific_user_id || ""}
              onChange={(ev) => setEdits((prev) => ({ ...prev, [p.id]: { ...prev[p.id], specific_user_id: ev.target.value ? Number(ev.target.value) : null } }))}
              className="border border-border-strong rounded px-2 py-1 text-sm w-full"
            >
              <option value="">— pick user —</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.display_name} ({u.role})</option>)}
            </select>
          ) : (
            <div className="space-y-1">
              <div className="text-xs text-fg-muted">
                {pool.length} in pool {merged.strategy === "round_robin" && `· cursor ${merged.round_robin_cursor ?? 0}`}
              </div>
              <div className="flex flex-wrap gap-1">
                {users.map((u) => {
                  const on = pool.includes(u.id);
                  return (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => {
                        const next = new Set(pool);
                        if (on) next.delete(u.id); else next.add(u.id);
                        setEdits((prev) => ({ ...prev, [p.id]: { ...prev[p.id], agent_pool: Array.from(next) } }));
                      }}
                      className={`px-2 py-0.5 text-xs rounded border ${on ? "bg-brand text-white border-brand" : "border-border hover:bg-surface-2"}`}
                    >
                      {u.display_name}
                    </button>
                  );
                })}
              </div>
              {merged.strategy === "round_robin" && (
                <button
                  type="button"
                  onClick={() => setEdits((prev) => ({ ...prev, [p.id]: { ...prev[p.id], round_robin_cursor: 0 } }))}
                  className="text-[11px] text-fg-muted hover:text-fg underline"
                >
                  Reset cursor
                </button>
              )}
            </div>
          )}
        </td>
        <td className="py-2 pr-3">
          <input
            type="checkbox"
            checked={!!merged.enabled}
            onChange={(ev) => setEdits((prev) => ({ ...prev, [p.id]: { ...prev[p.id], enabled: ev.target.checked } }))}
          />
        </td>
        <td className="py-2 flex gap-2 items-start">
          {dirty && <button onClick={() => saveRow(p)} className="text-xs px-2 py-1 bg-brand text-white rounded">Save</button>}
          <button onClick={() => deletePolicy(p.id)} className="text-xs px-2 py-1 text-red-600 hover:underline">Delete</button>
        </td>
      </tr>
    );
  }

  return (
    <div className="space-y-5">
      <div className="bg-surface border border-border rounded-lg p-4">
        <h2 className="text-base font-semibold text-fg mb-1">Auto-assignment policies</h2>
        <p className="text-xs text-fg-muted mb-3">
          Pick an agent automatically at ticket create time based on
          priority + project. Explicit assignee in the request always
          wins; project <code>default_assignee_id</code> fills in only
          when no policy matched. Strategies:
        </p>
        <ul className="text-xs text-fg-muted list-disc list-inside mb-3 space-y-0.5">
          <li><b>Round-robin</b> — cycle through the pool in order.</li>
          <li><b>Lowest case load</b> — pick whoever has fewest open tickets right now.</li>
          <li><b>Specific user</b> — always assign to this person.</li>
        </ul>
        <p className="text-xs text-fg-muted mb-3">
          The priority operator widens a rule across priorities — e.g.{" "}
          <code>{"<= P2"}</code> covers P1 + P2. When multiple rules match,
          project-scoped beats org-default, then exact <code>=</code> beats
          range, then newest beats older.
        </p>

        <div className="border border-border rounded p-3 mb-4 bg-surface-2/40">
          <h3 className="text-xs font-semibold text-fg-muted mb-2 uppercase">Add policy</h3>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">Scope</span>
              <select
                value={newRow.project_id}
                onChange={(e) => setNewRow((p) => ({ ...p, project_id: e.target.value }))}
                className="border border-border-strong rounded px-2 py-1 text-sm"
              >
                <option value="">Org default</option>
                {projects.filter((pj) => pj.status === "active").map((pj) => (
                  <option key={pj.id} value={pj.id}>{pj.prefix} · {pj.name}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">Op</span>
              <select
                value={newRow.priority_op}
                onChange={(e) => setNewRow((p) => ({ ...p, priority_op: e.target.value }))}
                className="border border-border-strong rounded px-2 py-1 text-sm font-mono w-16"
                title="Match operator vs ticket priority"
              >
                {PRIORITY_OPS.map((op) => <option key={op} value={op}>{op}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">Priority</span>
              <select
                value={newRow.priority}
                onChange={(e) => setNewRow((p) => ({ ...p, priority: Number(e.target.value) }))}
                className="border border-border-strong rounded px-2 py-1 text-sm"
              >
                {[1, 2, 3, 4, 5].map((i) => <option key={i} value={i}>{PRIORITY_LABELS[i]}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">Strategy</span>
              <select
                value={newRow.strategy}
                onChange={(e) => setNewRow((p) => ({ ...p, strategy: e.target.value }))}
                className="border border-border-strong rounded px-2 py-1 text-sm"
              >
                {STRATEGIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </label>
            <button onClick={addPolicy} className="px-3 py-1.5 text-sm bg-brand text-white rounded">Add</button>
          </div>
        </div>

        {loading ? (
          <div className="text-sm text-fg-muted">Loading…</div>
        ) : policies.length === 0 ? (
          <div className="text-sm text-fg-muted">No assignment policies configured.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-fg-muted">
              <tr>
                <th className="text-left py-1">Scope</th>
                <th className="text-left py-1">Match priority</th>
                <th className="text-left py-1">Strategy</th>
                <th className="text-left py-1">Assignment target</th>
                <th className="text-left py-1">On</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => <PolicyRow key={p.id} p={p} />)}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

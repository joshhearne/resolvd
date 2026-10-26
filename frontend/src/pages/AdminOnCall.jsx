import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";

// On-call rotations. A rotation cycles its members in order, one shift
// each, starting at the handoff time; overrides put someone on call for
// a window (swaps, leave cover). Escalation steps page or reassign to
// whoever is on call via the "Notify on-call" / "Reassign to on-call"
// actions.

const SHIFT_PRESETS = [
  { hours: 24, label: "Daily" },
  { hours: 168, label: "Weekly" },
  { hours: 336, label: "Every 2 weeks" },
];

// ISO → value for <input type="datetime-local"> in the viewer's zone.
function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(v) {
  return v ? new Date(v).toISOString() : null;
}

function fmtWhen(iso) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function fmtShift(hours) {
  const preset = SHIFT_PRESETS.find((p) => p.hours === hours);
  if (preset) return preset.label.toLowerCase();
  return hours % 24 === 0 ? `${hours / 24}-day` : `${hours}-hour`;
}

function nextHandoffDefault() {
  // Next Monday 09:00 local — the common weekly handoff.
  const d = new Date();
  d.setHours(9, 0, 0, 0);
  const add = (8 - d.getDay()) % 7 || 7;
  d.setDate(d.getDate() + add);
  return toLocalInput(d.toISOString());
}

function MembersEditor({ members, users, onChange }) {
  const [pick, setPick] = useState("");
  const nameOf = (id) => users.find((u) => u.id === id)?.display_name || `User #${id}`;
  function move(i, dir) {
    const next = [...members];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  }
  return (
    <div className="space-y-1">
      {members.length === 0 && <div className="text-xs text-fg-dim italic">No members yet.</div>}
      <ol className="space-y-1">
        {members.map((id, i) => (
          <li key={id} className="flex items-center gap-2 text-sm">
            <span className="text-xs text-fg-dim w-5 text-right">{i + 1}.</span>
            <span className="flex-1 min-w-0 truncate">{nameOf(id)}</span>
            <button type="button" onClick={() => move(i, -1)} disabled={i === 0}
              className="text-xs px-1 text-fg-muted hover:text-fg disabled:opacity-30" aria-label="Move up">↑</button>
            <button type="button" onClick={() => move(i, 1)} disabled={i === members.length - 1}
              className="text-xs px-1 text-fg-muted hover:text-fg disabled:opacity-30" aria-label="Move down">↓</button>
            <button type="button" onClick={() => onChange(members.filter((m) => m !== id))}
              className="text-xs px-1 text-red-600 hover:underline">Remove</button>
          </li>
        ))}
      </ol>
      <div className="flex items-center gap-2 pt-1">
        <select value={pick} onChange={(e) => setPick(e.target.value)}
          className="border border-border-strong rounded px-2 py-1 text-sm min-w-[12rem]">
          <option value="">— add member —</option>
          {users.filter((u) => !members.includes(u.id)).map((u) => (
            <option key={u.id} value={u.id}>{u.display_name} ({u.role})</option>
          ))}
        </select>
        <button type="button" disabled={!pick}
          onClick={() => { onChange([...members, Number(pick)]); setPick(""); }}
          className="text-xs px-2 py-1 border border-border rounded hover:bg-surface-2 disabled:opacity-50">
          Add
        </button>
      </div>
    </div>
  );
}

function RotationFields({ value, onChange, users, projects }) {
  const set = (patch) => onChange({ ...value, ...patch });
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="space-y-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-fg-muted">Name</span>
          <input value={value.name} onChange={(e) => set({ name: e.target.value })}
            placeholder="e.g. Infra primary" className="border border-border-strong rounded px-2 py-1 text-sm" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-fg-muted">Scope</span>
          <select value={value.project_id ?? ""}
            onChange={(e) => set({ project_id: e.target.value ? Number(e.target.value) : null })}
            className="border border-border-strong rounded px-2 py-1 text-sm">
            <option value="">Org-wide (any project without its own rotation)</option>
            {projects.filter((p) => p.status === "active").map((p) => (
              <option key={p.id} value={p.id}>{p.prefix} · {p.name}</option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-fg-muted">Shift length (hours)</span>
            <input type="number" min="1" max="8760" value={value.shift_hours}
              onChange={(e) => set({ shift_hours: Number(e.target.value) })}
              className="border border-border-strong rounded px-2 py-1 text-sm font-mono w-24" />
          </label>
          {SHIFT_PRESETS.map((p) => (
            <button key={p.hours} type="button" onClick={() => set({ shift_hours: p.hours })}
              className={`text-xs px-2 py-1 rounded border ${value.shift_hours === p.hours ? "bg-brand text-white border-brand" : "border-border hover:bg-surface-2"}`}>
              {p.label}
            </button>
          ))}
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-fg-muted">First handoff (member 1 starts here; your local time)</span>
          <input type="datetime-local" value={value.handoff_local}
            onChange={(e) => set({ handoff_local: e.target.value })}
            className="border border-border-strong rounded px-2 py-1 text-sm font-mono w-56" />
        </label>
      </div>
      <div>
        <div className="text-xs text-fg-muted mb-1">Members, in rotation order</div>
        <MembersEditor members={value.member_ids} users={users}
          onChange={(member_ids) => set({ member_ids })} />
      </div>
    </div>
  );
}

function OverridesEditor({ rotation, users, onChange }) {
  const [draft, setDraft] = useState({ user_id: "", starts: "", ends: "", note: "" });
  const nameOf = (id) => users.find((u) => u.id === id)?.display_name || `User #${id}`;

  async function add() {
    if (!draft.user_id || !draft.starts || !draft.ends) { toast.error("Pick a person, start and end"); return; }
    try {
      await api.post(`/api/oncall/${rotation.id}/overrides`, {
        user_id: Number(draft.user_id),
        starts_at: fromLocalInput(draft.starts),
        ends_at: fromLocalInput(draft.ends),
        note: draft.note || undefined,
      });
      setDraft({ user_id: "", starts: "", ends: "", note: "" });
      await onChange();
    } catch (err) {
      toast.error(err.message || "Failed");
    }
  }

  async function remove(id) {
    try {
      await api.delete(`/api/oncall/${rotation.id}/overrides/${id}`);
      await onChange();
    } catch (err) {
      toast.error(err.message || "Failed");
    }
  }

  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-fg">Overrides</div>
      {rotation.overrides.length === 0 ? (
        <div className="text-xs text-fg-dim italic">None scheduled.</div>
      ) : (
        <ul className="divide-y divide-border border border-border rounded">
          {rotation.overrides.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-2 px-2 py-1 text-sm">
              <span className="font-medium">{nameOf(o.user_id)}</span>
              <span className="text-xs text-fg-muted">{fmtWhen(o.starts_at)} → {fmtWhen(o.ends_at)}</span>
              {o.note && <span className="text-xs text-fg-dim truncate">· {o.note}</span>}
              <button onClick={() => remove(o.id)} className="ml-auto text-xs text-red-600 hover:underline">Remove</button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select value={draft.user_id} onChange={(e) => setDraft((d) => ({ ...d, user_id: e.target.value }))}
          className="border border-border-strong rounded px-2 py-1 text-sm">
          <option value="">— who covers —</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
        </select>
        <input type="datetime-local" value={draft.starts}
          onChange={(e) => setDraft((d) => ({ ...d, starts: e.target.value }))}
          className="border border-border-strong rounded px-2 py-1 text-sm font-mono" />
        <span className="text-fg-dim">→</span>
        <input type="datetime-local" value={draft.ends}
          onChange={(e) => setDraft((d) => ({ ...d, ends: e.target.value }))}
          className="border border-border-strong rounded px-2 py-1 text-sm font-mono" />
        <input value={draft.note} placeholder="Note (optional)"
          onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
          className="border border-border-strong rounded px-2 py-1 text-sm w-40" />
        <button onClick={add} className="text-xs px-2 py-1 bg-brand text-white rounded">Add override</button>
      </div>
    </div>
  );
}

function RotationCard({ rotation, users, projects, onChange }) {
  const [edit, setEdit] = useState(null);
  const nameOf = (id) => users.find((u) => u.id === id)?.display_name || `User #${id}`;
  const now = rotation.on_call_now;

  function startEdit() {
    setEdit({
      name: rotation.name,
      project_id: rotation.project_id,
      shift_hours: rotation.shift_hours,
      handoff_local: toLocalInput(rotation.handoff_at),
      member_ids: rotation.member_ids || [],
    });
  }

  async function save() {
    if (!edit.name.trim()) { toast.error("Name required"); return; }
    try {
      await api.patch(`/api/oncall/${rotation.id}`, {
        name: edit.name,
        project_id: edit.project_id,
        shift_hours: edit.shift_hours,
        handoff_at: fromLocalInput(edit.handoff_local),
        member_ids: edit.member_ids,
      });
      toast.success("Saved");
      setEdit(null);
      await onChange();
    } catch (err) {
      toast.error(err.message || "Failed");
    }
  }

  async function toggleEnabled() {
    try {
      await api.patch(`/api/oncall/${rotation.id}`, { enabled: !rotation.enabled });
      await onChange();
    } catch (err) {
      toast.error(err.message || "Failed");
    }
  }

  async function remove() {
    if (!confirm(`Delete rotation "${rotation.name}"? Escalation steps pinned to it stop finding anyone.`)) return;
    try {
      await api.delete(`/api/oncall/${rotation.id}`);
      await onChange();
    } catch (err) {
      toast.error(err.message || "Failed");
    }
  }

  return (
    <div className={`bg-surface border border-border rounded-lg p-4 space-y-3 ${rotation.enabled ? "" : "opacity-70"}`}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-fg">{rotation.name}</div>
          <div className="text-xs text-fg-muted">
            {rotation.project_id ? `${rotation.project_prefix} · ${rotation.project_name}` : "Org-wide"}
            {" · "}{fmtShift(rotation.shift_hours)} shifts · {(rotation.member_ids || []).length} members
            {!rotation.enabled && " · disabled"}
          </div>
        </div>
        <label className="flex items-center gap-1 text-xs text-fg-muted">
          <input type="checkbox" checked={rotation.enabled} onChange={toggleEnabled} />
          Enabled
        </label>
        {!edit && (
          <button onClick={startEdit} className="text-xs px-2 py-1 border border-border rounded hover:bg-surface-2">Edit</button>
        )}
        <button onClick={remove} className="text-xs px-2 py-1 text-red-600 hover:underline">Delete</button>
      </div>

      {edit ? (
        <div className="space-y-3 border border-border rounded p-3 bg-surface-2/40">
          <RotationFields value={edit} onChange={setEdit} users={users} projects={projects} />
          <div className="flex gap-2">
            <button onClick={save} className="text-sm px-3 py-1.5 bg-brand text-white rounded">Save</button>
            <button onClick={() => setEdit(null)} className="text-sm px-3 py-1.5 border border-border rounded">Cancel</button>
          </div>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <div className="text-xs text-fg-muted mb-1">On call now</div>
            {now ? (
              <div className="text-sm">
                <span className="font-semibold text-fg">{nameOf(now.user_id)}</span>
                {now.source === "override" && <span className="ml-1 text-xs text-amber-700 dark:text-amber-400">(override)</span>}
                <span className="text-xs text-fg-muted"> until {fmtWhen(now.until)}</span>
              </div>
            ) : (
              <div className="text-sm text-fg-dim italic">Nobody — add members.</div>
            )}
          </div>
          <div>
            <div className="text-xs text-fg-muted mb-1">Upcoming shifts</div>
            <ul className="text-sm space-y-0.5">
              {rotation.upcoming.map((sh) => (
                <li key={sh.starts_at} className="flex gap-2">
                  <span className="text-xs text-fg-muted w-40 shrink-0">{fmtWhen(sh.starts_at)}</span>
                  <span className="truncate">{nameOf(sh.user_id)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <OverridesEditor rotation={rotation} users={users} onChange={onChange} />
    </div>
  );
}

export default function AdminOnCall() {
  const [rotations, setRotations] = useState([]);
  const [users, setUsers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState(null);

  async function load() {
    try {
      const [rots, agents, pjs] = await Promise.all([
        api.get("/api/oncall"),
        api.get("/api/agents"),
        api.get("/api/projects"),
      ]);
      setRotations(rots);
      setUsers(agents);
      setProjects(pjs);
    } catch (err) {
      toast.error(err.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function create() {
    if (!draft.name.trim()) { toast.error("Name required"); return; }
    if (!draft.member_ids.length) { toast.error("Add at least one member"); return; }
    if (!draft.handoff_local) { toast.error("Set the first handoff"); return; }
    try {
      await api.post("/api/oncall", {
        name: draft.name,
        project_id: draft.project_id,
        shift_hours: draft.shift_hours,
        handoff_at: fromLocalInput(draft.handoff_local),
        member_ids: draft.member_ids,
      });
      toast.success("Rotation created");
      setDraft(null);
      await load();
    } catch (err) {
      toast.error(err.message || "Failed");
    }
  }

  if (loading) return <div className="text-fg-muted">Loading…</div>;

  return (
    <div className="space-y-5">
      <div className="bg-surface border border-border rounded-lg p-4">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-semibold text-fg">On-call rotations</h2>
          {!draft && (
            <button
              onClick={() => setDraft({ name: "", project_id: null, shift_hours: 168, handoff_local: nextHandoffDefault(), member_ids: [] })}
              className="text-xs px-2 py-1 border border-border rounded hover:bg-surface-2">
              + New rotation
            </button>
          )}
        </div>
        <p className="text-xs text-fg-muted">
          Members take turns, one shift each, starting at the first handoff.
          Overrides put someone else on call for a window. Escalation steps
          use <b>Notify on-call</b> / <b>Reassign to on-call</b>: a project's
          own rotations answer for its tickets, otherwise the org-wide ones
          do. With several rotations in a scope (primary and secondary),
          notify pages everyone on call and reassign picks the first. A step
          with nobody on call waits and retries until someone is.
        </p>
        {draft && (
          <div className="mt-3 space-y-3 border border-border rounded p-3 bg-surface-2/40">
            <RotationFields value={draft} onChange={setDraft} users={users} projects={projects} />
            <div className="flex gap-2">
              <button onClick={create} className="text-sm px-3 py-1.5 bg-brand text-white rounded">Create rotation</button>
              <button onClick={() => setDraft(null)} className="text-sm px-3 py-1.5 border border-border rounded">Cancel</button>
            </div>
          </div>
        )}
      </div>

      {rotations.length === 0 && !draft && (
        <div className="text-sm text-fg-muted">No rotations yet.</div>
      )}
      {rotations.map((r) => (
        <RotationCard key={r.id} rotation={r} users={users} projects={projects} onChange={load} />
      ))}
    </div>
  );
}

import React, { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import HybridTime from "../components/HybridTime";

const PRESET_KINDS = [
  { value: "daily",        label: "Daily" },
  { value: "weekly",       label: "Weekly (selected days)" },
  { value: "monthly_dom",  label: "Monthly on day-N" },
  { value: "monthly_nth",  label: "Monthly on the Nth weekday" },
  { value: "yearly",       label: "Yearly" },
];

const WEEKDAYS = [
  { v: 0, n: "Sun" }, { v: 1, n: "Mon" }, { v: 2, n: "Tue" },
  { v: 3, n: "Wed" }, { v: 4, n: "Thu" }, { v: 5, n: "Fri" }, { v: 6, n: "Sat" },
];

function defaultForm() {
  return {
    id: null,
    name: "",
    enabled: true,
    project_id: "",
    title: "",
    description: "",
    impact: 2,
    urgency: 2,
    assigned_to: "",
    requestor_user_id: "",
    contact_ids: [],
    follower_ids: [],
    runbook_article_id: "",
    recurrence_kind: "preset",
    preset_kind: "daily",
    preset_config: { hour: 9, minute: 0, weekdays: [1], day: 1, nth: 1, weekday: 1, month: 1 },
    cron_expr: "0 9 * * 1",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    end_kind: "never",
    end_count: 1,
    end_date: "",
  };
}

export default function AdminTicketSchedules() {
  const [list, setList] = useState([]);
  const [projects, setProjects] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [preview, setPreview] = useState(null);

  async function reload() {
    setLoading(true);
    try {
      setList(await api.get("/api/ticket-schedules"));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    api.get("/api/projects").then((all) => setProjects((all || []).filter((p) => p.status === "active")))
       .catch(() => {});
    api.get("/api/users").then(setUsers).catch(() => {});
  }, []);

  function startCreate() { setEditing(defaultForm()); setPreview(null); }
  function startEdit(row) {
    setEditing({
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      project_id: String(row.project_id),
      title: row.title || "",
      description: row.description || "",
      impact: row.impact,
      urgency: row.urgency,
      assigned_to: row.assigned_to ? String(row.assigned_to) : "",
      requestor_user_id: row.requestor_user_id ? String(row.requestor_user_id) : "",
      contact_ids: Array.isArray(row.contact_ids) ? row.contact_ids : [],
      follower_ids: Array.isArray(row.follower_ids) ? row.follower_ids : [],
      runbook_article_id: row.runbook_article_id ? String(row.runbook_article_id) : "",
      recurrence_kind: row.recurrence_kind,
      preset_kind: row.preset_kind || "daily",
      preset_config: row.preset_config || defaultForm().preset_config,
      cron_expr: row.cron_expr || "0 9 * * 1",
      timezone: row.timezone || "UTC",
      end_kind: row.end_kind || "never",
      end_count: row.end_count || 1,
      end_date: row.end_date ? row.end_date.slice(0, 16) : "",
    });
    setPreview(null);
  }

  async function runPreview() {
    if (!editing) return;
    try {
      const r = await api.post("/api/ticket-schedules/preview", buildPayload(editing));
      setPreview(r);
    } catch (e) {
      toast.error(e.message);
      setPreview(null);
    }
  }

  async function save() {
    if (!editing.name.trim()) { toast.error("Name required"); return; }
    if (!editing.project_id) { toast.error("Project required"); return; }
    try {
      const payload = buildPayload(editing);
      if (editing.id) {
        await api.patch(`/api/ticket-schedules/${editing.id}`, payload);
      } else {
        await api.post(`/api/ticket-schedules`, payload);
      }
      toast.success("Saved");
      setEditing(null);
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function destroy(id) {
    if (!confirm("Delete this schedule? Already-fired tickets stay.")) return;
    try {
      await api.delete(`/api/ticket-schedules/${id}`);
      reload();
    } catch (e) { toast.error(e.message); }
  }

  async function fireNow(id) {
    if (!confirm("Fire this schedule once now (does not advance the cron)?")) return;
    try {
      const r = await api.post(`/api/ticket-schedules/${id}/fire-now`, {});
      toast.success(`Created ticket #${r.ticket_id}`);
      reload();
    } catch (e) { toast.error(e.message); }
  }

  async function toggle(row) {
    try {
      await api.patch(`/api/ticket-schedules/${row.id}`, { enabled: !row.enabled });
      reload();
    } catch (e) { toast.error(e.message); }
  }

  if (loading && !list.length) return <div className="text-fg-dim py-12 text-center">Loading…</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-fg">Scheduled tickets</h1>
        <button onClick={startCreate} className="btn btn-primary btn-sm">New schedule</button>
      </div>

      <p className="text-sm text-fg-muted">
        Each schedule fires a templated ticket on its recurrence. Presets compile to cron;
        raw cron is also supported. Fired tickets are full first-class tickets — they go
        through the assignment, SLA, and notification pipelines exactly like a manually
        created one.
      </p>

      <div className="bg-surface border border-border rounded-lg overflow-hidden">
        <table className="min-w-full text-sm">
          <thead className="bg-surface-2 text-xs text-fg-muted uppercase tracking-wide">
            <tr>
              <th className="px-3 py-2 text-left">Name</th>
              <th className="px-3 py-2 text-left">Project</th>
              <th className="px-3 py-2 text-left">Recurrence</th>
              <th className="px-3 py-2 text-left">Next fire</th>
              <th className="px-3 py-2 text-left">Fired</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {list.map((r) => (
              <tr key={r.id} className={r.enabled ? "" : "opacity-60"}>
                <td className="px-3 py-2 font-medium text-fg">{r.name}</td>
                <td className="px-3 py-2 text-xs text-fg-muted">{r.project_prefix} · {r.project_name}</td>
                <td className="px-3 py-2 text-xs font-mono text-fg-muted">
                  {r.cron_expr}
                  <div className="text-[10px] text-fg-dim normal-case">
                    {r.recurrence_kind === "preset" ? `preset:${r.preset_kind}` : "cron"} · {r.timezone}
                  </div>
                </td>
                <td className="px-3 py-2 text-xs">
                  {r.next_fire_at ? <HybridTime value={r.next_fire_at} /> : <span className="text-fg-dim">—</span>}
                </td>
                <td className="px-3 py-2 text-xs">
                  {r.fires_count}{r.end_kind === "count" && r.end_count ? ` / ${r.end_count}` : ""}
                </td>
                <td className="px-3 py-2 text-xs">
                  <button onClick={() => toggle(r)} className={`px-2 py-0.5 rounded text-xs ${r.enabled ? "bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300" : "bg-surface-2 text-fg-muted"}`}>
                    {r.enabled ? "Enabled" : "Disabled"}
                  </button>
                </td>
                <td className="px-3 py-2 text-right text-xs space-x-2 whitespace-nowrap">
                  <button onClick={() => fireNow(r.id)} className="text-fg-muted hover:text-fg">Fire now</button>
                  <button onClick={() => startEdit(r)} className="text-brand hover:underline">Edit</button>
                  <button onClick={() => destroy(r.id)} className="text-red-600 dark:text-red-400 hover:underline">Delete</button>
                </td>
              </tr>
            ))}
            {!list.length && (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-fg-dim text-sm">No schedules yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <EditModal
          form={editing}
          setForm={setEditing}
          projects={projects}
          users={users}
          preview={preview}
          onPreview={runPreview}
          onSave={save}
          onCancel={() => { setEditing(null); setPreview(null); }}
        />
      )}
    </div>
  );
}

function buildPayload(f) {
  const payload = {
    name: f.name,
    enabled: f.enabled,
    project_id: Number(f.project_id),
    title: f.title,
    description: f.description,
    impact: Number(f.impact),
    urgency: Number(f.urgency),
    assigned_to: f.assigned_to ? Number(f.assigned_to) : null,
    requestor_user_id: f.requestor_user_id ? Number(f.requestor_user_id) : null,
    contact_ids: Array.isArray(f.contact_ids) ? f.contact_ids : [],
    follower_ids: Array.isArray(f.follower_ids) ? f.follower_ids : [],
    runbook_article_id: f.runbook_article_id ? Number(f.runbook_article_id) : null,
    recurrence_kind: f.recurrence_kind,
    timezone: f.timezone || "UTC",
    end_kind: f.end_kind,
    end_count: f.end_kind === "count" ? Number(f.end_count) || 1 : null,
    end_date: f.end_kind === "date" && f.end_date ? f.end_date : null,
  };
  if (f.recurrence_kind === "preset") {
    payload.preset_kind = f.preset_kind;
    payload.preset_config = f.preset_config;
  } else {
    payload.cron_expr = f.cron_expr;
  }
  return payload;
}

// Lazy-load project runbooks (kb_articles where kind='runbook' and
// project matches). Same cache shape as useProjectMembers.
function useProjectRunbooks(projectId) {
  const [byId, setById] = useState({});
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!projectId) return;
    if (byId[projectId]) return;
    setLoading(true);
    api.get(`/api/kb/projects/${projectId}/articles?kind=runbook`)
      .then((list) => {
        const rb = (Array.isArray(list) ? list : list?.articles || [])
          .map((a) => ({ id: a.id, title: a.title, slug: a.slug }));
        setById((prev) => ({ ...prev, [projectId]: rb }));
      })
      .catch(() => setById((prev) => ({ ...prev, [projectId]: [] })))
      .finally(() => setLoading(false));
  }, [projectId]);
  return { runbooks: byId[projectId] || [], loading };
}

// Lazy-load project members each time project_id changes. Cached per
// project so flipping back and forth doesn't re-fetch. Returns active
// members as { id, display_name, email, role }.
function useProjectMembers(projectId) {
  const [byId, setById] = useState({});
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!projectId) return;
    if (byId[projectId]) return;
    setLoading(true);
    api.get(`/api/projects/${projectId}`)
      .then((p) => {
        const members = (p?.members || [])
          .filter((m) => m.status === "active")
          .map((m) => ({ id: m.user_id, display_name: m.display_name, email: m.email, role: m.global_role }));
        setById((prev) => ({ ...prev, [projectId]: members }));
      })
      .catch(() => setById((prev) => ({ ...prev, [projectId]: [] })))
      .finally(() => setLoading(false));
  }, [projectId]);
  return { members: byId[projectId] || [], loading };
}

function EditModal({ form, setForm, projects, users, preview, onPreview, onSave, onCancel }) {
  const { members: projectMembers } = useProjectMembers(form.project_id);
  const { runbooks } = useProjectRunbooks(form.project_id);
  function set(k, v) { setForm((p) => ({ ...p, [k]: v })); }
  function setCfg(k, v) { setForm((p) => ({ ...p, preset_config: { ...p.preset_config, [k]: v } })); }
  function toggleFollower(id) {
    setForm((p) => {
      const list = Array.isArray(p.follower_ids) ? p.follower_ids : [];
      return { ...p, follower_ids: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] };
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <div className="bg-surface border border-border rounded-lg max-w-3xl w-full max-h-[90vh] overflow-y-auto p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-fg">{form.id ? "Edit schedule" : "New schedule"}</h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs text-fg-muted">
          <label className="flex flex-col gap-1 sm:col-span-2">Name *
            <input value={form.name} onChange={(e) => set("name", e.target.value)}
              className="bg-surface-2 border border-border rounded px-2 py-1 text-sm" />
          </label>
          <label className="flex flex-col gap-1">Project *
            <select value={form.project_id} onChange={(e) => set("project_id", e.target.value)}
              className="bg-surface-2 border border-border rounded px-2 py-1 text-sm">
              <option value="">— pick —</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.prefix} · {p.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">Assignee
            <select value={form.assigned_to} onChange={(e) => set("assigned_to", e.target.value)}
              className="bg-surface-2 border border-border rounded px-2 py-1 text-sm">
              <option value="">— none —</option>
              {users.filter((u) => u.status === "active").map((u) => (
                <option key={u.id} value={u.id}>{u.display_name || u.email}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 sm:col-span-2">Requestor (submitter on each fired ticket)
            <select value={form.requestor_user_id} onChange={(e) => set("requestor_user_id", e.target.value)}
              className="bg-surface-2 border border-border rounded px-2 py-1 text-sm">
              <option value="">— fall back to schedule creator —</option>
              {users.filter((u) => u.status === "active").map((u) => (
                <option key={u.id} value={u.id}>{u.display_name || u.email}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="text-xs text-fg-muted">
          <div className="mb-1">Followers (auto-added on every fire — optional)</div>
          <FollowerComposer
            disabled={!form.project_id}
            members={projectMembers}
            selectedIds={Array.isArray(form.follower_ids) ? form.follower_ids : []}
            onAdd={(id) => toggleFollower(id)}
            onRemove={(id) => toggleFollower(id)}
          />
          <div className="text-[10px] text-fg-dim mt-1">
            Description <code className="font-mono">@mentions</code> are <b>not</b> dispatched on
            create — keeps repeated fires from spamming. Mentions inside a comment posted on the
            fired ticket (e.g. a canned close response) still page normally.
          </div>
        </div>

        <div className="text-xs text-fg-muted">
          <div className="mb-1">Attach runbook (optional)</div>
          {!form.project_id ? (
            <span className="text-fg-dim italic text-[11px]">pick a project first</span>
          ) : (
            <select value={form.runbook_article_id} onChange={(e) => set("runbook_article_id", e.target.value)}
              className="bg-surface-2 border border-border rounded px-2 py-1 text-sm w-full">
              <option value="">— none —</option>
              {runbooks.length === 0
                ? <option value="" disabled>no runbooks in this project</option>
                : runbooks.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
            </select>
          )}
          <div className="text-[10px] text-fg-dim mt-1">
            Auto-attaches a <code className="font-mono">ticket_runbook_runs</code> row on every fire.
            Audit trail: the started_at + started_by stamp proves the runbook landed on the ticket
            even when no one ticks a step.
          </div>
        </div>

        <label className="text-xs text-fg-muted flex flex-col gap-1">Ticket title (template)
          <input value={form.title} onChange={(e) => set("title", e.target.value)}
            className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
            placeholder="e.g. Weekly server patch review" />
        </label>
        <label className="text-xs text-fg-muted flex flex-col gap-1">Description (markdown)
          <textarea value={form.description} onChange={(e) => set("description", e.target.value)}
            rows={4} className="bg-surface-2 border border-border rounded px-2 py-1 text-sm font-mono" />
        </label>

        <div className="grid grid-cols-2 gap-3 text-xs text-fg-muted">
          <label className="flex flex-col gap-1">Impact
            <select value={form.impact} onChange={(e) => set("impact", e.target.value)}
              className="bg-surface-2 border border-border rounded px-2 py-1 text-sm">
              <option value="1">1 (High)</option><option value="2">2 (Med)</option><option value="3">3 (Low)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">Urgency
            <select value={form.urgency} onChange={(e) => set("urgency", e.target.value)}
              className="bg-surface-2 border border-border rounded px-2 py-1 text-sm">
              <option value="1">1 (High)</option><option value="2">2 (Med)</option><option value="3">3 (Low)</option>
            </select>
          </label>
        </div>

        <div className="border-t border-border pt-3 space-y-3">
          <div className="text-sm font-medium text-fg">Recurrence</div>
          <div className="flex gap-3 text-xs text-fg-muted">
            <label className="flex items-center gap-1">
              <input type="radio" name="rk" checked={form.recurrence_kind === "preset"}
                onChange={() => set("recurrence_kind", "preset")} /> Preset
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" name="rk" checked={form.recurrence_kind === "cron"}
                onChange={() => set("recurrence_kind", "cron")} /> Cron expression
            </label>
          </div>

          {form.recurrence_kind === "preset" ? (
            <PresetEditor kind={form.preset_kind} cfg={form.preset_config}
              onKind={(k) => set("preset_kind", k)} onCfg={setCfg} />
          ) : (
            <div className="space-y-1 text-xs text-fg-muted">
              <label className="flex flex-col gap-1">Cron expression (5 fields: minute hour DOM month DOW)
                <input value={form.cron_expr} onChange={(e) => set("cron_expr", e.target.value)}
                  className="bg-surface-2 border border-border rounded px-2 py-1 text-sm font-mono" />
              </label>
              <div className="text-[11px] text-fg-dim">
                Quick refs: <code className="font-mono">0 9 * * 1</code> = 9:00 every Mon ·
                <code className="font-mono"> */15 * * * *</code> = every 15 min ·
                <code className="font-mono"> 0 0 1 * *</code> = midnight on the 1st.
              </div>
            </div>
          )}

          <label className="flex flex-col gap-1 text-xs text-fg-muted">Timezone (IANA)
            <input value={form.timezone} onChange={(e) => set("timezone", e.target.value)}
              className="bg-surface-2 border border-border rounded px-2 py-1 text-sm font-mono w-64"
              placeholder="America/Chicago" />
          </label>
        </div>

        <div className="border-t border-border pt-3 space-y-2">
          <div className="text-sm font-medium text-fg">End condition</div>
          <div className="flex gap-3 text-xs text-fg-muted">
            {["never", "count", "date"].map((k) => (
              <label key={k} className="flex items-center gap-1">
                <input type="radio" name="ek" checked={form.end_kind === k}
                  onChange={() => set("end_kind", k)} /> {k === "never" ? "Indefinite" : k === "count" ? "After N fires" : "Until date"}
              </label>
            ))}
          </div>
          {form.end_kind === "count" && (
            <label className="flex flex-col gap-1 text-xs text-fg-muted w-32">N
              <input type="number" min="1" value={form.end_count} onChange={(e) => set("end_count", e.target.value)}
                className="bg-surface-2 border border-border rounded px-2 py-1 text-sm font-mono" />
            </label>
          )}
          {form.end_kind === "date" && (
            <label className="flex flex-col gap-1 text-xs text-fg-muted w-64">End date / time
              <input type="datetime-local" value={form.end_date} onChange={(e) => set("end_date", e.target.value)}
                className="bg-surface-2 border border-border rounded px-2 py-1 text-sm" />
            </label>
          )}
        </div>

        <div className="border-t border-border pt-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-fg">Preview (next 5 fires)</div>
            <button type="button" onClick={onPreview} className="btn btn-secondary btn-sm">Preview</button>
          </div>
          {preview ? (
            <div className="text-xs space-y-1">
              <div className="text-fg-muted"><span className="font-medium text-fg">{preview.description}</span> ({preview.timezone})</div>
              <ul className="font-mono text-fg-muted space-y-0.5">
                {preview.next_fires.map((t, i) => (
                  <li key={i}>{new Date(t).toLocaleString(undefined, { timeZone: preview.timezone })}</li>
                ))}
                {!preview.next_fires.length && <li className="text-fg-dim italic">no fires (end condition hit)</li>}
              </ul>
            </div>
          ) : (
            <div className="text-xs text-fg-dim">Click Preview to render the next 5 fire times.</div>
          )}
        </div>

        <div className="flex justify-between items-center pt-2 border-t border-border">
          <label className="flex items-center gap-2 text-xs text-fg-muted">
            <input type="checkbox" checked={!!form.enabled} onChange={(e) => set("enabled", e.target.checked)} />
            Enabled
          </label>
          <div className="flex gap-2">
            <button type="button" onClick={onCancel} className="btn btn-secondary btn-sm">Cancel</button>
            <button type="button" onClick={onSave} className="btn btn-primary btn-sm">{form.id ? "Save" : "Create"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Email "To:"/"CC:" style chip composer. Dropdown lists project
// members not yet picked; selecting one appends a chip + clears the
// dropdown. Chips have an × to remove. Disabled state covers the
// "no project picked yet" case so the field renders without an
// empty + meaningless dropdown.
function FollowerComposer({ disabled, members, selectedIds, onAdd, onRemove }) {
  const [draft, setDraft] = React.useState("");

  const byId = React.useMemo(() => {
    const m = new Map();
    for (const u of members) m.set(u.id, u);
    return m;
  }, [members]);

  const available = members.filter((m) => !selectedIds.includes(m.id));

  function pick(e) {
    const v = e.target.value;
    if (!v) return;
    const id = Number(v);
    if (Number.isInteger(id) && id > 0) onAdd(id);
    setDraft(""); // reset so the same id can be re-added after removal
  }

  return (
    <div className={`border border-border rounded bg-surface-2 p-1.5 flex flex-wrap items-center gap-1 ${disabled ? "opacity-60" : ""}`}>
      {selectedIds.map((id) => {
        const u = byId.get(id);
        const label = u ? (u.display_name || u.email) : `user #${id}`;
        return (
          <span key={id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-brand text-brand-fg text-[11px]">
            {label}
            <button type="button" aria-label={`Remove ${label}`} className="hover:opacity-80"
              onClick={() => onRemove(id)}>
              ×
            </button>
          </span>
        );
      })}
      {disabled ? (
        <span className="text-[11px] text-fg-dim italic px-1">pick a project first</span>
      ) : (
        <select
          value={draft}
          onChange={pick}
          className="bg-transparent border-0 outline-none text-xs min-w-[10rem] flex-1 text-fg"
          disabled={available.length === 0}
        >
          <option value="">
            {available.length === 0
              ? (members.length === 0 ? "no active project members" : "all members already added")
              : "Add follower…"}
          </option>
          {available.map((m) => (
            <option key={m.id} value={m.id}>
              {m.display_name || m.email}{m.email && m.display_name ? ` <${m.email}>` : ""}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function PresetEditor({ kind, cfg, onKind, onCfg }) {
  return (
    <div className="space-y-2 text-xs text-fg-muted">
      <label className="flex flex-col gap-1">Preset
        <select value={kind} onChange={(e) => onKind(e.target.value)}
          className="bg-surface-2 border border-border rounded px-2 py-1 text-sm w-64">
          {PRESET_KINDS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
      </label>
      <div className="flex gap-2">
        <label className="flex flex-col gap-1 w-24">Hour
          <input type="number" min="0" max="23" value={cfg.hour} onChange={(e) => onCfg("hour", parseInt(e.target.value, 10) || 0)}
            className="bg-surface-2 border border-border rounded px-2 py-1 text-sm font-mono" />
        </label>
        <label className="flex flex-col gap-1 w-24">Minute
          <input type="number" min="0" max="59" value={cfg.minute} onChange={(e) => onCfg("minute", parseInt(e.target.value, 10) || 0)}
            className="bg-surface-2 border border-border rounded px-2 py-1 text-sm font-mono" />
        </label>
      </div>
      {kind === "weekly" && (
        <div>
          <div className="mb-1">Weekdays</div>
          <div className="flex gap-1 flex-wrap">
            {WEEKDAYS.map((d) => {
              const active = Array.isArray(cfg.weekdays) && cfg.weekdays.includes(d.v);
              return (
                <button key={d.v} type="button"
                  onClick={() => {
                    const list = Array.isArray(cfg.weekdays) ? cfg.weekdays : [];
                    onCfg("weekdays", active ? list.filter((x) => x !== d.v) : [...list, d.v]);
                  }}
                  className={`px-2 py-1 rounded border text-xs ${active ? "bg-brand text-brand-fg border-brand" : "border-border bg-surface-2"}`}>
                  {d.n}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {kind === "monthly_dom" && (
        <label className="flex flex-col gap-1 w-24">Day (1–28)
          <input type="number" min="1" max="28" value={cfg.day} onChange={(e) => onCfg("day", parseInt(e.target.value, 10) || 1)}
            className="bg-surface-2 border border-border rounded px-2 py-1 text-sm font-mono" />
        </label>
      )}
      {kind === "monthly_nth" && (
        <div className="flex gap-2">
          <label className="flex flex-col gap-1 w-32">Nth
            <select value={cfg.nth} onChange={(e) => onCfg("nth", parseInt(e.target.value, 10))}
              className="bg-surface-2 border border-border rounded px-2 py-1 text-sm">
              <option value={1}>1st</option><option value={2}>2nd</option>
              <option value={3}>3rd</option><option value={4}>4th</option>
              <option value={5}>Last</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 w-32">Weekday
            <select value={cfg.weekday} onChange={(e) => onCfg("weekday", parseInt(e.target.value, 10))}
              className="bg-surface-2 border border-border rounded px-2 py-1 text-sm">
              {WEEKDAYS.map((d) => <option key={d.v} value={d.v}>{d.n}</option>)}
            </select>
          </label>
        </div>
      )}
      {kind === "yearly" && (
        <div className="flex gap-2">
          <label className="flex flex-col gap-1 w-24">Month
            <input type="number" min="1" max="12" value={cfg.month} onChange={(e) => onCfg("month", parseInt(e.target.value, 10) || 1)}
              className="bg-surface-2 border border-border rounded px-2 py-1 text-sm font-mono" />
          </label>
          <label className="flex flex-col gap-1 w-24">Day (1–28)
            <input type="number" min="1" max="28" value={cfg.day} onChange={(e) => onCfg("day", parseInt(e.target.value, 10) || 1)}
              className="bg-surface-2 border border-border rounded px-2 py-1 text-sm font-mono" />
          </label>
        </div>
      )}
    </div>
  );
}

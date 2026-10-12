import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import { useAuth } from "../context/AuthContext";
import MarkdownContent from "../components/MarkdownContent";
import MonitoredItemPicker from "../components/MonitoredItemPicker";
import { StateDot, fmtDateTime, fmtDuration } from "../utils/itemState";

// Maintenance log. Techs and up schedule windows over monitored items
// and record what was done; while a window is active, alerts for its
// items are recorded but don't open tickets. Windows show on every
// status page that carries one of their items.

const SCOPES = [
  { key: "active", label: "In progress" },
  { key: "upcoming", label: "Scheduled" },
  { key: "past", label: "Completed" },
];

// <input type="datetime-local"> works in local wall time without a zone.
function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function fromLocalInput(v) {
  return v ? new Date(v).toISOString() : null;
}

export default function Maintenance() {
  const { user } = useAuth();
  const canEdit = ["Admin", "Manager", "Tech"].includes(user?.role);
  const canDelete = ["Admin", "Manager"].includes(user?.role);
  const [scope, setScope] = useState("active");
  const [rows, setRows] = useState(null);
  const [counts, setCounts] = useState({});
  const [editing, setEditing] = useState(null); // null | {} (new) | window row

  const load = useCallback(async () => {
    try {
      const all = await api.get("/api/maintenance?scope=all");
      const now = Date.now();
      const bucket = (w) => (new Date(w.starts_at) > now ? "upcoming" : new Date(w.ends_at) <= now ? "past" : "active");
      const c = { active: 0, upcoming: 0, past: 0 };
      for (const w of all) c[bucket(w)] += 1;
      setCounts(c);
      const filtered = all.filter((w) => bucket(w) === scope);
      if (scope === "upcoming") filtered.sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
      setRows(filtered);
    } catch (e) {
      toast.error(e.message);
      setRows([]);
    }
  }, [scope]);

  useEffect(() => { load(); }, [load]);

  async function remove(w) {
    if (!window.confirm(`Delete maintenance "${w.title}"? Alerts it held back get re-checked now.`)) return;
    try {
      await api.delete(`/api/maintenance/${w.id}`);
      toast.success("Maintenance deleted");
      load();
    } catch (e) { toast.error(e.message); }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="sticky top-0 z-10 bg-bg border-b border-border px-4 md:px-6 pt-4 md:pt-6 pb-3 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold text-fg">Maintenance</h1>
            <p className="text-xs text-fg-muted mt-0.5">
              Alerts for items under an active window are recorded but don’t open tickets.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/account/settings/calendar" className="btn btn-ghost btn-sm">Subscribe</Link>
            {canEdit && !editing && (
              <button onClick={() => setEditing({})} className="btn btn-primary btn-sm">+ Log maintenance</button>
            )}
          </div>
        </div>
        {!editing && (
          <div className="flex gap-1 overflow-x-auto">
            {SCOPES.map((s) => (
              <button key={s.key} onClick={() => setScope(s.key)}
                className={`text-sm px-3 py-1.5 rounded-lg border whitespace-nowrap ${scope === s.key
                  ? "bg-brand/10 border-brand text-fg font-medium"
                  : "bg-surface border-border text-fg-muted hover:text-fg hover:bg-surface-2"}`}>
                {s.label}{counts[s.key] ? ` (${counts[s.key]})` : ""}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-4">
        <div className="max-w-4xl mx-auto space-y-3">
          {editing ? (
            <WindowForm
              initial={editing}
              onCancel={() => setEditing(null)}
              onSaved={() => { setEditing(null); load(); }}
            />
          ) : rows === null ? (
            <div className="text-sm text-fg-dim italic">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="card p-6 text-sm text-fg-muted">
              Nothing {SCOPES.find((s) => s.key === scope).label.toLowerCase()}.
            </div>
          ) : rows.map((w) => (
            <WindowCard key={w.id} w={w}
              onEdit={canEdit ? () => setEditing(w) : null}
              onDelete={canDelete ? () => remove(w) : null} />
          ))}
        </div>
      </div>
    </div>
  );
}

function WindowCard({ w, onEdit, onDelete }) {
  const now = Date.now();
  const active = new Date(w.starts_at) <= now && new Date(w.ends_at) > now;
  const past = new Date(w.ends_at) <= now;
  return (
    <div className={`card p-4 space-y-2 ${active ? "border-sky-400 dark:border-sky-800" : ""}`}>
      <div className="flex items-start gap-3">
        <StateDot state="maintenance" className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-fg">{w.title}</div>
          <div className="text-xs text-fg-muted mt-0.5">
            {fmtDateTime(w.starts_at)} → {fmtDateTime(w.ends_at)} · {fmtDuration(w.starts_at, w.ends_at)}
            {w.project_prefix && <> · <span className="font-medium">{w.project_prefix}</span></>}
            {w.ticket_ref && <> · <Link to={`/tickets/${w.ticket_id}`} className="text-brand hover:underline">{w.ticket_ref}</Link></>}
          </div>
          {w.items.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {w.items.map((i) => (
                <span key={i.id} className="text-[11px] bg-surface-2 border border-border rounded px-1.5 py-0.5 text-fg-muted">
                  {i.label}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex gap-2 shrink-0">
          {onEdit && <button onClick={onEdit} className="text-xs text-brand hover:underline">Edit</button>}
          {onDelete && <button onClick={onDelete} className="text-xs text-red-500 hover:underline">Delete</button>}
        </div>
      </div>
      {w.description && <div className="pl-5 text-sm"><MarkdownContent>{w.description}</MarkdownContent></div>}
      {w.work_notes ? (
        <div className="pl-5 text-sm">
          <div className="text-xs font-semibold text-fg-muted uppercase tracking-wide mb-1">What was done</div>
          <MarkdownContent>{w.work_notes}</MarkdownContent>
        </div>
      ) : past ? (
        <div className="pl-5 text-xs text-amber-700 dark:text-amber-300">No notes on what was done yet.</div>
      ) : null}
      {w.assignees?.length > 0 && (
        <div className="pl-5 text-xs text-fg-muted">
          Scheduled: {w.assignees.map((a) => a.display_name).join(", ")}
        </div>
      )}
      <div className="pl-5 text-xs text-fg-dim">
        Logged by {w.created_by_name || "unknown"}
        {w.updated_by_name && w.updated_by_name !== w.created_by_name && <> · last edited by {w.updated_by_name}</>}
      </div>
    </div>
  );
}

function WindowForm({ initial, onCancel, onSaved }) {
  const { user } = useAuth();
  const isNew = !initial.id;
  const [title, setTitle] = useState(initial.title || "");
  const [startsAt, setStartsAt] = useState(toLocalInput(initial.starts_at || new Date().toISOString()));
  const [endsAt, setEndsAt] = useState(toLocalInput(initial.ends_at || new Date(Date.now() + 3600000).toISOString()));
  const [ticketRef, setTicketRef] = useState(initial.ticket_ref || "");
  const [description, setDescription] = useState(initial.description || "");
  const [workNotes, setWorkNotes] = useState(initial.work_notes || "");
  const [selected, setSelected] = useState(() => new Set((initial.items || []).map((i) => i.id)));
  const [all, setAll] = useState([]);
  // "auto" (new windows only): the server takes the project from the
  // items (item pin, service pin, integration default).
  const [projectId, setProjectId] = useState(isNew ? "auto" : String(initial.project_id ?? ""));
  const [assignees, setAssignees] = useState(() => new Set(
    isNew ? [user?.id].filter(Boolean) : (initial.assignees || []).map((a) => a.id)
  ));
  const [projects, setProjects] = useState([]);
  const [staff, setStaff] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get("/api/status-pages/_meta/items").then(setAll).catch((e) => toast.error(e.message));
    api.get("/api/projects")
      .then((r) => setProjects((Array.isArray(r) ? r : []).filter((p) => p.status === "active")))
      .catch(() => {});
    api.get("/api/users")
      .then((r) => setStaff((Array.isArray(r) ? r : [])
        .filter((u) => ["Admin", "Manager", "Tech"].includes(u.role) && u.status === "active")))
      .catch(() => {});
  }, []);

  function toggleAssignee(id) {
    setAssignees((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const invalidRange = useMemo(
    () => startsAt && endsAt && new Date(endsAt) <= new Date(startsAt),
    [startsAt, endsAt]
  );

  function toggle(id, checked) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  }

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    const body = {
      title,
      starts_at: fromLocalInput(startsAt),
      ends_at: fromLocalInput(endsAt),
      ticket_ref: ticketRef.trim(),
      description,
      work_notes: workNotes,
      item_ids: [...selected],
      assignee_ids: [...assignees],
      ...(projectId === "auto" ? {} : { project_id: projectId ? Number(projectId) : null }),
    };
    try {
      if (isNew) await api.post("/api/maintenance", body);
      else await api.patch(`/api/maintenance/${initial.id}`, body);
      toast.success(isNew ? "Maintenance logged" : "Maintenance updated");
      onSaved();
    } catch (err) { toast.error(err.message); }
    finally { setSaving(false); }
  }

  function endNow() {
    setEndsAt(toLocalInput(new Date().toISOString()));
  }

  return (
    <form onSubmit={save} className="card p-4 space-y-4">
      <div className="text-sm font-semibold text-fg">{isNew ? "Log maintenance" : "Edit maintenance"}</div>
      <label className="text-xs text-fg-muted flex flex-col gap-1">
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200}
          placeholder="e.g. NetBox 4.x upgrade"
          className="bg-surface-2 border border-border rounded px-2 py-1.5 text-sm" />
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="text-xs text-fg-muted flex flex-col gap-1">
          Starts
          <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required
            className="bg-surface-2 border border-border rounded px-2 py-1.5 text-sm" />
        </label>
        <label className="text-xs text-fg-muted flex flex-col gap-1">
          <span className="flex items-center justify-between">
            Ends
            {!isNew && <button type="button" onClick={endNow} className="text-brand hover:underline">End now</button>}
          </span>
          <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} required
            className={`bg-surface-2 border rounded px-2 py-1.5 text-sm ${invalidRange ? "border-red-500" : "border-border"}`} />
          {invalidRange && <span className="text-red-600">Must be after the start.</span>}
        </label>
        <label className="text-xs text-fg-muted flex flex-col gap-1">
          Related ticket (optional)
          <input value={ticketRef} onChange={(e) => setTicketRef(e.target.value)} placeholder="DEV-0010"
            className="bg-surface-2 border border-border rounded px-2 py-1.5 text-sm font-mono" />
        </label>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="text-xs text-fg-muted flex flex-col gap-1">
          Project calendar
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}
            className="bg-surface-2 border border-border rounded px-2 py-1.5 text-sm">
            {isNew && <option value="auto">From the affected items</option>}
            <option value="">None</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.prefix} · {p.name}</option>)}
          </select>
        </label>
        <div className="sm:col-span-2 text-xs text-fg-muted flex flex-col gap-1">
          Scheduled techs (on their calendar feeds)
          <div className="flex flex-wrap gap-1.5">
            {staff.length === 0 && <span className="text-fg-dim italic">Loading…</span>}
            {staff.map((u) => {
              const on = assignees.has(u.id);
              return (
                <button key={u.id} type="button" onClick={() => toggleAssignee(u.id)} aria-pressed={on}
                  className={`px-2 py-1 rounded-full border text-xs ${on
                    ? "bg-brand/10 border-brand text-brand font-medium"
                    : "border-border text-fg-muted hover:text-fg hover:bg-surface-2"}`}>
                  {u.display_name}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <div className="space-y-1">
        <div className="text-xs text-fg-muted">Affected items (their alerts won’t open tickets during the window)</div>
        <MonitoredItemPicker items={all} selected={selected} onToggle={toggle} />
      </div>
      <label className="text-xs text-fg-muted flex flex-col gap-1">
        Plan / reason (Markdown, optional)
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
          className="bg-surface-2 border border-border rounded px-2 py-1.5 text-sm font-mono" />
      </label>
      <label className="text-xs text-fg-muted flex flex-col gap-1">
        What was done (Markdown, fill in as you go or afterwards)
        <textarea value={workNotes} onChange={(e) => setWorkNotes(e.target.value)} rows={6}
          placeholder={"- Pulled netbox 4.2 image\n- Ran migrations\n- Verified API + UI"}
          className="bg-surface-2 border border-border rounded px-2 py-1.5 text-sm font-mono" />
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn btn-ghost btn-sm">Cancel</button>
        <button type="submit" disabled={saving || invalidRange || !title.trim()} className="btn btn-primary btn-sm">
          {saving ? "Saving…" : isNew ? "Log maintenance" : "Save changes"}
        </button>
      </div>
    </form>
  );
}

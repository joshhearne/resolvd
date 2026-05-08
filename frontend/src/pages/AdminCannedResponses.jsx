import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import { useAuth } from "../context/AuthContext";

const TAG_HINTS = [
  "{ticket.ref}",
  "{ticket.title}",
  "{ticket.priority}",
  "{ticket.url}",
  "{ticket.vendor_ref}",
  "{submitter.firstName}",
  "{submitter.name}",
  "{submitter.email}",
  "{assignee.firstName}",
  "{assignee.name}",
  "{actor.firstName}",
  "{actor.name}",
  "{site.name}",
];

function emptyForm() {
  return { id: null, scope: "global", title: "", body: "", category: "", project_ids: [] };
}

export default function AdminCannedResponses() {
  const { user } = useAuth();
  const isPriv = ["Admin", "Manager"].includes(user?.role);
  const [items, setItems] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);

  async function reload() {
    setLoading(true);
    try {
      setItems(await api.get("/api/canned-responses"));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    api.get("/api/projects")
      .then((all) => setProjects((all || []).filter((p) => p.status === "active")))
      .catch(() => setProjects([]));
  }, []);

  async function save(form) {
    try {
      if (form.id) {
        await api.patch(`/api/canned-responses/${form.id}`, {
          title: form.title,
          body: form.body,
          category: form.category,
        });
        toast.success("Updated");
      } else {
        await api.post("/api/canned-responses", form);
        toast.success("Created");
      }
      setEditing(null);
      await reload();
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function remove(id) {
    if (!window.confirm("Delete this canned response?")) return;
    try {
      await api.delete(`/api/canned-responses/${id}`);
      await reload();
    } catch (e) {
      toast.error(e.message);
    }
  }

  function canEdit(row) {
    if (row.scope === "global") return isPriv;
    return row.user_id === user?.id;
  }

  const grouped = items.reduce((acc, r) => {
    const key = r.category || "Uncategorized";
    (acc[key] = acc[key] || []).push(r);
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-fg mb-1">Canned responses</h1>
          <p className="text-sm text-fg-muted">
            Saved comment templates. Globals appear for everyone (Admin/Manager
            only). Personal templates appear only for you.
          </p>
        </div>
        <button onClick={() => setEditing(emptyForm())} className="btn btn-primary btn-sm">
          + New response
        </button>
      </div>

      {editing && (
        <Editor
          form={editing}
          isPriv={isPriv}
          projects={projects}
          onCancel={() => setEditing(null)}
          onSubmit={save}
        />
      )}

      {loading ? (
        <div className="text-sm text-fg-dim">Loading…</div>
      ) : items.length === 0 ? (
        <div className="text-sm text-fg-dim italic">
          No canned responses yet. Create one above.
        </div>
      ) : (
        <div className="space-y-4">
          {Object.entries(grouped).map(([cat, rows]) => (
            <div key={cat}>
              <div className="text-[11px] uppercase tracking-wider font-semibold text-fg-dim mb-1.5">
                {cat}
              </div>
              <div className="bg-surface border border-border rounded-lg divide-y divide-border">
                {rows.map((r) => (
                  <div key={r.id} className="px-3 py-2.5 flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-fg">{r.title}</span>
                        <span
                          className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
                            r.scope === "global"
                              ? "bg-brand/15 text-brand"
                              : "bg-surface-2 text-fg-muted"
                          }`}
                        >
                          {r.scope}
                        </span>
                        <ProjectScopePill projectIds={r.project_ids} projects={projects} />
                        {r.use_count > 0 && (
                          <span className="text-[10px] text-fg-dim">used {r.use_count}×</span>
                        )}
                      </div>
                      <pre className="text-xs text-fg-muted mt-1 whitespace-pre-wrap font-sans line-clamp-3">
                        {r.body}
                      </pre>
                    </div>
                    {canEdit(r) && (
                      <div className="flex flex-col gap-1 items-end">
                        <button
                          onClick={() => setEditing({ ...r, category: r.category || "" })}
                          className="text-xs text-brand hover:underline"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => remove(r.id)}
                          className="text-xs text-red-600 hover:underline"
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectScopePill({ projectIds, projects }) {
  if (!projectIds || projectIds.length === 0) {
    return (
      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-surface-2 text-fg-dim">
        all projects
      </span>
    );
  }
  const names = projectIds
    .map((id) => projects.find((p) => p.id === id)?.prefix || `#${id}`)
    .join(", ");
  return (
    <span
      className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300"
      title={names}
    >
      {projectIds.length === 1 ? names : `${projectIds.length} projects`}
    </span>
  );
}

function Editor({ form, isPriv, projects, onCancel, onSubmit }) {
  const [local, setLocal] = useState({
    ...form,
    project_ids: Array.isArray(form.project_ids) ? form.project_ids : [],
  });
  const isEdit = !!form.id;

  function submit(e) {
    e.preventDefault();
    if (!local.title.trim()) return toast.error("Title required");
    if (!local.body.trim()) return toast.error("Body required");
    onSubmit({
      ...local,
      title: local.title.trim(),
      category: local.category.trim() || null,
      project_ids: local.project_ids,
    });
  }

  function insertTag(tag) {
    setLocal((l) => ({ ...l, body: l.body + tag }));
  }

  function toggleProject(id) {
    setLocal((l) => {
      const has = l.project_ids.includes(id);
      return {
        ...l,
        project_ids: has ? l.project_ids.filter((x) => x !== id) : [...l.project_ids, id],
      };
    });
  }

  return (
    <form onSubmit={submit} className="bg-surface border border-border rounded-lg p-4 space-y-3">
      <div className="text-sm font-semibold text-fg">
        {isEdit ? "Edit canned response" : "New canned response"}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="text-xs text-fg-muted flex flex-col gap-1">
          Title
          <input
            value={local.title}
            onChange={(e) => setLocal((l) => ({ ...l, title: e.target.value }))}
            className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
            placeholder="Toner replacement scheduled"
            required
          />
        </label>
        <label className="text-xs text-fg-muted flex flex-col gap-1">
          Category
          <input
            value={local.category}
            onChange={(e) => setLocal((l) => ({ ...l, category: e.target.value }))}
            className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
            placeholder="Printer"
          />
        </label>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="text-xs text-fg-muted flex flex-col gap-1">
          <span>Projects ({local.project_ids.length === 0 ? "All" : `${local.project_ids.length} selected`})</span>
          <div className="bg-surface-2 border border-border rounded px-2 py-1.5 max-h-40 overflow-y-auto space-y-1">
            <label className="flex items-center gap-2 text-fg cursor-pointer">
              <input
                type="checkbox"
                checked={local.project_ids.length === 0}
                onChange={() => setLocal((l) => ({ ...l, project_ids: [] }))}
              />
              <span className="text-sm font-medium">All projects (default)</span>
            </label>
            <div className="border-t border-border my-1" />
            {projects.length === 0 && (
              <div className="text-xs text-fg-dim italic">No active projects.</div>
            )}
            {projects.map((p) => (
              <label key={p.id} className="flex items-center gap-2 text-fg cursor-pointer">
                <input
                  type="checkbox"
                  checked={local.project_ids.includes(p.id)}
                  onChange={() => toggleProject(p.id)}
                />
                <span className="text-sm">
                  {p.name} <span className="text-fg-dim">({p.prefix})</span>
                </span>
              </label>
            ))}
          </div>
        </div>
        <label className="text-xs text-fg-muted flex flex-col gap-1">
          Scope
          <select
            value={local.scope}
            onChange={(e) => setLocal((l) => ({ ...l, scope: e.target.value }))}
            disabled={isEdit}
            className="bg-surface-2 border border-border rounded px-2 py-1 text-sm disabled:opacity-50"
          >
            <option value="user">Personal (only me)</option>
            {(isPriv || local.scope === "global") && <option value="global">Global (everyone)</option>}
          </select>
        </label>
      </div>
      <label className="text-xs text-fg-muted flex flex-col gap-1">
        Body
        <textarea
          value={local.body}
          onChange={(e) => setLocal((l) => ({ ...l, body: e.target.value }))}
          rows={8}
          className="bg-surface-2 border border-border rounded px-2 py-1.5 text-sm font-mono"
          placeholder={"Hi,\n\nWe scheduled a toner replacement for {ticket.ref}.\n\n— {actor.name}"}
          required
        />
      </label>
      <div className="text-xs text-fg-muted">
        <span>Insert tag:</span>
        {TAG_HINTS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => insertTag(t)}
            className="ml-1 px-1.5 py-0.5 rounded bg-surface-2 border border-border hover:bg-surface text-[11px] font-mono"
          >
            {t}
          </button>
        ))}
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className="btn btn-secondary btn-sm">Cancel</button>
        <button type="submit" className="btn btn-primary btn-sm">
          {isEdit ? "Save" : "Create"}
        </button>
      </div>
    </form>
  );
}

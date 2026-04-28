import React, { useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import { useAuth } from "../context/AuthContext";

const ROLES = ["Admin", "Manager", "Submitter", "Viewer"];

function RolePill({ role }) {
  const colors = {
    Admin:
      "bg-purple-100 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300",
    Submitter: "bg-brand/15 text-brand",
    Viewer: "bg-surface-2 text-fg-muted",
  };
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded-full font-medium ${colors[role] || "bg-surface-2 text-fg-muted"}`}
    >
      {role}
    </span>
  );
}

export default function ProjectDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canEditProject = ["Admin", "Manager"].includes(user?.role);

  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [allUsers, setAllUsers] = useState([]);

  // Settings edit state
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({
    name: "",
    description: "",
    has_external_vendor: true,
    default_assignee_id: "",
  });
  const [savingSettings, setSavingSettings] = useState(false);

  // Add member state
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState({ user_id: "", role_override: "" });
  const [addingSaving, setAddingSaving] = useState(false);

  // Inline role edit
  const [editingMember, setEditingMember] = useState(null); // user_id
  const [editRoleValue, setEditRoleValue] = useState("");

  useEffect(() => {
    Promise.all([api.get(`/api/projects/${id}`), api.get("/api/users")])
      .then(([proj, users]) => {
        setProject(proj);
        setEditForm({
          name: proj.name,
          description: proj.description || "",
          has_external_vendor: proj.has_external_vendor !== false,
          default_assignee_id: proj.default_assignee_id
            ? String(proj.default_assignee_id)
            : "",
        });
        setAllUsers(users);
      })
      .catch(() => toast.error("Failed to load project"))
      .finally(() => setLoading(false));
  }, [id]);

  async function saveSettings(e) {
    e.preventDefault();
    if (!editForm.name.trim()) {
      toast.error("Name required");
      return;
    }
    setSavingSettings(true);
    try {
      const updated = await api.patch(`/api/projects/${id}`, {
        name: editForm.name.trim(),
        description: editForm.description.trim() || null,
        has_external_vendor: editForm.has_external_vendor,
        default_assignee_id: editForm.default_assignee_id
          ? Number(editForm.default_assignee_id)
          : null,
      });
      setProject((p) => ({ ...p, ...updated }));
      setEditing(false);
      toast.success("Settings saved");
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSavingSettings(false);
    }
  }

  async function toggleArchive() {
    const newStatus = project.status === "active" ? "archived" : "active";
    try {
      const updated = await api.patch(`/api/projects/${id}`, {
        status: newStatus,
      });
      setProject((p) => ({ ...p, ...updated }));
      toast.success(
        newStatus === "archived" ? "Project archived" : "Project restored",
      );
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function addMember(e) {
    e.preventDefault();
    if (!addForm.user_id) {
      toast.error("Select a user");
      return;
    }
    setAddingSaving(true);
    try {
      const member = await api.post(`/api/projects/${id}/members`, {
        user_id: Number(addForm.user_id),
        role_override: addForm.role_override || null,
      });
      setProject((p) => ({
        ...p,
        members: [...(p.members || []), member].sort((a, b) =>
          a.display_name.localeCompare(b.display_name),
        ),
      }));
      setAddForm({ user_id: "", role_override: "" });
      setAddOpen(false);
      toast.success("Member added");
    } catch (err) {
      toast.error(err.message);
    } finally {
      setAddingSaving(false);
    }
  }

  async function removeMember(userId) {
    try {
      await api.delete(`/api/projects/${id}/members/${userId}`);
      setProject((p) => ({
        ...p,
        members: p.members.filter((m) => m.user_id !== userId),
      }));
      toast.success("Member removed");
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function saveRoleOverride(userId) {
    try {
      await api.patch(`/api/projects/${id}/members/${userId}`, {
        role_override: editRoleValue || null,
      });
      setProject((p) => ({
        ...p,
        members: p.members.map((m) =>
          m.user_id === userId
            ? { ...m, role_override: editRoleValue || null }
            : m,
        ),
      }));
      setEditingMember(null);
      toast.success("Role updated");
    } catch (err) {
      toast.error(err.message);
    }
  }

  if (loading)
    return <div className="text-center text-fg-dim py-12">Loading…</div>;
  if (!project)
    return (
      <div className="text-center text-fg-dim py-12">Project not found.</div>
    );

  const memberUserIds = new Set((project.members || []).map((m) => m.user_id));
  const availableUsers = allUsers.filter((u) => !memberUserIds.has(u.id));

  return (
    <div className="max-w-3xl space-y-6">
      {/* Breadcrumb */}
      <div className="text-sm text-fg-dim">
        <Link to="/projects" className="hover:text-brand">
          Projects
        </Link>
        <span className="mx-1.5">›</span>
        <span className="text-fg">{project.name}</span>
      </div>

      {/* Settings card */}
      <div className="bg-surface border border-border rounded-lg shadow-sm p-5">
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm bg-surface-2 px-2 py-0.5 rounded">
                {project.prefix}
              </span>
              {project.status === "archived" && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-surface-2 text-fg-muted">
                  Archived
                </span>
              )}
            </div>
            {!editing && (
              <h1 className="text-lg font-semibold text-fg mt-1">
                {project.name}
              </h1>
            )}
            {!editing && project.description && (
              <p className="text-sm text-fg-muted mt-0.5">
                {project.description}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            {!editing && canEditProject && (
              <button
                onClick={() => setEditing(true)}
                className="btn-secondary btn btn-sm"
              >
                Edit
              </button>
            )}
            {canEditProject && (
              <button
                onClick={toggleArchive}
                className={`btn btn-sm ${project.status === "active" ? "btn-secondary text-amber-600 border-amber-300 dark:border-amber-900/50 hover:bg-amber-50 dark:hover:bg-amber-950/40 dark:bg-amber-950/40" : "btn-primary"}`}
              >
                {project.status === "active" ? "Archive" : "Restore"}
              </button>
            )}
          </div>
        </div>

        {editing && (
          <form onSubmit={saveSettings} className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-fg mb-1">
                Project Name
              </label>
              <input
                type="text"
                value={editForm.name}
                onChange={(e) =>
                  setEditForm((f) => ({ ...f, name: e.target.value }))
                }
                className="w-full border border-border-strong rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-fg mb-1">
                Description
              </label>
              <input
                type="text"
                value={editForm.description}
                onChange={(e) =>
                  setEditForm((f) => ({ ...f, description: e.target.value }))
                }
                className="w-full border border-border-strong rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="edit_has_vendor"
                checked={editForm.has_external_vendor}
                onChange={(e) =>
                  setEditForm((f) => ({
                    ...f,
                    has_external_vendor: e.target.checked,
                  }))
                }
                className="h-4 w-4 rounded border-border-strong text-brand focus:ring-brand/40"
              />
              <label htmlFor="edit_has_vendor" className="text-sm text-fg">
                This project has an external vendor
              </label>
            </div>
            <div>
              <label className="block text-xs text-fg-muted mb-1">
                Default assignee for new tickets
              </label>
              <select
                value={editForm.default_assignee_id}
                onChange={(e) =>
                  setEditForm((f) => ({
                    ...f,
                    default_assignee_id: e.target.value,
                  }))
                }
                className="w-full border border-border-strong rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
              >
                <option value="">— No default —</option>
                {allUsers
                  .filter(
                    (u) =>
                      u.status === "active" &&
                      ["Admin", "Manager", "Submitter"].includes(u.role),
                  )
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.display_name || u.email} ({u.role})
                    </option>
                  ))}
              </select>
              <p className="text-[11px] text-fg-muted mt-1">
                New tickets in this project auto-assign to this user when the
                creator doesn't pick one. Eligible: Submitter, Manager, Admin.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={savingSettings}
                className="btn-primary btn btn-sm disabled:opacity-60"
              >
                {savingSettings ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="btn-secondary btn btn-sm"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        <div className="mt-3 flex gap-4 text-sm text-fg-muted">
          <span>
            <strong className="text-fg">{project.ticket_count ?? 0}</strong>{" "}
            tickets
          </span>
          <span>
            <strong className="text-fg">
              {(project.members || []).length}
            </strong>{" "}
            members
          </span>
          <Link
            to={`/tickets?project_id=${project.id}`}
            className="text-brand hover:underline ml-auto"
          >
            View tickets →
          </Link>
        </div>
      </div>

      {/* Members card */}
      <div className="bg-surface border border-border rounded-lg shadow-sm">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 className="font-medium text-fg">Members</h2>
          <button
            onClick={() => setAddOpen((o) => !o)}
            className="btn-secondary btn btn-sm text-xs"
          >
            {addOpen ? "Cancel" : "+ Add Member"}
          </button>
        </div>

        {addOpen && (
          <form
            onSubmit={addMember}
            className="px-5 py-3 border-b border-border bg-surface-2 flex items-end gap-3 flex-wrap"
          >
            <div className="flex-1 min-w-40">
              <label className="block text-xs font-medium text-fg-muted mb-1">
                User
              </label>
              <select
                value={addForm.user_id}
                onChange={(e) =>
                  setAddForm((f) => ({ ...f, user_id: e.target.value }))
                }
                className="w-full border border-border-strong rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
              >
                <option value="">Select user…</option>
                {availableUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.display_name} ({u.role})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-fg-muted mb-1">
                Role Override <span className="text-fg-dim">(optional)</span>
              </label>
              <select
                value={addForm.role_override}
                onChange={(e) =>
                  setAddForm((f) => ({ ...f, role_override: e.target.value }))
                }
                className="border border-border-strong rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
              >
                <option value="">Use global role</option>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              disabled={addingSaving}
              className="btn-primary btn btn-sm disabled:opacity-60"
            >
              {addingSaving ? "Adding…" : "Add"}
            </button>
          </form>
        )}

        {(project.members || []).length === 0 ? (
          <p className="text-sm text-fg-dim px-5 py-4">
            No members yet. All Admins have implicit access.
          </p>
        ) : (
          <table className="min-w-full divide-y divide-border">
            <thead className="bg-surface-2">
              <tr>
                <th className="px-5 py-2 text-left text-xs font-medium text-fg-muted uppercase tracking-wide">
                  User
                </th>
                <th className="px-5 py-2 text-left text-xs font-medium text-fg-muted uppercase tracking-wide">
                  Global Role
                </th>
                <th className="px-5 py-2 text-left text-xs font-medium text-fg-muted uppercase tracking-wide">
                  Project Override
                </th>
                <th className="px-5 py-2 text-left text-xs font-medium text-fg-muted uppercase tracking-wide">
                  Effective
                </th>
                <th className="px-5 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {(project.members || []).map((m) => (
                <tr key={m.user_id} className="hover:bg-surface-2">
                  <td className="px-5 py-3">
                    <div className="text-sm font-medium text-fg">
                      {m.display_name}
                    </div>
                    <div className="text-xs text-fg-dim">{m.email}</div>
                  </td>
                  <td className="px-5 py-3">
                    <RolePill role={m.global_role} />
                  </td>
                  <td className="px-5 py-3">
                    {editingMember === m.user_id ? (
                      <div className="flex items-center gap-1.5">
                        <select
                          value={editRoleValue}
                          onChange={(e) => setEditRoleValue(e.target.value)}
                          className="border border-border-strong rounded px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-brand/40"
                        >
                          <option value="">None (use global)</option>
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() => saveRoleOverride(m.user_id)}
                          className="text-xs text-brand hover:underline"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => setEditingMember(null)}
                          className="text-xs text-fg-dim hover:text-fg-muted"
                        >
                          ×
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          setEditingMember(m.user_id);
                          setEditRoleValue(m.role_override || "");
                        }}
                        className="text-left group"
                      >
                        {m.role_override ? (
                          <RolePill role={m.role_override} />
                        ) : (
                          <span className="text-xs text-fg-dim group-hover:text-brand">
                            —
                          </span>
                        )}
                      </button>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <RolePill role={m.role_override || m.global_role} />
                  </td>
                  <td className="px-5 py-3 text-right">
                    <button
                      onClick={() => removeMember(m.user_id)}
                      className="text-xs text-fg-dim hover:text-red-500 transition-colors"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

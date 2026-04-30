import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import { useAuth } from "../context/AuthContext";
import HybridTime from "../components/HybridTime";

const ALL_ROLES = ["Admin", "Manager", "Submitter", "Viewer"];
const MANAGER_ROLES = ["Manager", "Submitter", "Viewer"];
const PROVIDERS = [
  ["local", "Local password"],
  ["entra", "Microsoft Entra / M365"],
  ["google", "Google"],
];

export default function AdminUsers() {
  const { user: currentUser } = useAuth();
  const isSuperAdmin = currentUser?.role === "Admin";
  const ROLES = isSuperAdmin ? ALL_ROLES : MANAGER_ROLES;
  const [users, setUsers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteForm, setInviteForm] = useState({
    email: "",
    role: "Viewer",
    intended_provider: "local",
    display_name: "",
  });

  function refresh() {
    setLoading(true);
    Promise.all([api.get("/api/users"), api.get("/api/invites")])
      .then(([u, i]) => {
        setUsers(u);
        setInvites(i);
        setLoading(false);
      })
      .catch((err) => {
        toast.error(err.message);
        setLoading(false);
      });
  }
  useEffect(refresh, []);

  async function changeRole(userId, role) {
    setSaving(userId);
    try {
      const updated = await api.patch(`/api/users/${userId}/role`, { role });
      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, role: updated.role } : u)),
      );
      toast.success("Role updated");
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(null);
    }
  }

  async function changeStatus(userId, status) {
    setSaving(userId);
    try {
      await api.patch(`/api/users/${userId}/status`, { status });
      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, status } : u)),
      );
      toast.success(`User ${status === "active" ? "enabled" : "disabled"}`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(null);
    }
  }

  async function deleteUser(userId) {
    if (!confirm("Delete this user? This cannot be undone.")) return;
    try {
      await api.delete(`/api/users/${userId}`);
      setUsers((prev) => prev.filter((u) => u.id !== userId));
      toast.success("User deleted");
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function sendInvite(e) {
    e.preventDefault();
    try {
      await api.post("/api/invites", inviteForm);
      toast.success(`Invite sent to ${inviteForm.email}`);
      setInviteForm({
        email: "",
        role: "Viewer",
        intended_provider: "local",
        display_name: "",
      });
      setShowInvite(false);
      refresh();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function revokeInvite(id) {
    if (!confirm("Revoke this invite?")) return;
    try {
      await api.delete(`/api/invites/${id}`);
      setInvites((prev) => prev.filter((i) => i.id !== id));
      toast.success("Invite revoked");
    } catch (err) {
      toast.error(err.message);
    }
  }

  if (loading)
    return <div className="text-fg-dim py-12 text-center">Loading...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-fg">User Management</h1>
        <button
          onClick={() => setShowInvite((v) => !v)}
          className="bg-brand hover:bg-brand-bright text-brand-fg text-sm font-medium px-3 py-1.5 rounded"
        >
          {showInvite ? "Cancel" : "Invite user"}
        </button>
      </div>

      {showInvite && (
        <form
          onSubmit={sendInvite}
          className="bg-surface border border-border rounded-lg p-4 space-y-3 max-w-md"
        >
          <h2 className="text-sm font-semibold text-fg">Invite a user</h2>
          <input
            type="email"
            required
            placeholder="Email"
            value={inviteForm.email}
            onChange={(e) =>
              setInviteForm({ ...inviteForm, email: e.target.value })
            }
            className="w-full border border-border-strong rounded px-3 py-1.5 text-sm"
          />
          <input
            type="text"
            placeholder="Display name (optional)"
            value={inviteForm.display_name}
            onChange={(e) =>
              setInviteForm({ ...inviteForm, display_name: e.target.value })
            }
            className="w-full border border-border-strong rounded px-3 py-1.5 text-sm"
          />
          <div className="grid grid-cols-2 gap-2">
            <select
              value={inviteForm.role}
              onChange={(e) =>
                setInviteForm({ ...inviteForm, role: e.target.value })
              }
              className="border border-border-strong rounded px-3 py-1.5 text-sm"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <select
              value={inviteForm.intended_provider}
              onChange={(e) =>
                setInviteForm({
                  ...inviteForm,
                  intended_provider: e.target.value,
                })
              }
              className="border border-border-strong rounded px-3 py-1.5 text-sm"
            >
              {PROVIDERS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            className="bg-brand hover:bg-brand-bright text-brand-fg text-sm font-medium px-3 py-1.5 rounded"
          >
            Send invite
          </button>
        </form>
      )}

      {invites.length > 0 && (
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
          <div className="px-4 py-2 bg-surface-2 border-b border-border">
            <h2 className="text-sm font-semibold text-fg">
              Outstanding invites ({invites.length})
            </h2>
          </div>
          <table className="min-w-full text-sm">
            <thead className="text-xs text-fg-muted bg-surface-2 border-b border-border">
              <tr>
                <th className="px-4 py-2 text-left">Email</th>
                <th className="px-4 py-2 text-left">Role</th>
                <th className="px-4 py-2 text-left">Method</th>
                <th className="px-4 py-2 text-left">Expires</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {invites.map((i) => (
                <tr key={i.id}>
                  <td className="px-4 py-2">{i.email}</td>
                  <td className="px-4 py-2">{i.role}</td>
                  <td className="px-4 py-2 text-xs text-fg-muted">
                    {i.intended_provider}
                  </td>
                  <td className="px-4 py-2 text-xs text-fg-muted">
                    <HybridTime dt={i.expires_at} />
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => revokeInvite(i.id)}
                      className="text-xs text-red-600 dark:text-red-400 hover:underline"
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="bg-surface rounded-lg border border-border shadow-sm overflow-hidden">
        <table className="min-w-full divide-y divide-border">
          <thead className="bg-surface-2">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-fg-muted uppercase tracking-wide">
                Name
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-fg-muted uppercase tracking-wide">
                Email
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-fg-muted uppercase tracking-wide">
                Provider
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-fg-muted uppercase tracking-wide">
                Role
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-fg-muted uppercase tracking-wide">
                Status
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-fg-muted uppercase tracking-wide">
                MFA
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-fg-muted uppercase tracking-wide">
                Last Login
              </th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {users.map((u) => {
              const isSelf = u.id === currentUser?.id;
              return (
                <tr
                  key={u.id}
                  className={`hover:bg-surface-2 ${isSelf ? "bg-brand/10" : ""}`}
                >
                  <td className="px-4 py-3 text-sm font-medium text-fg">
                    {u.display_name || (
                      <span className="text-fg-dim italic">—</span>
                    )}
                    {isSelf && (
                      <span className="ml-2 text-xs text-brand">(you)</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-fg-muted">{u.email}</td>
                  <td className="px-4 py-3 text-xs text-fg-muted font-mono">
                    {u.auth_provider}
                  </td>
                  <td className="px-4 py-3">
                    {isSelf ? (
                      <span className="text-sm text-fg-muted italic">
                        {u.role}
                      </span>
                    ) : (
                      <select
                        value={u.role}
                        onChange={(e) => changeRole(u.id, e.target.value)}
                        disabled={saving === u.id}
                        className="border border-border-strong rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40 disabled:opacity-60"
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {u.status === "active" && (
                      <span className="px-2 py-0.5 rounded bg-green-100 dark:bg-green-950/40 text-green-700 dark:text-green-300">
                        Active
                      </span>
                    )}
                    {u.status === "invited" && (
                      <span className="px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300">
                        Invited
                      </span>
                    )}
                    {u.status === "disabled" && (
                      <span className="px-2 py-0.5 rounded bg-red-100 dark:bg-red-950/40 text-red-700 dark:text-red-300">
                        Disabled
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {u.mfa_enabled ? (
                      <span className="text-green-700 dark:text-green-300">
                        On
                      </span>
                    ) : (
                      <span className="text-fg-dim">Off</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-fg-dim">
                    <HybridTime dt={u.last_login} />
                  </td>
                  <td className="px-4 py-3 text-right text-xs space-x-2">
                    {!isSelf && u.status === "active" && (
                      <button
                        onClick={() => changeStatus(u.id, "disabled")}
                        className="text-amber-600 dark:text-amber-400 hover:underline"
                      >
                        Disable
                      </button>
                    )}
                    {!isSelf && u.status === "disabled" && (
                      <button
                        onClick={() => changeStatus(u.id, "active")}
                        className="text-green-600 dark:text-green-400 hover:underline"
                      >
                        Enable
                      </button>
                    )}
                    {!isSelf &&
                      (u.status === "invited" || u.status === "disabled") && (
                        <button
                          onClick={() => deleteUser(u.id)}
                          className="text-red-600 dark:text-red-400 hover:underline"
                        >
                          Delete
                        </button>
                      )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {users.length === 0 && (
          <p className="text-sm text-fg-dim text-center py-8">No users yet</p>
        )}
      </div>
    </div>
  );
}

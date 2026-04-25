import React, { useState } from "react";
import toast from "react-hot-toast";
import { useAuth } from "../../context/AuthContext";

export default function AccountPassword() {
  const { user } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);

  if (user?.authProvider !== "local") {
    return (
      <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/50 rounded-md p-4 text-sm text-amber-900 dark:text-amber-300">
        Your account uses{" "}
        <strong className="capitalize">{user?.authProvider}</strong> sign-in.
        Manage your password through your identity provider.
      </div>
    );
  }

  async function submit(e) {
    e.preventDefault();
    if (newPassword !== confirm) {
      toast.error("New passwords do not match");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/auth/password/change", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed");
      toast.success("Password updated");
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 max-w-md">
      <div>
        <label className="block text-sm font-medium text-fg mb-1">
          Current password
        </label>
        <input
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          autoComplete="current-password"
          required
          className="w-full border border-border-strong rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-fg mb-1">
          New password
        </label>
        <input
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="new-password"
          required
          className="w-full border border-border-strong rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
        />
        <p className="text-xs text-fg-muted mt-1">
          At least 12 characters with uppercase, lowercase, and a digit.
        </p>
      </div>
      <div>
        <label className="block text-sm font-medium text-fg mb-1">
          Confirm new password
        </label>
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
          className="w-full border border-border-strong rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
        />
      </div>
      <button
        type="submit"
        disabled={submitting}
        className="px-4 py-2 bg-brand hover:bg-brand-bright disabled:opacity-60 text-brand-fg text-sm rounded-md"
      >
        {submitting ? "Updating…" : "Update password"}
      </button>
    </form>
  );
}

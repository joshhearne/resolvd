import React, { useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";

// Floating bar shown while an Admin is masquerading as another user
// (backend/routes/impersonation.js). Fixed to the bottom so it never
// shifts the header/sidebar layout. Release does a full reload so every
// context (auth, branding, filters) re-reads as the Admin.
export default function ImpersonationBanner({ user }) {
  const [busy, setBusy] = useState(false);
  if (!user?.impersonator) return null;

  async function release() {
    setBusy(true);
    try {
      await api.post("/api/impersonate/release", {});
      window.location.href = "/admin/users";
    } catch (e) {
      toast.error(e.message || "Couldn't release");
      setBusy(false);
    }
  }

  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] max-w-[calc(100vw-2rem)] flex items-center gap-3 rounded-full border border-amber-400/70 bg-amber-50 dark:bg-amber-950/80 text-amber-900 dark:text-amber-100 shadow-lg pl-4 pr-1.5 py-1.5 text-sm"
    >
      <span className="inline-block w-2 h-2 rounded-full bg-amber-500 animate-pulse shrink-0" />
      <span className="truncate">
        Viewing as <b>{user.displayName || user.email}</b>
        <span className="text-amber-700 dark:text-amber-300"> · {user.role}</span>
      </span>
      <button
        onClick={release}
        disabled={busy}
        className="shrink-0 rounded-full bg-amber-500 hover:bg-amber-600 text-white px-3 py-1 text-xs font-semibold disabled:opacity-60"
      >
        {busy ? "Releasing…" : `Release (back to ${user.impersonator.displayName || "me"})`}
      </button>
    </div>
  );
}

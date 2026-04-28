import React, { useState } from "react";
import toast from "react-hot-toast";
import { useAuth } from "../context/AuthContext";

function Toggle({ label, hint, value, onChange, disabled }) {
  return (
    <label className="flex items-start justify-between gap-4 py-3 border-b border-border last:border-0">
      <div className="flex-1">
        <div className="text-sm font-medium text-fg">{label}</div>
        {hint && <div className="text-xs text-fg-muted mt-0.5">{hint}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        disabled={disabled}
        onClick={() => onChange(!value)}
        className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
          value ? "bg-brand" : "bg-surface-2 border border-border-strong"
        } ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
      >
        <span
          className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
            value ? "translate-x-6" : "translate-x-1"
          }`}
        />
      </button>
    </label>
  );
}

export default function AccountPreferences() {
  const { user, updatePrefs } = useAuth();
  const [busy, setBusy] = useState(false);
  const prefs = user?.preferences || {};

  async function set(key, value) {
    setBusy(true);
    try {
      await updatePrefs({ [key]: value });
      toast.success("Saved");
    } catch (e) {
      toast.error(e.message || "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="bg-surface rounded-lg border border-border shadow-sm p-5">
        <h2 className="text-lg font-semibold text-fg mb-1">Workflow</h2>
        <p className="text-sm text-fg-muted mb-2">
          Tweak how Resolvd behaves day-to-day. Changes save automatically.
        </p>
        <div className="mt-3">
          <Toggle
            label="New ticket scope follows the active filter"
            hint="When you click + New Ticket from a filtered list that isn't your default project, preselect that project on the form."
            value={!!prefs.scope_follows_filter}
            onChange={(v) => set("scope_follows_filter", v)}
            disabled={busy}
          />
          <Toggle
            label="Ctrl+Enter posts a comment"
            hint="Submit a comment with Ctrl+Enter (⌘+Enter on Mac). Disable if you'd rather click the Post button only."
            value={!!prefs.ctrl_enter_to_post}
            onChange={(v) => set("ctrl_enter_to_post", v)}
            disabled={busy}
          />
          <Toggle
            label="Auto-follow tickets I comment on"
            hint="Add me as a follower automatically when I post a comment so I get future updates by email."
            value={!!prefs.auto_follow_on_comment}
            onChange={(v) => set("auto_follow_on_comment", v)}
            disabled={busy}
          />
          <Toggle
            label="Confirm before Post & Close"
            hint="Show a confirmation dialog before the Post & Close action so a stray click doesn't close a ticket."
            value={!!prefs.confirm_before_close}
            onChange={(v) => set("confirm_before_close", v)}
            disabled={busy}
          />
          <label className="flex items-start justify-between gap-4 py-3">
            <div className="flex-1">
              <div className="text-sm font-medium text-fg">
                Default ticket list sort
              </div>
              <div className="text-xs text-fg-muted mt-0.5">
                What you see first when opening the ticket list. Per-list sort
                changes are temporary; this is your default.
              </div>
            </div>
            <select
              value={prefs.default_ticket_sort || "updated_at_desc"}
              onChange={(e) => set("default_ticket_sort", e.target.value)}
              disabled={busy}
              className="border border-border-strong rounded-md px-2 py-1 text-sm"
            >
              <option value="updated_at_desc">Recently updated</option>
              <option value="created_at_desc">Newest first</option>
              <option value="effective_priority_asc">Highest priority</option>
              <option value="internal_ref_asc">Reference (A→Z)</option>
            </select>
          </label>
        </div>
      </div>

      <div className="bg-surface rounded-lg border border-border shadow-sm p-5">
        <h2 className="text-lg font-semibold text-fg mb-1">Email</h2>
        <p className="text-sm text-fg-muted mb-2">
          Choose which events on tickets you follow trigger an email. The
          in-app bell tray is unaffected.
        </p>
        <div className="mt-3">
          <Toggle
            label="Email me on new comments"
            hint="Receive an email when someone posts a comment on a ticket I follow."
            value={!!prefs.email_on_comment}
            onChange={(v) => set("email_on_comment", v)}
            disabled={busy}
          />
          <Toggle
            label="Email me on status changes"
            hint="Receive an email when a followed ticket's internal status changes."
            value={!!prefs.email_on_status_change}
            onChange={(v) => set("email_on_status_change", v)}
            disabled={busy}
          />
          <Toggle
            label="Email me when a ticket is assigned to me"
            hint="Receive an email when someone assigns a ticket to you. Self-assignments don't trigger this."
            value={!!prefs.email_on_assignment}
            onChange={(v) => set("email_on_assignment", v)}
            disabled={busy}
          />
        </div>
      </div>

      <div className="bg-surface rounded-lg border border-border shadow-sm p-5">
        <h2 className="text-lg font-semibold text-fg mb-1">Display</h2>
        <div className="mt-3">
          <Toggle
            label="Compact mode"
            hint="Tighter padding and smaller font sizes across lists. Useful on small screens or for power users."
            value={!!prefs.compact_mode}
            onChange={(v) => set("compact_mode", v)}
            disabled={busy}
          />
        </div>
      </div>
    </div>
  );
}

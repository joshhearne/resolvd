import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { useAuth } from "../context/AuthContext";
import { useBranding } from "../context/BrandingContext";
import {
  isPushSupported,
  getNotificationPermission,
  getCurrentSubscription,
  subscribePush,
  unsubscribePush,
} from "../utils/pushNotifications";

const DATE_STYLE_LABELS = {
  iso: "ISO (2026-04-28)",
  us: "US (Apr 28, 2026)",
  eu: "EU (28 Apr 2026)",
};
const TIME_STYLE_LABELS = {
  iso: "24-hour (14:32)",
  "12h": "12-hour (2:32 PM)",
};
const TZ_FALLBACKS = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "America/Phoenix",
  "America/Toronto",
  "America/Vancouver",
  "America/Mexico_City",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Amsterdam",
  "Europe/Madrid",
  "Europe/Rome",
  "Europe/Stockholm",
  "Europe/Moscow",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Shanghai",
  "Asia/Hong_Kong",
];
function tzList() {
  return typeof Intl?.supportedValuesOf === "function"
    ? Intl.supportedValuesOf("timeZone")
    : TZ_FALLBACKS;
}

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
  const { branding } = useBranding();
  const [busy, setBusy] = useState(false);
  const prefs = user?.preferences || {};

  const pushSupported = isPushSupported();
  const [pushPerm, setPushPerm] = useState(() => getNotificationPermission());
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);

  useEffect(() => {
    if (!pushSupported) return;
    getCurrentSubscription()
      .then((s) => setPushSubscribed(!!s))
      .catch(() => {});
  }, [pushSupported]);

  async function togglePushSubscription(enable) {
    setPushBusy(true);
    try {
      if (enable) {
        await subscribePush();
        setPushSubscribed(true);
        setPushPerm(getNotificationPermission());
        toast.success("Browser notifications enabled");
      } else {
        await unsubscribePush();
        setPushSubscribed(false);
        toast.success("Browser notifications disabled");
      }
    } catch (e) {
      toast.error(e.message || "Failed");
      setPushPerm(getNotificationPermission());
    } finally {
      setPushBusy(false);
    }
  }

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
        <h2 className="text-lg font-semibold text-fg mb-1">Browser notifications</h2>
        <p className="text-sm text-fg-muted mb-2">
          Get a desktop notification even when Resolvd isn't focused. Enable
          per browser; choose which events fire below.
        </p>
        {!pushSupported && (
          <div className="mt-2 text-xs text-fg-muted">
            This browser doesn't support push notifications.
          </div>
        )}
        {pushSupported && pushPerm === "denied" && (
          <div className="mt-2 text-xs text-amber-600">
            Notifications blocked at the browser level. Re-enable in your
            browser's site settings, then come back.
          </div>
        )}
        <div className="mt-3">
          <Toggle
            label="Enable browser notifications on this device"
            hint="First enable prompts your browser for permission. Disable removes this device's subscription."
            value={pushSubscribed}
            onChange={(v) => togglePushSubscription(v)}
            disabled={!pushSupported || pushBusy || pushPerm === "denied"}
          />
          <Toggle
            label="Notify me when a ticket is assigned to me"
            hint="Browser notification when someone assigns a ticket to you."
            value={!!prefs.push_on_assignment}
            onChange={(v) => set("push_on_assignment", v)}
            disabled={busy || !pushSubscribed}
          />
          <Toggle
            label="Notify me when I'm @mentioned"
            hint="Browser notification when someone mentions you in a comment."
            value={!!prefs.push_on_mention}
            onChange={(v) => set("push_on_mention", v)}
            disabled={busy || !pushSubscribed}
          />
        </div>
      </div>

      <div className="bg-surface rounded-lg border border-border shadow-sm p-5">
        <h2 className="text-lg font-semibold text-fg mb-1">Localization</h2>
        <p className="text-sm text-fg-muted mb-2">
          Override the org default for date, time, and timezone formatting.
          Leave any field on "Inherit org default" to follow the admin
          setting. Reports always render absolute timestamps in your chosen
          style.
        </p>
        <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
          <label className="block">
            <span className="block text-xs text-fg-muted mb-1">Date style</span>
            <select
              value={prefs.date_style_override || ""}
              onChange={(e) => set("date_style_override", e.target.value)}
              disabled={busy}
              className="w-full border border-border-strong rounded-md px-2 py-1.5 text-sm"
            >
              <option value="">
                Inherit org default ({DATE_STYLE_LABELS[branding.date_style] || branding.date_style || "ISO"})
              </option>
              <option value="iso">ISO (2026-04-28)</option>
              <option value="us">US (Apr 28, 2026)</option>
              <option value="eu">EU (28 Apr 2026)</option>
            </select>
          </label>
          <label className="block">
            <span className="block text-xs text-fg-muted mb-1">Time style</span>
            <select
              value={prefs.time_style_override || ""}
              onChange={(e) => set("time_style_override", e.target.value)}
              disabled={busy}
              className="w-full border border-border-strong rounded-md px-2 py-1.5 text-sm"
            >
              <option value="">
                Inherit org default ({TIME_STYLE_LABELS[branding.time_style] || branding.time_style || "24-hour"})
              </option>
              <option value="iso">24-hour (14:32)</option>
              <option value="12h">12-hour (2:32 PM)</option>
            </select>
          </label>
          <label className="block">
            <span className="block text-xs text-fg-muted mb-1">Time zone</span>
            <input
              type="text"
              list="account-timezone-list"
              value={prefs.timezone_override || ""}
              onChange={(e) => set("timezone_override", e.target.value)}
              disabled={busy}
              placeholder={`Inherit (${branding.timezone || "UTC"})`}
              className="w-full border border-border-strong rounded-md px-2 py-1.5 text-sm"
            />
            <datalist id="account-timezone-list">
              {tzList().map((tz) => (
                <option key={tz} value={tz} />
              ))}
            </datalist>
          </label>
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
          {branding.phonetic_readback_enabled !== false && (
            <Toggle
              label="Phonetic readback on ticket refs"
              hint="Hover a ticket ref (e.g. WEB-0079) to see &quot;Whiskey Echo Bravo - 0 0 7 9&quot; for reading aloud on phone calls."
              value={prefs.phonetic_readback !== false}
              onChange={(v) => set("phonetic_readback", v)}
              disabled={busy}
            />
          )}
        </div>
      </div>
    </div>
  );
}

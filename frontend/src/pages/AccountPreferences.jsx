import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { useAuth } from "../context/AuthContext";
import { useBranding } from "../context/BrandingContext";
import { api } from "../utils/api";
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

function MatrixSwitch({ checked, onChange, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors ${
        checked ? "bg-brand" : "bg-surface-2 border border-border-strong"
      } ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

const NOTIFICATION_EVENTS = [
  { key: "assignment", label: "Assigned to me", hint: "Someone assigns a ticket to me." },
  { key: "mention", label: "I get @mentioned", hint: "Someone mentions me in a comment." },
  { key: "comment", label: "New comment", hint: "A comment lands on a ticket I follow." },
  { key: "status_change", label: "Status changes", hint: "Internal status changes on a ticket I follow." },
  { key: "pending_review", label: "Pending review", hint: "Ticket flagged for admin review.", locked: true },
  { key: "follow_up", label: "Follow-up reminder", hint: "Scheduled follow-up I set.", locked: true },
];

const DEFAULT_MATRIX = {
  assignment: { in_app: true, email: true, push: false },
  mention: { in_app: true, email: true, push: true },
  comment: { in_app: true, email: true, push: false },
  status_change: { in_app: true, email: true, push: false },
  pending_review: { in_app: true, email: true, push: false },
  follow_up: { in_app: true, email: true, push: false },
};

function NotificationMatrix({ value, onChange, disabled, pushAvailable }) {
  const matrix = value || DEFAULT_MATRIX;
  function setCell(eventKey, channel, v) {
    onChange({
      ...matrix,
      [eventKey]: { ...matrix[eventKey], [channel]: v },
    });
  }
  return (
    <div className="border border-border rounded-md overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-surface-2 text-xs text-fg-muted">
          <tr>
            <th className="text-left px-3 py-2 font-medium">Event</th>
            <th className="px-3 py-2 font-medium w-20 text-center">In-app</th>
            <th className="px-3 py-2 font-medium w-20 text-center">Email</th>
            <th className="px-3 py-2 font-medium w-20 text-center">Push</th>
          </tr>
        </thead>
        <tbody>
          {NOTIFICATION_EVENTS.map((ev) => {
            const row = matrix[ev.key] || { in_app: false, email: false, push: false };
            return (
              <tr key={ev.key} className="border-t border-border">
                <td className="px-3 py-3">
                  <div className="text-sm font-medium text-fg">
                    {ev.label}
                    {ev.locked && (
                      <span className="ml-2 text-xs font-normal text-fg-muted">
                        (always on)
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-fg-muted mt-0.5">{ev.hint}</div>
                </td>
                <td className="px-3 py-3 text-center">
                  <div className="inline-flex">
                    <MatrixSwitch
                      checked={ev.locked ? true : !!row.in_app}
                      onChange={(v) => setCell(ev.key, "in_app", v)}
                      disabled={disabled || ev.locked}
                    />
                  </div>
                </td>
                <td className="px-3 py-3 text-center">
                  <div className="inline-flex">
                    <MatrixSwitch
                      checked={ev.locked ? true : !!row.email}
                      onChange={(v) => setCell(ev.key, "email", v)}
                      disabled={disabled || ev.locked}
                    />
                  </div>
                </td>
                <td className="px-3 py-3 text-center">
                  <div className="inline-flex">
                    <MatrixSwitch
                      checked={ev.locked ? false : !!row.push}
                      onChange={(v) => setCell(ev.key, "push", v)}
                      disabled={disabled || ev.locked || !pushAvailable}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AiAssistCard() {
  const [providers, setProviders] = useState([]);
  const [tones, setTones] = useState([]);
  const [verbosities, setVerbosities] = useState([]);
  const [cfg, setCfg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [showKeyEditor, setShowKeyEditor] = useState(false);
  const [testResult, setTestResult] = useState(null);

  useEffect(() => {
    Promise.all([
      api.get("/api/ai/providers"),
      api.get("/api/ai/config"),
    ]).then(([provs, c]) => {
      setProviders(provs.providers);
      setTones(provs.tones);
      setVerbosities(provs.verbosities);
      setCfg(c);
    }).catch(e => console.error("ai config load:", e.message));
  }, []);

  if (!cfg) return null;

  const provider = providers.find(p => p.id === cfg.provider) || null;

  async function patch(partial) {
    setBusy(true);
    try {
      const r = await api.patch("/api/ai/config", partial);
      setCfg(prev => ({ ...prev, ...r.ai_assist }));
      toast.success("Saved");
    } catch (e) {
      toast.error(e.message || "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveKey() {
    if (!keyInput.trim()) {
      toast.error("Enter a key");
      return;
    }
    setBusy(true);
    try {
      const r = await api.post("/api/ai/api-key", { api_key: keyInput });
      setCfg(prev => ({ ...prev, has_key: r.has_key }));
      setKeyInput("");
      setShowKeyEditor(false);
      toast.success("Key saved (encrypted at rest)");
    } catch (e) {
      toast.error(e.message || "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function clearKey() {
    if (!confirm("Remove the stored API key?")) return;
    setBusy(true);
    try {
      await api.post("/api/ai/api-key", { api_key: null });
      setCfg(prev => ({ ...prev, has_key: false }));
      toast.success("Key removed");
    } catch (e) {
      toast.error(e.message || "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    setBusy(true);
    setTestResult(null);
    try {
      const r = await api.post("/api/ai/test", {});
      setTestResult({ ok: true, msg: `OK · ${r.model} · ${r.latency_ms}ms` });
    } catch (e) {
      setTestResult({ ok: false, msg: e.message || "Failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-surface rounded-lg border border-border shadow-sm p-5">
      <h2 className="text-lg font-semibold text-fg mb-1">AI Assist</h2>
      <p className="text-sm text-fg-muted mb-3">
        Bring your own AI provider to rewrite comments and ticket text in
        different tones / verbosities. Your provider, your key, your call —
        Resolvd never sees the model output beyond passing it back to your
        browser. Disabled by default; opt in below.
      </p>

      {!cfg.org_enabled && (
        <div className="mb-3 px-3 py-2 rounded-md bg-amber-100 dark:bg-amber-900/30 text-amber-900 dark:text-amber-200 text-xs">
          Your org admin has disabled AI Assist organization-wide. The
          feature is unavailable until they re-enable it in Branding.
        </div>
      )}

      <Toggle
        label="Enable AI Assist for my account"
        hint="When off, no AI rewrite buttons appear in your composer."
        value={!!cfg.enabled}
        onChange={(v) => patch({ enabled: v })}
        disabled={busy || !cfg.org_enabled}
      />

      <div className={`mt-3 space-y-3 ${cfg.enabled ? "" : "opacity-50 pointer-events-none"}`}>
        <label className="block">
          <span className="block text-sm font-medium text-fg mb-1">Provider</span>
          <select
            value={cfg.provider || ""}
            onChange={(e) => patch({ provider: e.target.value || null })}
            disabled={busy}
            className="w-full border border-border-strong rounded-md px-2 py-1 text-sm"
          >
            <option value="">— pick a provider —</option>
            {providers.map(p => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </label>

        {provider && (
          <>
            <label className="block">
              <span className="block text-sm font-medium text-fg mb-1">Endpoint URL</span>
              <input
                type="url"
                placeholder={provider.default_endpoint}
                value={cfg.endpoint || ""}
                onChange={(e) => setCfg(prev => ({ ...prev, endpoint: e.target.value }))}
                onBlur={(e) => patch({ endpoint: e.target.value || null })}
                disabled={busy}
                className="w-full border border-border-strong rounded-md px-2 py-1 text-sm font-mono"
              />
              <span className="block text-xs text-fg-muted mt-0.5">
                Leave blank to use provider default ({provider.default_endpoint}).
              </span>
            </label>

            <label className="block">
              <span className="block text-sm font-medium text-fg mb-1">Model</span>
              <input
                type="text"
                placeholder={provider.default_model}
                value={cfg.model || ""}
                onChange={(e) => setCfg(prev => ({ ...prev, model: e.target.value }))}
                onBlur={(e) => patch({ model: e.target.value || null })}
                disabled={busy}
                className="w-full border border-border-strong rounded-md px-2 py-1 text-sm font-mono"
              />
            </label>

            {provider.needs_api_key && (
              <div>
                <span className="block text-sm font-medium text-fg mb-1">API key</span>
                {!cfg.has_key && !showKeyEditor && (
                  <button
                    type="button"
                    onClick={() => setShowKeyEditor(true)}
                    className="text-sm text-brand hover:underline"
                  >
                    + Add API key
                  </button>
                )}
                {cfg.has_key && !showKeyEditor && (
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-fg-muted font-mono">••••••••••••••• (stored, encrypted)</span>
                    <button type="button" onClick={() => setShowKeyEditor(true)} className="text-xs text-brand hover:underline">Replace</button>
                    <button type="button" onClick={clearKey} className="text-xs text-red-600 hover:underline">Remove</button>
                  </div>
                )}
                {showKeyEditor && (
                  <div className="flex items-center gap-2">
                    <input
                      type="password"
                      placeholder="Paste API key"
                      value={keyInput}
                      onChange={(e) => setKeyInput(e.target.value)}
                      autoComplete="off"
                      className="flex-1 border border-border-strong rounded-md px-2 py-1 text-sm font-mono"
                    />
                    <button type="button" onClick={saveKey} disabled={busy} className="px-3 py-1 text-sm bg-brand text-white rounded">Save</button>
                    <button type="button" onClick={() => { setShowKeyEditor(false); setKeyInput(""); }} className="px-2 py-1 text-sm text-fg-muted">Cancel</button>
                  </div>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-sm font-medium text-fg mb-1">Default tone</span>
                <select
                  value={cfg.default_tone}
                  onChange={(e) => patch({ default_tone: e.target.value })}
                  disabled={busy}
                  className="w-full border border-border-strong rounded-md px-2 py-1 text-sm"
                >
                  {tones.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="block text-sm font-medium text-fg mb-1">Default verbosity</span>
                <select
                  value={cfg.default_verbosity}
                  onChange={(e) => patch({ default_verbosity: e.target.value })}
                  disabled={busy}
                  className="w-full border border-border-strong rounded-md px-2 py-1 text-sm"
                >
                  {verbosities.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </label>
            </div>

            <div className="flex items-center gap-3 pt-1">
              <button
                type="button"
                onClick={testConnection}
                disabled={busy || !cfg.model || (provider.needs_api_key && !cfg.has_key)}
                className="px-3 py-1.5 text-sm border border-border-strong rounded-md hover:bg-surface-2 disabled:opacity-50"
              >
                Test connection
              </button>
              {testResult && (
                <span className={`text-xs ${testResult.ok ? "text-green-600" : "text-red-600"}`}>
                  {testResult.msg}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
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
        <h2 className="text-lg font-semibold text-fg mb-1">Notifications</h2>
        <p className="text-sm text-fg-muted mb-4">
          Pick how you find out about ticket activity. Pending review and
          follow-up reminders are always on. Pending review and follow-ups
          send email immediately regardless of the digest cadence below.
        </p>

        <div className="mb-4 pb-4 border-b border-border">
          {!pushSupported && (
            <div className="text-xs text-fg-muted">
              This browser doesn't support push notifications.
            </div>
          )}
          {pushSupported && pushPerm === "denied" && (
            <div className="text-xs text-amber-600">
              Notifications blocked at the browser level. Re-enable in your
              browser's site settings, then come back.
            </div>
          )}
          <Toggle
            label="Enable browser notifications on this device"
            hint="Required for the Push column below. First enable prompts your browser for permission; disable removes this device's subscription."
            value={pushSubscribed}
            onChange={(v) => togglePushSubscription(v)}
            disabled={!pushSupported || pushBusy || pushPerm === "denied"}
          />
        </div>

        <label className="block mb-4 pb-4 border-b border-border">
          <span className="block text-sm font-medium text-fg mb-1">
            Email digest cadence
          </span>
          <span className="block text-xs text-fg-muted mb-2">
            How often emails are batched. <strong>Instant</strong> sends each
            one as it happens. The digest groups events by ticket into a
            single email per cadence boundary. Set to <strong>Off</strong> to
            stop notification emails entirely.
          </span>
          <select
            value={prefs.email_digest || "instant"}
            onChange={(e) => set("email_digest", e.target.value)}
            disabled={busy}
            className="border border-border-strong rounded-md px-2 py-1 text-sm"
          >
            <option value="instant">Instant</option>
            <option value="hourly">Hourly</option>
            <option value="12h">Every 12 hours</option>
            <option value="daily">Daily digest</option>
            <option value="off">Off (no notification emails)</option>
          </select>
        </label>

        <NotificationMatrix
          value={prefs.notification_prefs || DEFAULT_MATRIX}
          onChange={(v) => set("notification_prefs", v)}
          disabled={busy}
          pushAvailable={pushSubscribed}
        />
      </div>

      <AiAssistCard />

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

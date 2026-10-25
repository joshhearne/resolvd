import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";

// Org-wide technician time tracking policy. Techs log time with a
// required note; the note lands as a private (handler-only) ticket note
// unless the policy below makes it public. Visibility never implies
// billable — that's a separate per-entry flag for Admin/Manager.

function Toggle({ checked, onChange, label, help }) {
  return (
    <label className="flex items-start gap-2 py-1.5">
      <input type="checkbox" className="mt-0.5" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="text-sm text-fg">{label}</span>
        {help && <span className="block text-xs text-fg-muted">{help}</span>}
      </span>
    </label>
  );
}

function Radio({ name, value, current, onChange, label, help }) {
  return (
    <label className="flex items-start gap-2 py-1">
      <input type="radio" name={name} className="mt-0.5" checked={current === value} onChange={() => onChange(value)} />
      <span>
        <span className="text-sm text-fg">{label}</span>
        {help && <span className="block text-xs text-fg-muted">{help}</span>}
      </span>
    </label>
  );
}

export default function AdminTimeTracking() {
  const [s, setS] = useState(null);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get("/api/time-tracking/settings")
      .then(setS)
      .catch((e) => toast.error(e.message || "Failed to load"));
  }, []);

  if (!s) return <p className="text-sm text-fg-muted">Loading…</p>;

  const v = { ...s, ...draft };
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const dirty = Object.keys(draft).length > 0;

  async function save() {
    setSaving(true);
    try {
      const next = await api.patch("/api/time-tracking/settings", draft);
      setS(next);
      setDraft({});
      toast.success("Saved");
    } catch (e) {
      toast.error(e.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="bg-surface border border-border rounded-lg p-4">
        <h2 className="text-base font-semibold text-fg mb-1">Time tracking</h2>
        <p className="text-xs text-fg-muted mb-3">
          Technicians run a timer while they work a ticket and log the time
          with a note describing what they did. Notes are <b>private</b> by
          default: they're saved as internal notes only handlers can see, so
          tech chatter never lands on the customer thread.
        </p>
        <Toggle checked={v.enabled} onChange={(enabled) => set({ enabled })} label="Enable time tracking" />
      </div>

      <div className={`bg-surface border border-border rounded-lg p-4 ${v.enabled ? "" : "opacity-60"}`}>
        <h3 className="text-sm font-semibold text-fg mb-2">Auto-start</h3>
        <p className="text-xs text-fg-muted mb-2">
          Only fires when the tech is solo on the ticket: it's unassigned or
          assigned to them, and nobody else has a timer running on it.
          Starting a timer pauses any other timer the tech has running.
        </p>
        <Toggle
          checked={v.auto_start_on_take}
          onChange={(auto_start_on_take) => set({ auto_start_on_take })}
          label="When a tech takes a ticket"
          help="Assigning a ticket to yourself starts your timer."
        />
        <Toggle
          checked={v.auto_start_on_open}
          onChange={(auto_start_on_open) => set({ auto_start_on_open })}
          label="When a tech opens a ticket"
          help="Opening a ticket starts your timer. Pair with the discard rule below so quick look-ups don't pile up."
        />
      </div>

      <div className={`bg-surface border border-border rounded-lg p-4 ${v.enabled ? "" : "opacity-60"}`}>
        <h3 className="text-sm font-semibold text-fg mb-2">Discard untouched timers</h3>
        <p className="text-xs text-fg-muted mb-2">
          When a tech leaves a ticket and the status hasn't changed since the
          timer started (and nothing was logged), throw the timer away.
          Timers that survive keep running until the tech pauses, logs, or
          discards them.
        </p>
        <Radio name="discard" value="auto_started" current={v.discard_untouched} onChange={(discard_untouched) => set({ discard_untouched })} label="Auto-started timers only" help="Timers a tech starts by hand are left alone." />
        <Radio name="discard" value="all" current={v.discard_untouched} onChange={(discard_untouched) => set({ discard_untouched })} label="All timers" />
        <Radio name="discard" value="off" current={v.discard_untouched} onChange={(discard_untouched) => set({ discard_untouched })} label="Never" />
      </div>

      <div className={`bg-surface border border-border rounded-lg p-4 ${v.enabled ? "" : "opacity-60"}`}>
        <h3 className="text-sm font-semibold text-fg mb-2">Unlogged-time warning</h3>
        <label className="flex flex-wrap items-center gap-2 text-sm text-fg">
          Warn the tech when a timer has run
          <input
            type="number" min="0" max="1440"
            value={v.warn_after_minutes}
            onChange={(e) => set({ warn_after_minutes: Number(e.target.value) })}
            className="input w-20 py-1"
          />
          minutes with no work logged
        </label>
        <p className="text-xs text-fg-muted mt-1">
          The timer turns amber on the ticket and the tech gets one in-app
          notification. Set to 0 to turn off.
        </p>
      </div>

      <div className={`bg-surface border border-border rounded-lg p-4 ${v.enabled ? "" : "opacity-60"}`}>
        <h3 className="text-sm font-semibold text-fg mb-2">Work notes</h3>
        <label className="flex flex-wrap items-center gap-2 text-sm text-fg mb-3">
          Notes must be at least
          <input
            type="number" min="1" max="500"
            value={v.min_note_chars}
            onChange={(e) => set({ min_note_chars: Number(e.target.value) })}
            className="input w-20 py-1"
          />
          characters
        </label>

        <p className="text-xs font-semibold text-fg-muted uppercase mb-1">Default visibility</p>
        <Radio name="vis" value="private" current={v.default_visibility} onChange={(default_visibility) => set({ default_visibility })} label="Private note" help="Handlers only. Never sent to the requester or vendors." />
        <Radio name="vis" value="public" current={v.default_visibility} onChange={(default_visibility) => set({ default_visibility })} label="Public comment" help="Posted on the ticket thread; the requester and followers are notified." />

        <p className="text-xs font-semibold text-fg-muted uppercase mt-3 mb-1">Who can choose</p>
        <Radio name="choice" value="admins" current={v.visibility_choice} onChange={(visibility_choice) => set({ visibility_choice })} label="Admins and Managers only" help="Techs always get the default above." />
        <Radio name="choice" value="handlers" current={v.visibility_choice} onChange={(visibility_choice) => set({ visibility_choice })} label="Any handler" help="Techs pick private or public per entry." />

        <p className="text-xs text-fg-muted mt-3 border-t border-border pt-2">
          Visibility and billing are separate. A public note is not billable,
          and a private one isn't excluded from billing. Admins and Managers
          mark individual entries billable from the ticket's time log; any
          future invoicing export reads only that flag.
        </p>
      </div>

      <div className="flex justify-end">
        <button disabled={!dirty || saving} onClick={save} className="btn btn-primary">
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
  );
}

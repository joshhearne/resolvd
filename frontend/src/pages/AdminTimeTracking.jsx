import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import { previewBillable } from "../utils/billing";

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

function fmt(m) {
  const t = Math.max(0, Math.round(Number(m) || 0));
  const h = Math.floor(t / 60);
  const r = t % 60;
  if (!h) return `${r}m`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

const INCREMENTS = [
  { value: 1, label: "No rounding" },
  { value: 5, label: "5 minutes" },
  { value: 6, label: "6 minutes (0.1 h)" },
  { value: 10, label: "10 minutes" },
  { value: 15, label: "15 minutes (0.25 h)" },
  { value: 30, label: "30 minutes" },
];

// Billable-hours rules. They never change what a tech logged: billable
// minutes are worked out from the logged minutes of entries flagged
// billable, so rules can change without rewriting history (anything
// already invoiced keeps the figure it was invoiced at).
function BillingCard({ v, set, enabled }) {
  const [sample, setSample] = useState("7, 22, 41");
  const sessions = sample
    .split(/[\s,]+/)
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n > 0)
    .slice(0, 12);
  const p = previewBillable(sessions, v);
  const logged = sessions.reduce((a, b) => a + b, 0);
  const rounding = Number(v.billing_round_increment) > 1;

  return (
    <div className={`bg-surface border border-border rounded-lg p-4 ${enabled ? "" : "opacity-60"}`}>
      <h3 className="text-sm font-semibold text-fg mb-1">Billable hours</h3>
      <p className="text-xs text-fg-muted mb-3">
        Rules for turning logged time into billable time. They apply only to
        entries marked billable, and never change what the tech logged —
        the logged minutes stay as worked, and billable minutes are shown
        alongside. Changing a rule re-prices everything not yet invoiced.
      </p>

      <Toggle
        checked={v.billable_by_default}
        onChange={(billable_by_default) => set({ billable_by_default })}
        label="New entries are billable by default"
        help="Off: Admins/Managers tick billable per entry. On: entries start billable and can be unticked."
      />

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-fg-muted uppercase">Round each session to</span>
          <select
            value={v.billing_round_increment}
            onChange={(e) => set({ billing_round_increment: Number(e.target.value) })}
            className="input py-1"
          >
            {INCREMENTS.map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}
          </select>
        </label>
        <div className={`flex flex-col gap-1 ${rounding ? "" : "opacity-50"}`}>
          <span className="text-xs font-semibold text-fg-muted uppercase">Rounding</span>
          <div className="flex flex-wrap gap-3 text-sm">
            {[["up", "Up"], ["nearest", "Nearest"], ["down", "Down"]].map(([val, label]) => (
              <label key={val} className="inline-flex items-center gap-1">
                <input
                  type="radio" name="round-mode" disabled={!rounding}
                  checked={v.billing_round_mode === val}
                  onChange={() => set({ billing_round_mode: val })}
                />
                {label}
              </label>
            ))}
          </div>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-fg-muted uppercase">Minimum per session</span>
          <span className="flex items-center gap-2 text-sm">
            <input
              type="number" min="0" max="480"
              value={v.billing_session_minimum}
              onChange={(e) => set({ billing_session_minimum: Number(e.target.value) })}
              className="input w-20 py-1"
            />
            minutes <span className="text-xs text-fg-dim">(0 = none)</span>
          </span>
          <span className="text-xs text-fg-muted">Each billable log entry counts as at least this much.</span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-fg-muted uppercase">Minimum per ticket</span>
          <span className="flex items-center gap-2 text-sm">
            <input
              type="number" min="0" max="480"
              value={v.billing_ticket_minimum}
              onChange={(e) => set({ billing_ticket_minimum: Number(e.target.value) })}
              className="input w-20 py-1"
            />
            minutes <span className="text-xs text-fg-dim">(0 = none)</span>
          </span>
          <span className="text-xs text-fg-muted">
            A ticket with any billable time bills at least this much; anything above it counts as-is.
          </span>
        </label>
      </div>

      <div className="mt-4 border border-border rounded p-3 bg-surface-2/40">
        <label className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
          Preview — billable sessions on one ticket (minutes):
          <input value={sample} onChange={(e) => setSample(e.target.value)} className="input py-1 w-48 text-sm" />
        </label>
        {sessions.length ? (
          <table className="mt-2 text-sm">
            <tbody>
              {sessions.map((m, i) => (
                <tr key={i}>
                  <td className="pr-3 text-fg-muted">Session {i + 1}</td>
                  <td className="pr-3 tabular-nums">{fmt(m)} logged</td>
                  <td className="tabular-nums">→ <b>{fmt(p.per[i])}</b> billable</td>
                </tr>
              ))}
              {p.topUp > 0 && (
                <tr>
                  <td className="pr-3 text-fg-muted">Ticket minimum</td>
                  <td />
                  <td className="tabular-nums">+ {fmt(p.topUp)}</td>
                </tr>
              )}
              <tr className="border-t border-border">
                <td className="pr-3 pt-1 font-medium">Total</td>
                <td className="pr-3 pt-1 tabular-nums">{fmt(logged)} logged</td>
                <td className="pt-1 tabular-nums"><b>{fmt(p.total)}</b> billable ({(p.total / 60).toFixed(2)} h)</td>
              </tr>
            </tbody>
          </table>
        ) : (
          <p className="mt-2 text-xs text-fg-dim">Enter some minutes, e.g. 7, 22, 41.</p>
        )}
      </div>
    </div>
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
          and a private one isn't excluded from billing. Billable is set per
          entry — see Billable hours below.
        </p>
      </div>

      <BillingCard v={v} set={set} enabled={v.enabled} />

      <div className="flex justify-end">
        <button disabled={!dirty || saving} onClick={save} className="btn btn-primary">
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
  );
}

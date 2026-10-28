import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import { previewBillable } from "../utils/billing";
import { useBranding } from "../context/BrandingContext";
import SaveBar from "../components/SaveBar";
import { RateCardsCard, BillingTypesCard, UtilisationCard, MspOffNote } from "../components/BillingAdmin";
import NumberInput from "../components/NumberInput";

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
        alongside.
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
            <NumberInput
              min="0" max="480"
              value={v.billing_session_minimum}
              onChange={(n) => set({ billing_session_minimum: n })}
              className="input w-20 py-1"
            />
            minutes <span className="text-xs text-fg-dim">(0 = none)</span>
          </span>
          <span className="text-xs text-fg-muted">Each billable log entry counts as at least this much.</span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-fg-muted uppercase">Minimum per ticket</span>
          <span className="flex items-center gap-2 text-sm">
            <NumberInput
              min="0" max="480"
              value={v.billing_ticket_minimum}
              onChange={(n) => set({ billing_ticket_minimum: n })}
              className="input w-20 py-1"
            />
            minutes <span className="text-xs text-fg-dim">(0 = none)</span>
          </span>
          <span className="text-xs text-fg-muted">
            A ticket with any billable time bills at least this much; anything above it counts as-is.
          </span>
          <span className="flex flex-wrap gap-3 text-sm mt-1">
            {[["ticket", "Once per ticket"], ["day", "Once per day of work"]].map(([val, label]) => (
              <label key={val} className="inline-flex items-center gap-1">
                <input
                  type="radio" name="min-scope"
                  checked={(v.billing_ticket_minimum_scope || "ticket") === val}
                  onChange={() => set({ billing_ticket_minimum_scope: val })}
                />
                {label}
              </label>
            ))}
          </span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-fg-muted uppercase">Currency</span>
          <input
            value={v.billing_currency || "USD"}
            onChange={(e) => set({ billing_currency: e.target.value.toUpperCase().slice(0, 3) })}
            className="input w-24 py-1 uppercase"
            aria-label="Currency code"
          />
          <span className="text-xs text-fg-muted">3-letter code (USD, GBP, AUD…). Used on rates and exports.</span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-fg-muted uppercase">Prepaid block alert</span>
          <span className="flex items-center gap-2 text-sm">
            Warn at
            <NumberInput
              min="0" max="100"
              value={v.billing_block_alert_percent ?? 80}
              onChange={(n) => set({ billing_block_alert_percent: n })}
              className="input w-20 py-1"
            />
            % used
          </span>
          <span className="text-xs text-fg-muted">
            Admins and Managers get one notification per block period when a customer's block reaches this, and another when it's used up. 0 = only when used up.
          </span>
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-fg-muted uppercase">Approval</span>
          <Toggle
            checked={v.billing_require_approval}
            onChange={(billing_require_approval) => set({ billing_require_approval })}
            label="Billable time needs Admin/Manager approval"
            help="Approved time locks for techs. The export can be limited to approved time."
          />
        </div>
      </div>

      <div className="mt-4">
        <p className="text-xs font-semibold text-fg-muted uppercase mb-1">When these rules change</p>
        <Radio
          name="reprice" value="uninvoiced" current={v.billing_reprice || "uninvoiced"}
          onChange={(billing_reprice) => set({ billing_reprice })}
          label="Re-price all time not yet invoiced"
          help="Every uninvoiced entry is billed by the current rules."
        />
        <Radio
          name="reprice" value="at_log" current={v.billing_reprice || "uninvoiced"}
          onChange={(billing_reprice) => set({ billing_reprice })}
          label="Keep each entry at the rules in force when it was logged"
          help="New rules apply to time logged from now on. A ticket's minimum comes from the rules when its first billable time was logged. Entries logged before this option existed use the current rules."
        />
        <p className="text-xs text-fg-muted mt-1">
          There's no invoicing yet. When it's added, invoiced time will be
          frozen at what it was billed, whichever option is chosen here.
        </p>
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

// Work types save immediately (they're rows, not part of the settings
// draft). A type already used on entries is retired rather than deleted.
function WorkTypesCard({ msp }) {
  const [types, setTypes] = useState(null);
  const [name, setName] = useState("");
  const [billable, setBillable] = useState(true);

  const load = () =>
    api.get("/api/time-tracking/work-types?all=1").then(setTypes).catch((e) => toast.error(e.message));
  useEffect(() => { load(); }, []);

  async function add(e) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await api.post("/api/time-tracking/work-types", { name: name.trim(), billable, sort_order: (types?.length || 0) * 10 });
      setName("");
      load();
    } catch (err) { toast.error(err.message); }
  }
  async function patch(t, body) {
    try { await api.patch(`/api/time-tracking/work-types/${t.id}`, body); load(); }
    catch (err) { toast.error(err.message); }
  }
  async function remove(t) {
    if (!window.confirm(`Remove "${t.name}"?`)) return;
    try {
      const r = await api.delete(`/api/time-tracking/work-types/${t.id}`);
      if (r.retired) toast("In use on logged time, so it was retired instead of deleted.");
      load();
    } catch (err) { toast.error(err.message); }
  }

  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <h3 className="text-sm font-semibold text-fg mb-1">Work types</h3>
      <p className="text-xs text-fg-muted mb-3">
        Optional labels techs pick when logging (Remote, Onsite, Travel,
        Internal…). With no types defined, the picker is hidden.
        {msp && " A type's billable setting decides whether new entries of that type start billable, so internal or admin time never lands on a bill by accident. Rate cards can price each type differently."}
      </p>
      {types === null ? (
        <p className="text-sm text-fg-muted">Loading…</p>
      ) : (
        <ul className="divide-y divide-border border border-border rounded mb-3">
          {types.length === 0 && <li className="px-3 py-2 text-sm text-fg-dim">No work types yet.</li>}
          {types.map((t) => (
            <li key={t.id} className={`px-3 py-2 flex flex-wrap items-center gap-3 text-sm ${t.active ? "" : "opacity-60"}`}>
              <input
                defaultValue={t.name}
                onBlur={(e) => { const n = e.target.value.trim(); if (n && n !== t.name) patch(t, { name: n }); }}
                className="input py-1 w-48"
                aria-label="Work type name"
              />
              {msp && (
                <label className="inline-flex items-center gap-1">
                  <input type="checkbox" checked={t.billable} onChange={() => patch(t, { billable: !t.billable })} />
                  billable
                </label>
              )}
              <label className="inline-flex items-center gap-1">
                <input type="checkbox" checked={t.active} onChange={() => patch(t, { active: !t.active })} />
                active
              </label>
              <button onClick={() => remove(t)} className="ml-auto text-xs text-fg-muted hover:text-red-600">remove</button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="flex flex-wrap items-center gap-3 text-sm">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New type, e.g. Onsite" className="input py-1 w-48" />
        {msp && (
          <label className="inline-flex items-center gap-1">
            <input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} />
            billable
          </label>
        )}
        <button type="submit" className="btn btn-sm btn-secondary" disabled={!name.trim()}>Add</button>
      </form>
    </div>
  );
}

function IntegrityCard({ v, set, enabled }) {
  return (
    <div className={`bg-surface border border-border rounded-lg p-4 ${enabled ? "" : "opacity-60"}`}>
      <h3 className="text-sm font-semibold text-fg mb-2">Timesheet integrity</h3>
      <p className="text-xs font-semibold text-fg-muted uppercase mb-1">Overlapping time</p>
      <p className="text-xs text-fg-muted mb-1">
        When a tech logs a session that overlaps time they already logged (on
        any ticket) — the usual way time gets billed twice.
      </p>
      <Radio name="overlap" value="warn" current={v.overlap_policy} onChange={(overlap_policy) => set({ overlap_policy })} label="Warn and ask to confirm" />
      <Radio name="overlap" value="block" current={v.overlap_policy} onChange={(overlap_policy) => set({ overlap_policy })} label="Block it" />
      <Radio name="overlap" value="allow" current={v.overlap_policy} onChange={(overlap_policy) => set({ overlap_policy })} label="Allow" />

      <p className="text-xs font-semibold text-fg-muted uppercase mt-3 mb-1">Timesheet lock</p>
      <label className="flex flex-wrap items-center gap-2 text-sm text-fg">
        Techs can't edit or delete entries older than
        <NumberInput
          min="0" max="365"
          value={v.edit_lock_days}
          onChange={(n) => set({ edit_lock_days: n })}
          className="input w-20 py-1"
        />
        days
      </label>
      <p className="text-xs text-fg-muted mt-1">
        Keeps reviewed or invoiced periods stable. Admins and Managers can
        still correct them. 0 turns the lock off.
      </p>
    </div>
  );
}

function ymd(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// CSV of entries for a date range — logged and billable minutes (current
// rules), ticket-minimum top-ups as their own rows. Handy for building
// invoices by hand until an accounting integration exists.
function ExportCard({ msp, requireApproval }) {
  const now = new Date();
  const [approvedOnly, setApprovedOnly] = useState(!!requireApproval);
  const [from, setFrom] = useState(ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)));
  const [to, setTo] = useState(ymd(new Date(now.getFullYear(), now.getMonth(), 0)));

  function download() {
    const [fy, fm, fd] = from.split("-").map(Number);
    const [ty, tm, td] = to.split("-").map(Number);
    const start = new Date(fy, fm - 1, fd);
    const end = new Date(ty, tm - 1, td + 1); // whole "to" day, local time
    if (!(end > start)) { toast.error("End date must be on or after the start date"); return; }
    const qs = new URLSearchParams({ from: start.toISOString(), to: end.toISOString() });
    if (msp && approvedOnly) qs.set("approved_only", "1");
    const a = document.createElement("a");
    a.href = `/api/time-tracking/export?${qs}`;
    a.download = `time-entries-${from}-to-${to}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <h3 className="text-sm font-semibold text-fg mb-1">Export time</h3>
      <p className="text-xs text-fg-muted mb-3">
        CSV of every entry that ended in the range: ticket, tech, type, times,
        logged and billable minutes (using the rules above), visibility and
        note. Ticket-minimum top-ups appear as their own rows. Defaults to last
        month.
        {msp && " In MSP mode each row also carries the customer, contract and its reference, bill type and its code, rate, coverage and amount — ready to pass through to your accounting system."}
      </p>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input py-1 w-40" aria-label="From" />
        <span className="text-fg-muted">to</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input py-1 w-40" aria-label="To" />
        {msp && (
          <label className="inline-flex items-center gap-1 text-xs">
            <input type="checkbox" checked={approvedOnly} onChange={(e) => setApprovedOnly(e.target.checked)} />
            approved time only
          </label>
        )}
        <button onClick={download} className="btn btn-sm btn-secondary">Download CSV</button>
      </div>
    </div>
  );
}

export default function AdminTimeTracking() {
  const { branding } = useBranding();
  // Billing (billable hours, rates, bill types) is an MSP concern: hidden
  // unless customer companies / MSP mode is on.
  const msp = branding?.enable_customer_companies === true;
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
          <NumberInput
            min="0" max="1440"
            value={v.warn_after_minutes}
            onChange={(n) => set({ warn_after_minutes: n })}
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
          <NumberInput
            min="1" max="500"
            value={v.min_note_chars}
            onChange={(n) => set({ min_note_chars: n })}
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

        {msp && (
          <p className="text-xs text-fg-muted mt-3 border-t border-border pt-2">
            Visibility and billing are separate. A public note is not billable,
            and a private one isn't excluded from billing. Billable is set per
            entry — see Billable hours below.
          </p>
        )}
      </div>

      {msp && <BillingCard v={v} set={set} enabled={v.enabled} />}
      <IntegrityCard v={v} set={set} enabled={v.enabled} />

      <WorkTypesCard msp={msp} />
      {msp ? (
        <>
          <RateCardsCard currency={s.billing_currency} />
          <BillingTypesCard />
          <UtilisationCard />
        </>
      ) : (
        <MspOffNote />
      )}
      <ExportCard msp={msp} requireApproval={s.billing_require_approval} />

      {/* Saves the settings cards; the list cards (work types, rate
          cards, bill types) save as they're edited. */}
      <SaveBar
        dirty={dirty}
        saving={saving}
        onSave={save}
        onDiscard={() => setDraft({})}
        savedHint="lists save as you edit them"
      />
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import HybridTime from "./HybridTime";
import ConfirmDialog from "./ConfirmDialog";
import TimeEntryForm from "./TimeEntryForm";
import { formatShortDate, formatTime } from "../utils/timeEntry";
import { formatMoney, behaviorLabel } from "./BillingAdmin";

// Technician time tracking on a ticket. Handler-only: the parent renders
// it once the notes gate has confirmed access.
//
// Timer bar: live clock, start / pause / resume, log work, discard.
// Log panel (TimeEntryForm): start / duration / stop, any two of which
// fix the third, plus a required note describing the work. Notes are
// private (handler-only) by default; whether a tech can make one public
// is the admin's call (Admin → Time tracking). Public is NOT billable —
// billable is a separate Admin/Manager flag on the entry.
//
// Leaving the ticket tells the server, which throws away an untouched
// auto-started timer (status unchanged, nothing logged) when the admin
// has that rule on. Otherwise the clock keeps running — techs often step
// away from the page to do the work — and the header pill shows it.
//
// Putting the ticket on hold (or resolving it) pauses the timer server-
// side. Nothing resumes it automatically: a requester replying to a held
// ticket doesn't restart the clock; the tech resumes when they pick the
// ticket back up.

export const TIMERS_CHANGED = "resolvd:timers-changed";

export function announceTimersChanged() {
  window.dispatchEvent(new Event(TIMERS_CHANGED));
}

export function fmtClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export function fmtMinutes(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return `${r}m`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

// Elapsed seconds as of now, from a timer snapshot taken at `fetchedAt`.
function liveSeconds(timer, fetchedAt) {
  if (!timer) return 0;
  if (!timer.running) return timer.elapsed_seconds;
  return timer.elapsed_seconds + (Date.now() - fetchedAt) / 1000;
}

function suggestedMinutes(seconds) {
  if (seconds <= 0) return 0;
  return Math.max(1, Math.round(seconds / 60));
}

function leaveTicket(ticketId) {
  // keepalive lets the request finish when the tab is closing.
  return fetch(`/api/tickets/${ticketId}/timer/leave`, {
    method: "POST",
    credentials: "include",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }).then((r) => (r.ok ? r.json() : null));
}

function pauseLabel(reason) {
  if (!reason) return "paused";
  if (reason === "switched") return "paused — you started another timer";
  if (reason.startsWith("status:")) return `paused — ticket moved to ${reason.slice(7)}`;
  return "paused";
}

const COVERAGE_LABEL = {
  hourly: "",
  covered: "covered by contract",
  block: "from prepaid block",
  block_overage: "part block, part overage",
  overage: "block used up — overage",
  non_billable: "non-billable contract",
};
const HOURS_LABEL = { after_hours: "after-hours", weekend: "weekend" };

// One entry's price: billable minutes, rate (with any after-hours /
// weekend multiplier), coverage and amount.
function PriceLine({ line, currency, logged }) {
  if (!line) return null;
  const parts = [];
  if (line.billable_minutes !== logged) parts.push(`${fmtMinutes(line.billable_minutes)} billable`);
  if (line.rate_cents) {
    parts.push(`${formatMoney(line.rate_cents, currency)}/h${line.multiplier !== 1 ? ` (${HOURS_LABEL[line.hours_class] || ""} ×${line.multiplier})` : ""}`);
  }
  if (COVERAGE_LABEL[line.coverage]) parts.push(COVERAGE_LABEL[line.coverage]);
  return (
    <div className="mt-0.5 text-xs text-fg-muted flex flex-wrap gap-x-2">
      <span>{parts.join(" · ")}</span>
      <span className="ml-auto font-medium text-fg tabular-nums">{formatMoney(line.amount_cents, currency)}</span>
    </div>
  );
}

// Customer / contract header for the time log (Admin/Manager, MSP mode).
function BillingSummary({ billing, entries, onCustomer, onApproveAll }) {
  const { customer, candidates, contract, topups, currency, require_approval: requireApproval } = billing;
  const pending = entries.filter((e) => e.billable && !e.approved_at && !e.invoiced_at).length;
  const usage = contract?.block_usage;
  return (
    <div className="px-3 py-2 border-b border-border text-xs space-y-1 bg-surface-2/40">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-fg-muted">Bills to</span>
        {candidates.length > 1 || (customer?.source === "ticket") ? (
          <select
            value={customer?.id || ""}
            onChange={(e) => onCustomer(e.target.value ? Number(e.target.value) : null)}
            className="input py-0.5 w-auto text-xs"
            aria-label="Customer"
          >
            <option value="">{candidates.length > 1 ? "Choose a customer…" : "Project's customer"}</option>
            {candidates.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            {customer && !candidates.some((c) => c.id === customer.id) && <option value={customer.id}>{customer.name}</option>}
          </select>
        ) : (
          <b className="text-fg">{customer?.name || "No customer"}</b>
        )}
        {contract ? (
          <span className="text-fg-muted">
            · {contract.name} ({behaviorLabel(contract.behavior)}{contract.rate_card ? `, ${contract.rate_card}` : ""})
          </span>
        ) : (
          <span className="text-fg-muted">· no contract — hourly at the default rate card</span>
        )}
        {pending > 0 && (
          <button onClick={onApproveAll} className="ml-auto text-brand hover:underline">
            Approve {pending} billable {pending === 1 ? "entry" : "entries"}
          </button>
        )}
      </div>
      {!customer && candidates.length === 0 && (
        <p className="text-fg-dim">This ticket's project isn't linked to a customer (Admin → Companies → customer → Projects).</p>
      )}
      {usage && (
        <p className="text-fg-muted">
          Block {usage.period === "term" ? "for the term" : `for ${usage.period}`}: {fmtMinutes(usage.used_minutes)} of {fmtMinutes(usage.block_minutes)} used
        </p>
      )}
      {requireApproval && pending > 0 && (
        <p className="text-amber-700 dark:text-amber-300">Billable time needs approval before it's exported.</p>
      )}
      {topups.map((t, i) => (
        <div key={i} className="flex flex-wrap gap-x-2 text-fg-muted">
          <span>Ticket minimum top-up{t.key && t.key !== "ticket" ? ` (${t.key})` : ""}: {fmtMinutes(t.billable_minutes)}</span>
          {COVERAGE_LABEL[t.coverage] && <span>· {COVERAGE_LABEL[t.coverage]}</span>}
          <span className="ml-auto font-medium text-fg tabular-nums">{formatMoney(t.amount_cents, currency)}</span>
        </div>
      ))}
    </div>
  );
}

function VisibilityPill({ visibility }) {
  return visibility === "public" ? (
    <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200">
      Public
    </span>
  ) : (
    <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-surface-2 text-fg-muted">
      Private
    </span>
  );
}

export default function TimeTracker({ ticketId, ticket, user, onLogged }) {
  const [settings, setSettings] = useState(null);
  const [timer, setTimer] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(Date.now());
  const [entries, setEntries] = useState([]);
  const [totals, setTotals] = useState(null);
  // Rates / contract / amounts — present only for Admin/Manager in MSP mode.
  const [billing, setBilling] = useState(null);
  const [, setTick] = useState(0);
  const [panel, setPanel] = useState(null); // null | 'log' | 'entries'
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [logInitial, setLogInitial] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [workTypes, setWorkTypes] = useState([]);
  // { overlaps, retry } while asking the tech to confirm an overlap.
  const [overlapAsk, setOverlapAsk] = useState(null);
  const timerRef = useRef(null);
  const autoTried = useRef(false);

  const isPriv = ["Admin", "Manager"].includes(user?.role);

  const applyTimer = useCallback((t) => {
    setTimer(t || null);
    timerRef.current = t || null;
    setFetchedAt(Date.now());
  }, []);

  const load = useCallback(async () => {
    const data = await api.get(`/api/tickets/${ticketId}/time`);
    applyTimer(data.timer);
    setEntries(data.entries || []);
    setTotals(data.totals || null);
    setBilling(data.billing || null);
    return data;
  }, [ticketId, applyTimer]);

  // Settings once, then the ticket's time + an auto-start on open.
  useEffect(() => {
    let cancelled = false;
    autoTried.current = false;
    (async () => {
      try {
        const s = await api.get("/api/time-tracking/settings");
        if (cancelled) return;
        setSettings(s);
        api.get("/api/time-tracking/work-types").then((w) => !cancelled && setWorkTypes(w || [])).catch(() => {});
        if (!s.enabled) return;
        const data = await load();
        if (cancelled || data.timer || autoTried.current) return;
        autoTried.current = true;
        if (s.auto_start_on_open) {
          const r = await api.post(`/api/tickets/${ticketId}/timer/start`, { auto: true, trigger: "open" });
          if (!cancelled && r.started) {
            applyTimer(r.timer);
            announceTimersChanged();
          }
        }
      } catch {
        // Time tracking is supplementary — a failure here never blocks the ticket.
      }
    })();
    return () => { cancelled = true; };
  }, [ticketId, load, applyTimer]);

  // Taking the ticket can auto-start a timer server-side; pick it up.
  useEffect(() => {
    if (!settings?.enabled || ticket?.assigned_to !== user?.id) return;
    load().then(() => announceTimersChanged()).catch(() => {});
  }, [ticket?.assigned_to, user?.id, settings?.enabled, load]);

  // Leaving the ticket (in-app navigation or closing the tab).
  useEffect(() => {
    const onUnload = () => { if (timerRef.current) leaveTicket(ticketId); };
    window.addEventListener("pagehide", onUnload);
    return () => {
      window.removeEventListener("pagehide", onUnload);
      if (!timerRef.current) return;
      leaveTicket(ticketId)
        .then((r) => {
          if (r?.state === "discarded") {
            toast("Timer discarded — no status change and no work logged", { icon: "⏱" });
          }
          announceTimersChanged();
        })
        .catch(() => {});
    };
  }, [ticketId]);

  // Live clock.
  useEffect(() => {
    if (!timer?.running) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [timer?.running]);

  if (!settings?.enabled) return null;

  const seconds = liveSeconds(timer, fetchedAt);
  const warnAt = (settings.warn_after_minutes || 0) * 60;
  const warning = !!timer?.running && warnAt > 0 && seconds >= warnAt;
  const discardHint =
    timer &&
    (settings.discard_untouched === "all" ||
      (settings.discard_untouched === "auto_started" && timer.auto_started));

  async function act(path, label) {
    setBusy(true);
    try {
      const r = await api.post(`/api/tickets/${ticketId}/timer/${path}`, {});
      applyTimer(r.timer ?? null);
      announceTimersChanged();
      return r;
    } catch (e) {
      toast.error(e.message || `Could not ${label} timer`);
    } finally {
      setBusy(false);
    }
  }

  // Opens with stop = now and the timer's time as the duration, so the
  // start is "now minus what was worked" (pauses excluded). With no
  // timer it starts as a 15-minute entry ending now.
  function openLog() {
    const end = new Date();
    const minutes = suggestedMinutes(seconds) || 15;
    setLogInitial({
      start: new Date(end.getTime() - minutes * 60000),
      end,
      minutes,
      note: "",
      visibility: settings.default_visibility || "private",
    });
    setPanel("log");
  }

  // Runs a save; if the server reports an overlap with the tech's other
  // logged time, either explains the block or asks to confirm and retries
  // with confirm_overlap. Returns true once saved.
  async function saveWithOverlapCheck(send, failMsg) {
    setBusy(true);
    try {
      await send(false);
      return true;
    } catch (err) {
      const code = err.body?.code;
      const list = (err.body?.overlaps || [])
        .map((o) => `${o.internal_ref} ${formatTime(o.started_at)}–${formatTime(o.ended_at)}`)
        .join(", ");
      if (code === "overlap_confirm") {
        return new Promise((resolve) => {
          setOverlapAsk({
            list,
            retry: async () => {
              setOverlapAsk(null);
              setBusy(true);
              try { await send(true); resolve(true); }
              catch (e) { toast.error(e.message || failMsg); resolve(false); }
              finally { setBusy(false); }
            },
            cancel: () => { setOverlapAsk(null); resolve(false); },
          });
        });
      }
      toast.error(code === "overlap_blocked" ? `${err.message}: ${list}` : err.message || failMsg);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submitLog(form) {
    const ok = await saveWithOverlapCheck((confirm) => api.post(`/api/tickets/${ticketId}/time`, {
      started_at: form.started_at,
      ended_at: form.ended_at,
      minutes: form.minutes,
      note: form.note,
      visibility: settings.can_choose_visibility ? form.visibility : undefined,
      work_type_id: form.work_type_id,
      from_timer: !!timer,
      confirm_overlap: confirm,
    }), "Could not log time");
    if (!ok) return;
    toast.success(`Logged ${fmtMinutes(form.minutes)}`);
    setPanel(null);
    await load();
    announceTimersChanged();
    onLogged?.();
  }

  async function saveEdit(entryId, form) {
    const ok = await saveWithOverlapCheck((confirm) => api.patch(`/api/tickets/${ticketId}/time/${entryId}`, {
      started_at: form.started_at,
      ended_at: form.ended_at,
      minutes: form.minutes,
      note: form.note,
      work_type_id: form.work_type_id,
      confirm_overlap: confirm,
    }), "Could not save");
    if (!ok) return;
    setEditingId(null);
    await load();
    onLogged?.();
  }

  async function toggleBillable(entry) {
    try {
      await api.patch(`/api/tickets/${ticketId}/time/${entry.id}`, { billable: !entry.billable });
      await load();
    } catch (err) {
      toast.error(err.message || "Could not update");
    }
  }

  async function setApproval(entryIds, approve) {
    try {
      await api.post(`/api/tickets/${ticketId}/time/approval`, { approve, entry_ids: entryIds });
      await load();
    } catch (err) {
      toast.error(err.message || "Could not update approval");
    }
  }

  async function setCustomer(companyId) {
    try {
      const b = await api.put(`/api/tickets/${ticketId}/billing-customer`, { company_id: companyId || null });
      setBilling(b);
    } catch (err) {
      toast.error(err.message || "Could not change the customer");
    }
  }

  async function deleteEntry(entry) {
    if (!window.confirm("Delete this time entry?")) return;
    try {
      const r = await api.delete(`/api/tickets/${ticketId}/time/${entry.id}`);
      if (r.kept_comment) toast("Entry deleted. The public comment stays on the thread.");
      await load();
      onLogged?.();
    } catch (err) {
      toast.error(err.message || "Could not delete");
    }
  }

  const barTone = warning
    ? "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30"
    : timer?.running
      ? "border-emerald-300 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/20"
      : "border-border bg-surface-2/40";

  return (
    <div className="mt-2">
      <div className={`inline-flex flex-wrap items-center gap-2 border rounded-md px-2 py-1 text-xs ${barTone}`}>
        <span className="font-mono tabular-nums text-sm text-fg" aria-label="Elapsed time">
          ⏱ {fmtClock(seconds)}
        </span>
        {timer && !timer.running && <span className="text-fg-muted">{pauseLabel(timer.pause_reason)}</span>}
        {timer?.auto_started && <span className="text-fg-muted">auto-started</span>}

        {!timer && (
          <button disabled={busy} onClick={() => act("start", "start")} className="text-brand hover:underline">
            Start timer
          </button>
        )}
        {timer?.running && (
          <button disabled={busy} onClick={() => act("pause", "pause")} className="text-brand hover:underline">
            Pause
          </button>
        )}
        {timer && !timer.running && (
          <button disabled={busy} onClick={() => act("start", "resume")} className="text-brand hover:underline">
            Resume
          </button>
        )}
        <button disabled={busy} onClick={() => (panel === "log" ? setPanel(null) : openLog())} className="text-brand hover:underline font-medium">
          Log work
        </button>
        {timer && (
          <button disabled={busy} onClick={() => setConfirmDiscard(true)} className="text-fg-muted hover:text-red-600">
            Discard
          </button>
        )}
        {totals?.minutes > 0 && (
          <button onClick={() => setPanel(panel === "entries" ? null : "entries")} className="text-fg-muted hover:text-fg">
            · {fmtMinutes(totals.minutes)} logged
          </button>
        )}
      </div>

      {warning && (
        <p className="mt-1 text-xs text-amber-800 dark:text-amber-200">
          Timer has run {fmtMinutes(seconds / 60)} with no work logged. Log what you did, pause it, or discard it.
        </p>
      )}
      {discardHint && !warning && (
        <p className="mt-1 text-[11px] text-fg-dim">
          Discarded if you leave without changing the status or logging work.
        </p>
      )}

      {panel === "log" && logInitial && (
        <TimeEntryForm
          key={logInitial.end.getTime()}
          initial={logInitial}
          settings={settings}
          workTypes={workTypes}
          busy={busy}
          submitLabel="Log"
          onSubmit={submitLog}
          onCancel={() => setPanel(null)}
        />
      )}

      {panel === "entries" && (
        <div className="mt-2 border border-border rounded-md bg-surface max-w-2xl">
          <div className="px-3 py-2 text-xs text-fg-muted border-b border-border flex flex-wrap gap-3">
            <span><b className="text-fg">{fmtMinutes(totals?.minutes)}</b> total</span>
            <span>{fmtMinutes(totals?.private_minutes)} private</span>
            <span>{fmtMinutes(totals?.public_minutes)} public</span>
            {billing && (
              <span title="After the billing rules, rate card and contract">
                <b className="text-fg">{fmtMinutes(billing.totals.billable_minutes)}</b> billable
                {billing.totals.topup_minutes > 0 && ` (incl. +${fmtMinutes(billing.totals.topup_minutes)} ticket minimum)`}
                {billing.totals.covered_minutes > 0 && ` · ${fmtMinutes(billing.totals.covered_minutes)} covered`}
                {" · "}<b className="text-fg">{formatMoney(billing.totals.amount_cents, billing.currency)}</b>
              </span>
            )}
          </div>
          {billing && (
            <BillingSummary
              billing={billing}
              entries={entries}
              onCustomer={setCustomer}
              onApproveAll={() => setApproval(undefined, true)}
            />
          )}
          <ul className="divide-y divide-border">
            {entries.map((e) => {
              const mine = e.user_id === user?.id;
              const canEdit = (mine || isPriv) && !e.locked;
              const canDelete = (mine || user?.role === "Admin") && !e.locked;
              return (
                <li key={e.id} className="px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                    <span className="font-medium text-fg">{fmtMinutes(e.duration_minutes)}</span>
                    <span>{e.user_name || e.user_email || "Unknown"}</span>
                    {e.started_at && e.ended_at ? (
                      <span title={`Logged ${new Date(e.created_at).toLocaleString()}`}>
                        {formatShortDate(e.started_at)}, {formatTime(e.started_at)} – {formatTime(e.ended_at)}
                      </span>
                    ) : (
                      <HybridTime value={e.created_at} />
                    )}
                    <VisibilityPill visibility={e.visibility} />
                    {e.work_type_name && <span className="px-1.5 py-0.5 rounded bg-surface-2">{e.work_type_name}</span>}
                    {e.edited_at && <span>(edited)</span>}
                    {e.locked && !e.invoiced_at && (
                      <span title={e.approved_at ? "Approved — an Admin or Manager can change it" : "Older than the timesheet lock — an Admin or Manager can change it"}>🔒</span>
                    )}
                    {billing && e.approved_at && (
                      <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">Approved</span>
                    )}
                    {billing && (
                      <span className="inline-flex items-center gap-2 ml-auto">
                        <label className="inline-flex items-center gap-1" title="Billable is separate from visibility. Only billable entries should ever reach an invoice.">
                          <input type="checkbox" checked={!!e.billable} onChange={() => toggleBillable(e)} disabled={!!e.invoiced_at} />
                          billable
                        </label>
                        {e.billable && !e.invoiced_at && (
                          <button onClick={() => setApproval([e.id], !e.approved_at)} className="text-brand hover:underline">
                            {e.approved_at ? "unapprove" : "approve"}
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                  {billing && e.billable && <PriceLine line={billing.lines[e.id]} currency={billing.currency} logged={e.duration_minutes} />}
                  {editingId === e.id ? (
                    <TimeEntryForm
                      initial={{
                        end: new Date(e.ended_at || e.created_at),
                        start: e.started_at
                          ? new Date(e.started_at)
                          : new Date(new Date(e.ended_at || e.created_at).getTime() - e.duration_minutes * 60000),
                        minutes: e.duration_minutes,
                        note: e.note || "",
                        visibility: e.visibility,
                        work_type_id: e.work_type_id,
                        work_type_name: e.work_type_name,
                      }}
                      settings={settings}
                      workTypes={workTypes}
                      showVisibility={false}
                      busy={busy}
                      submitLabel="Save"
                      onSubmit={(form) => saveEdit(e.id, form)}
                      onCancel={() => setEditingId(null)}
                    />
                  ) : (
                    <>
                      <p className="mt-0.5 whitespace-pre-wrap text-fg">{e.note}</p>
                      {(canEdit || canDelete) && (
                        <div className="mt-0.5 flex gap-3 text-xs">
                          {canEdit && (
                            <button onClick={() => setEditingId(e.id)} className="text-brand hover:underline">
                              edit
                            </button>
                          )}
                          {canDelete && (
                            <button onClick={() => deleteEntry(e)} className="text-fg-muted hover:text-red-600">delete</button>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <ConfirmDialog
        open={!!overlapAsk}
        title="Overlapping time"
        message={`This overlaps time you already logged (${overlapAsk?.list || ""}). Save it anyway?`}
        confirmLabel="Save anyway"
        onCancel={() => overlapAsk?.cancel()}
        onConfirm={() => overlapAsk?.retry()}
      />
      <ConfirmDialog
        open={confirmDiscard}
        title="Discard timer?"
        message={`${fmtClock(seconds)} on the clock will be thrown away. Nothing is logged.`}
        confirmLabel="Discard"
        danger
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={async () => {
          setConfirmDiscard(false);
          await act("discard", "discard");
        }}
      />
    </div>
  );
}

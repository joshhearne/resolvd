import { useCallback, useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import HybridTime from "./HybridTime";
import ConfirmDialog from "./ConfirmDialog";

// Technician time tracking on a ticket. Handler-only: the parent renders
// it once the notes gate has confirmed access.
//
// Timer bar: live clock, start / pause / resume, log work, discard.
// Log panel: duration + a required note describing the work. Notes are
// private (handler-only) by default; whether a tech can make one public
// is the admin's call (Admin → Time tracking). Public is NOT billable —
// billable is a separate Admin/Manager flag on the entry.
//
// Leaving the ticket tells the server, which throws away an untouched
// auto-started timer (status unchanged, nothing logged) when the admin
// has that rule on. Otherwise the clock keeps running — techs often step
// away from the page to do the work — and the header pill shows it.

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

function DurationInputs({ minutes, onChange }) {
  const h = Math.floor((Number(minutes) || 0) / 60);
  const m = (Number(minutes) || 0) % 60;
  const set = (nh, nm) => onChange(Math.max(0, (Number(nh) || 0) * 60 + (Number(nm) || 0)));
  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="number" min="0" max="24" value={h}
        onChange={(e) => set(e.target.value, m)}
        className="input w-16 py-1"
        aria-label="Hours"
      />
      <span className="text-xs text-fg-muted">h</span>
      <input
        type="number" min="0" max="59" value={m}
        onChange={(e) => set(h, e.target.value)}
        className="input w-16 py-1"
        aria-label="Minutes"
      />
      <span className="text-xs text-fg-muted">m</span>
    </span>
  );
}

export default function TimeTracker({ ticketId, ticket, user, onLogged }) {
  const [settings, setSettings] = useState(null);
  const [timer, setTimer] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(Date.now());
  const [entries, setEntries] = useState([]);
  const [totals, setTotals] = useState(null);
  const [, setTick] = useState(0);
  const [panel, setPanel] = useState(null); // null | 'log' | 'entries'
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [draft, setDraft] = useState({ minutes: 0, note: "", visibility: "private" });
  const [editing, setEditing] = useState(null); // { id, minutes, note }
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

  function openLog() {
    setDraft({
      minutes: suggestedMinutes(seconds) || 15,
      note: "",
      visibility: settings.default_visibility || "private",
    });
    setPanel("log");
  }

  async function submitLog(e) {
    e.preventDefault();
    const note = draft.note.trim();
    if (note.length < settings.min_note_chars) {
      toast.error(`Describe the work done (at least ${settings.min_note_chars} characters)`);
      return;
    }
    if (!draft.minutes) {
      toast.error("Enter the time spent");
      return;
    }
    setBusy(true);
    try {
      await api.post(`/api/tickets/${ticketId}/time`, {
        minutes: draft.minutes,
        note,
        visibility: settings.can_choose_visibility ? draft.visibility : undefined,
        from_timer: !!timer,
      });
      toast.success(`Logged ${fmtMinutes(draft.minutes)}`);
      setPanel(null);
      await load();
      announceTimersChanged();
      onLogged?.();
    } catch (err) {
      toast.error(err.message || "Could not log time");
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    try {
      await api.patch(`/api/tickets/${ticketId}/time/${editing.id}`, {
        minutes: editing.minutes,
        note: editing.note,
      });
      setEditing(null);
      await load();
      onLogged?.();
    } catch (err) {
      toast.error(err.message || "Could not save");
    }
  }

  async function toggleBillable(entry) {
    try {
      await api.patch(`/api/tickets/${ticketId}/time/${entry.id}`, { billable: !entry.billable });
      await load();
    } catch (err) {
      toast.error(err.message || "Could not update");
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
        {timer && !timer.running && <span className="text-fg-muted">paused</span>}
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

      {panel === "log" && (
        <form onSubmit={submitLog} className="mt-2 border border-border rounded-md p-3 bg-surface space-y-2 max-w-xl">
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-xs text-fg-muted">Time spent</label>
            <DurationInputs minutes={draft.minutes} onChange={(minutes) => setDraft((d) => ({ ...d, minutes }))} />
          </div>
          <textarea
            value={draft.note}
            onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
            rows={3}
            placeholder="What did you do? (required)"
            className="input w-full text-sm"
            autoFocus
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            {settings.can_choose_visibility ? (
              <div className="flex items-center gap-3 text-xs">
                <label className="inline-flex items-center gap-1">
                  <input
                    type="radio" name="tt-vis" checked={draft.visibility === "private"}
                    onChange={() => setDraft((d) => ({ ...d, visibility: "private" }))}
                  />
                  Private note (handlers only)
                </label>
                <label className="inline-flex items-center gap-1">
                  <input
                    type="radio" name="tt-vis" checked={draft.visibility === "public"}
                    onChange={() => setDraft((d) => ({ ...d, visibility: "public" }))}
                  />
                  Public comment
                </label>
              </div>
            ) : (
              <span className="text-xs text-fg-muted">
                Saved as a {settings.default_visibility === "public" ? "public comment" : "private note (handlers only)"}
              </span>
            )}
            <div className="flex gap-2">
              <button type="button" onClick={() => setPanel(null)} className="btn btn-sm btn-secondary">Cancel</button>
              <button type="submit" disabled={busy} className="btn btn-sm btn-primary">
                Log {draft.minutes ? fmtMinutes(draft.minutes) : "time"}
              </button>
            </div>
          </div>
        </form>
      )}

      {panel === "entries" && (
        <div className="mt-2 border border-border rounded-md bg-surface max-w-2xl">
          <div className="px-3 py-2 text-xs text-fg-muted border-b border-border flex flex-wrap gap-3">
            <span><b className="text-fg">{fmtMinutes(totals?.minutes)}</b> total</span>
            <span>{fmtMinutes(totals?.private_minutes)} private</span>
            <span>{fmtMinutes(totals?.public_minutes)} public</span>
            {isPriv && <span>{fmtMinutes(totals?.billable_minutes)} billable</span>}
          </div>
          <ul className="divide-y divide-border">
            {entries.map((e) => {
              const mine = e.user_id === user?.id;
              const canEdit = (mine || isPriv) && !e.invoiced_at;
              const canDelete = (mine || user?.role === "Admin") && !e.invoiced_at;
              return (
                <li key={e.id} className="px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                    <span className="font-medium text-fg">{fmtMinutes(e.duration_minutes)}</span>
                    <span>{e.user_name || e.user_email || "Unknown"}</span>
                    <HybridTime value={e.created_at} />
                    <VisibilityPill visibility={e.visibility} />
                    {e.edited_at && <span>(edited)</span>}
                    {isPriv && (
                      <label className="inline-flex items-center gap-1 ml-auto" title="Billable is separate from visibility. Only billable entries should ever reach an invoice.">
                        <input type="checkbox" checked={!!e.billable} onChange={() => toggleBillable(e)} disabled={!!e.invoiced_at} />
                        billable
                      </label>
                    )}
                  </div>
                  {editing?.id === e.id ? (
                    <div className="mt-1 space-y-2">
                      <DurationInputs minutes={editing.minutes} onChange={(minutes) => setEditing((d) => ({ ...d, minutes }))} />
                      <textarea
                        value={editing.note}
                        onChange={(ev) => setEditing((d) => ({ ...d, note: ev.target.value }))}
                        rows={2}
                        className="input w-full text-sm"
                      />
                      <div className="flex gap-2">
                        <button onClick={saveEdit} className="btn btn-sm btn-primary">Save</button>
                        <button onClick={() => setEditing(null)} className="btn btn-sm btn-secondary">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="mt-0.5 whitespace-pre-wrap text-fg">{e.note}</p>
                      {(canEdit || canDelete) && (
                        <div className="mt-0.5 flex gap-3 text-xs">
                          {canEdit && (
                            <button onClick={() => setEditing({ id: e.id, minutes: e.duration_minutes, note: e.note || "" })} className="text-brand hover:underline">
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

import React, { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import { useAuth } from "../context/AuthContext";
import { useBranding } from "../context/BrandingContext";
import { formatMoney } from "../components/BillingAdmin";
import { PriceLine } from "../components/TimeTracker";
import { formatTime, toDateInput } from "../utils/timeEntry";

// Time — a tech's own timesheet, plus (Admin/Manager, MSP mode) one
// approval queue for billable time across every ticket.

const PRIV = ["Admin", "Manager"];

function fmtMinutes(m) {
  const t = Math.max(0, Math.round(Number(m) || 0));
  const h = Math.floor(t / 60);
  const r = t % 60;
  return h ? `${h}h ${String(r).padStart(2, "0")}m` : `${r}m`;
}

// Monday 00:00 local of the week holding `d`.
function weekStart(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

// "2026-10-20" → local midnight of that day.
function fromDateInput(s) {
  const [y, m, d] = String(s).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function dayLabel(d) {
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function ticketLabel(e) {
  return `${e.internal_ref || `#${e.ticket_id}`}${e.title ? ` — ${e.title}` : ""}`;
}

function Pill({ tone, children, title }) {
  const tones = {
    green: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    amber: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    dim: "bg-surface-2 text-fg-muted",
  };
  return (
    <span title={title} className={`text-[10px] uppercase px-1.5 py-0.5 rounded whitespace-nowrap ${tones[tone] || tones.dim}`}>
      {children}
    </span>
  );
}

const inputCls = "bg-surface-2 border border-border rounded px-2 py-1 text-sm";

export default function Time() {
  const { user } = useAuth();
  const { branding } = useBranding();
  const [params, setParams] = useSearchParams();
  const canApprove = PRIV.includes(user?.role) && branding?.enable_customer_companies === true;
  const tab = canApprove && params.get("tab") === "approvals" ? "approvals" : "timesheet";

  function setTab(t) {
    const next = new URLSearchParams(params);
    if (t === "timesheet") next.delete("tab"); else next.set("tab", t);
    setParams(next, { replace: true });
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold text-fg">Time</h1>
      </div>
      {canApprove && (
        <div className="flex gap-1 border-b border-border text-sm">
          {[["timesheet", "Timesheet"], ["approvals", "Approvals"]].map(([k, label]) => (
            <button key={k} type="button" onClick={() => setTab(k)}
              className={`px-3 py-2 -mb-px border-b-2 ${tab === k ? "border-brand text-fg font-medium" : "border-transparent text-fg-muted hover:text-fg"}`}>
              {label}
            </button>
          ))}
        </div>
      )}
      {tab === "approvals" ? <Approvals /> : <Timesheet />}
    </div>
  );
}

function useTechs(enabled) {
  const [techs, setTechs] = useState([]);
  useEffect(() => {
    if (!enabled) return;
    api.get("/api/users")
      .then((us) => setTechs((us || []).filter((u) => ["Admin", "Manager", "Tech"].includes(u.role) && u.status !== "inactive")))
      .catch(() => {});
  }, [enabled]);
  return techs;
}

// --- Timesheet --------------------------------------------------------------

function Timesheet() {
  const { user } = useAuth();
  const priv = PRIV.includes(user?.role);
  const techs = useTechs(priv);
  const [start, setStart] = useState(() => weekStart(new Date()));
  const [userId, setUserId] = useState("");
  const [data, setData] = useState(null);

  useEffect(() => {
    let live = true;
    setData(null);
    const qs = new URLSearchParams({ from: start.toISOString(), to: addDays(start, 7).toISOString() });
    if (userId) qs.set("user_id", userId);
    api.get(`/api/time-tracking/timesheet?${qs}`)
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) { toast.error(e.message); setData({ entries: [] }); } });
    return () => { live = false; };
  }, [start, userId]);

  // Seven day buckets, keyed by local date of the entry's start.
  const days = useMemo(() => {
    const out = Array.from({ length: 7 }, (_, i) => ({ date: addDays(start, i), entries: [], minutes: 0, billable: 0 }));
    for (const e of data?.entries || []) {
      // Bucket by the local day the entry started; one that started
      // before Monday but ended inside the week lands on Monday.
      const sd = new Date(e.started_at);
      sd.setHours(0, 0, 0, 0);
      const i = Math.min(6, Math.max(0, Math.round((sd - start) / 86400000)));
      out[i].entries.push(e);
      out[i].minutes += e.duration_minutes;
      if (e.billable) out[i].billable += e.duration_minutes;
    }
    for (const d of out) d.entries.sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
    return out;
  }, [data, start]);

  const total = days.reduce((a, d) => a + d.minutes, 0);
  const billable = days.reduce((a, d) => a + d.billable, 0);
  const thisWeek = start.getTime() === weekStart(new Date()).getTime();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1">
          <button type="button" className="btn btn-sm" onClick={() => setStart(addDays(start, -7))} aria-label="Previous week">‹</button>
          <input type="date" value={toDateInput(start)} className={inputCls}
            onChange={(e) => e.target.value && setStart(weekStart(fromDateInput(e.target.value)))} />
          <button type="button" className="btn btn-sm" onClick={() => setStart(addDays(start, 7))} aria-label="Next week">›</button>
          {!thisWeek && (
            <button type="button" className="btn btn-sm" onClick={() => setStart(weekStart(new Date()))}>This week</button>
          )}
        </div>
        {priv && (
          <select value={userId} onChange={(e) => setUserId(e.target.value)} className={inputCls}>
            <option value="">Me</option>
            {techs.filter((t) => t.id !== user?.id).map((t) => (
              <option key={t.id} value={t.id}>{t.display_name || t.email}</option>
            ))}
          </select>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-w-xl">
        <Stat label={`Week of ${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`} value={fmtMinutes(total)} />
        <Stat label="Billable" value={fmtMinutes(billable)} />
        <Stat label="Entries" value={data ? data.entries.length : "…"} className="hidden sm:block" />
      </div>

      {!data ? (
        <p className="text-sm text-fg-muted">Loading…</p>
      ) : (
        <div className="space-y-3">
          {days.map((d) => (
            <div key={d.date.toISOString()} className="bg-surface border border-border rounded-lg">
              <div className="flex items-center justify-between px-3 py-2 border-b border-border text-sm">
                <span className="font-medium text-fg">{dayLabel(d.date)}</span>
                <span className="text-fg-muted tabular-nums">
                  {d.minutes ? <>{fmtMinutes(d.minutes)}{d.billable !== d.minutes && <> · {fmtMinutes(d.billable)} billable</>}</> : "—"}
                </span>
              </div>
              {d.entries.length > 0 && (
                <ul className="divide-y divide-border">
                  {d.entries.map((e) => (
                    <li key={e.id} className="px-3 py-2 text-sm flex gap-3">
                      <div className="w-16 shrink-0 text-fg-muted tabular-nums text-xs pt-0.5 whitespace-nowrap">
                        <div>{formatTime(new Date(e.started_at))}</div>
                        <div>{formatTime(new Date(e.ended_at))}</div>
                      </div>
                      <div className="min-w-0 flex-1">
                        <Link to={`/tickets/${e.ticket_id}`} className="text-brand hover:underline truncate block">
                          {ticketLabel(e)}
                        </Link>
                        {e.note && <p className="text-fg-muted text-xs mt-0.5 whitespace-pre-wrap break-words">{e.note}</p>}
                        <div className="flex gap-1 mt-1 flex-wrap">
                          {e.work_type_name && <Pill>{e.work_type_name}</Pill>}
                          {!e.billable && <Pill>Non-billable</Pill>}
                          {e.billable && (e.invoiced_at
                            ? <Pill tone="green">Invoiced</Pill>
                            : e.approved_at ? <Pill tone="green">Approved</Pill> : <Pill tone="amber">Pending</Pill>)}
                          {e.visibility === "public" && <Pill title="Visible to the requester">Public</Pill>}
                        </div>
                      </div>
                      <div className="shrink-0 tabular-nums text-fg">{fmtMinutes(e.duration_minutes)}</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, className = "" }) {
  return (
    <div className={`bg-surface border border-border rounded-lg px-3 py-2 ${className}`}>
      <div className="text-[11px] uppercase tracking-wide text-fg-muted truncate">{label}</div>
      <div className="text-lg font-semibold text-fg tabular-nums">{value}</div>
    </div>
  );
}

// --- Approvals --------------------------------------------------------------

function Approvals() {
  const techs = useTechs(true);
  const [companies, setCompanies] = useState([]);
  const [from, setFrom] = useState(() => toDateInput(addDays(new Date(), -30)));
  const [to, setTo] = useState(() => toDateInput(new Date()));
  const [status, setStatus] = useState("pending");
  const [userId, setUserId] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    api.get("/api/companies?kind=customer").then(setCompanies).catch(() => {});
  }, []);

  useEffect(() => {
    let live = true;
    setData(null);
    setSelected(new Set());
    const qs = new URLSearchParams({
      from: fromDateInput(from).toISOString(),
      to: addDays(fromDateInput(to), 1).toISOString(),
      status,
    });
    if (userId) qs.set("user_id", userId);
    if (companyId) qs.set("company_id", companyId);
    api.get(`/api/billing/approvals?${qs}`)
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) { toast.error(e.message); setData({ entries: [] }); } });
    return () => { live = false; };
  }, [from, to, status, userId, companyId, nonce]);

  const entries = data?.entries || [];
  const currency = data?.currency || "USD";
  const allOn = entries.length > 0 && entries.every((e) => selected.has(e.id));
  const picked = entries.filter((e) => selected.has(e.id));
  const sum = (list) => list.reduce((a, e) => ({
    minutes: a.minutes + e.duration_minutes,
    cents: a.cents + (e.line?.amount_cents || 0),
  }), { minutes: 0, cents: 0 });
  const totals = sum(entries);
  const pickedTotals = sum(picked);

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function apply() {
    if (!picked.length) return;
    setBusy(true);
    try {
      const approve = status === "pending";
      const r = await api.post("/api/billing/approvals", { entry_ids: picked.map((e) => e.id), approve });
      toast.success(`${approve ? "Approved" : "Un-approved"} ${r.updated} ${r.updated === 1 ? "entry" : "entries"}`);
      setNonce((n) => n + 1);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-2 flex-wrap text-xs text-fg-muted">
        <label className="flex flex-col gap-1">From
          <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1">To
          <input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1">Status
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputCls}>
            <option value="pending">Waiting for approval</option>
            <option value="approved">Approved, not invoiced</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">Tech
          <select value={userId} onChange={(e) => setUserId(e.target.value)} className={inputCls}>
            <option value="">Everyone</option>
            {techs.map((t) => <option key={t.id} value={t.id}>{t.display_name || t.email}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">Customer
          <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className={inputCls}>
            <option value="">All customers</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      </div>

      {!data ? (
        <p className="text-sm text-fg-muted">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-fg-muted">
          {status === "pending" ? "Nothing waiting for approval in this range." : "No approved, uninvoiced time in this range."}
        </p>
      ) : (
        <>
          <div className="flex items-center gap-3 flex-wrap text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={allOn}
                onChange={() => setSelected(allOn ? new Set() : new Set(entries.map((e) => e.id)))} />
              Select all
            </label>
            <span className="text-fg-muted">
              {entries.length} {entries.length === 1 ? "entry" : "entries"} · {fmtMinutes(totals.minutes)} · {formatMoney(totals.cents, currency)}
              {data.truncated && " (first 500 — narrow the range)"}
            </span>
            <button type="button" disabled={!picked.length || busy} onClick={apply}
              className={`btn btn-sm ml-auto ${status === "pending" ? "btn-primary" : ""}`}>
              {status === "pending" ? "Approve" : "Un-approve"}
              {picked.length > 0 && ` ${picked.length} · ${formatMoney(pickedTotals.cents, currency)}`}
            </button>
          </div>

          <ul className="bg-surface border border-border rounded-lg divide-y divide-border">
            {entries.map((e) => (
              <li key={e.id} className="px-3 py-2 text-sm flex gap-3 items-start">
                <input type="checkbox" className="mt-1" checked={selected.has(e.id)} onChange={() => toggle(e.id)}
                  aria-label={`Select entry ${e.id}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <Link to={`/tickets/${e.ticket_id}`} className="text-brand hover:underline truncate max-w-full">
                      {ticketLabel(e)}
                    </Link>
                  </div>
                  <div className="text-xs text-fg-muted mt-0.5">
                    {e.customer_name || "No customer"} · {e.user_name || e.user_email || "Unknown"} · {dayLabel(new Date(e.started_at))}{" "}
                    {formatTime(new Date(e.started_at))}–{formatTime(new Date(e.ended_at))}
                  </div>
                  {e.note && <p className="text-xs text-fg mt-1 whitespace-pre-wrap break-words">{e.note}</p>}
                  <div className="flex gap-1 mt-1 flex-wrap">
                    {e.work_type_name && <Pill>{e.work_type_name}</Pill>}
                    {e.line?.contract_name && <Pill title={e.line.billing_type || undefined}>{e.line.contract_name}</Pill>}
                  </div>
                  <PriceLine line={e.line} currency={currency} logged={e.duration_minutes} />
                </div>
                <div className="shrink-0 tabular-nums text-fg">{fmtMinutes(e.duration_minutes)}</div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

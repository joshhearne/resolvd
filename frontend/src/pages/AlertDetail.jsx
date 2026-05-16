import React, { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { api } from "../utils/api";
import toast from "react-hot-toast";

const STATE_BADGE = {
  firing: "bg-red-100 text-red-700 border-red-300 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800",
  recovered: "bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800",
  suppressed: "bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-900/40 dark:text-slate-300 dark:border-slate-700",
};
// DB stores 'firing'; operators say "problem". Label-only rename.
const STATE_LABEL = { firing: "Problem", recovered: "Recovered", suppressed: "Suppressed" };

function Field({ label, value, mono, full }) {
  if (value == null || value === "") return null;
  return (
    <div className={full ? "sm:col-span-2" : ""}>
      <div className="text-[11px] text-fg-muted uppercase tracking-wide">{label}</div>
      <div className={`text-sm text-fg break-words ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}

function Json({ value }) {
  let pretty;
  try { pretty = JSON.stringify(value, null, 2); }
  catch { pretty = String(value); }
  return (
    <pre className="text-[11px] bg-surface-2 border border-border rounded p-3 overflow-auto max-h-[60vh] whitespace-pre-wrap break-words">
      {pretty}
    </pre>
  );
}

export default function AlertDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isHandler = ["Admin", "Manager", "Tech"].includes(user?.role);
  const [alert, setAlert] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);

  async function load() {
    setLoading(true);
    try { setAlert(await api.get(`/api/alerts/${id}`)); }
    catch (e) { toast.error(e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  async function promote() {
    setBusy("promote");
    try {
      const r = await api.post(`/api/alerts/${alert.id}/promote`, {});
      toast.success(r.alreadyLinked ? "Already linked" : "Ticket created");
      await load();
      if (r.ticket_id) navigate(`/tickets/${r.ticket_id}`);
    } catch (e) { toast.error(e.message); }
    finally { setBusy(null); }
  }
  async function suppress() {
    if (!window.confirm("Suppress this alert without creating a ticket?")) return;
    setBusy("suppress");
    try {
      await api.post(`/api/alerts/${alert.id}/suppress`, { reason: "manual" });
      toast.success("Alert suppressed");
      await load();
    } catch (e) { toast.error(e.message); }
    finally { setBusy(null); }
  }

  if (!isHandler) {
    return (
      <div className="p-6 text-sm text-fg-muted">
        Alerts are visible only to handler roles (Admin / Manager / Tech).
      </div>
    );
  }
  if (loading) return <div className="p-6 text-sm text-fg-muted">Loading…</div>;
  if (!alert) return <div className="p-6 text-sm text-fg-muted">Alert not found.</div>;

  return (
    <div className="space-y-5 p-4 md:p-6 max-w-5xl">
      <nav className="text-xs text-fg-dim">
        <Link to="/alerts" className="hover:text-brand">Alerts</Link>
        <span className="mx-1.5">›</span>
        <span className="font-mono text-fg">#{alert.id}</span>
      </nav>

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded border ${STATE_BADGE[alert.state] || ""}`}>
              {STATE_LABEL[alert.state] || alert.state}
            </span>
            {alert.severity && (
              <span className="text-[10px] uppercase font-medium text-fg-muted bg-surface-2 border border-border rounded px-1.5 py-0.5">
                {alert.severity}
                {Number.isFinite(alert.severity_rank) && ` (rank ${alert.severity_rank})`}
              </span>
            )}
            <span className="text-xs text-fg-muted">
              from <strong>{alert.source_name}</strong> · {alert.source_preset}
            </span>
          </div>
          <h1 className="text-xl font-semibold text-fg mt-2">
            {alert.title || <span className="text-fg-dim italic">no title</span>}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {!alert.ticket_id && alert.state === "firing" && (
            <>
              <button onClick={promote} disabled={busy === "promote"}
                className="text-sm px-3 py-1 rounded bg-brand text-white hover:opacity-90 disabled:opacity-50">
                {busy === "promote" ? "…" : "Create ticket"}
              </button>
              <button onClick={suppress} disabled={busy === "suppress"}
                className="text-sm text-fg-muted hover:text-fg disabled:opacity-50">
                Suppress
              </button>
            </>
          )}
          {alert.ticket_id && (
            <Link to={`/tickets/${alert.ticket_id}`}
              className="text-sm px-3 py-1 rounded border border-border hover:bg-surface-2">
              View ticket {alert.ticket_ref}
            </Link>
          )}
        </div>
      </div>

      <div className="bg-surface border border-border rounded-lg p-4 space-y-3">
        <div className="text-sm font-medium text-fg">Identification</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Alert ID" value={alert.id} mono />
          <Field label="External ref" value={alert.external_ref} mono />
          <Field label="External event ID" value={alert.external_event_id} mono />
          <Field label="Source" value={`${alert.source_name} (id ${alert.source_id})`} />
          <Field label="Source preset" value={alert.source_preset} />
          <Field label="Vendor ref" value={alert.vendor_ref} mono />
        </div>
      </div>

      <div className="bg-surface border border-border rounded-lg p-4 space-y-3">
        <div className="text-sm font-medium text-fg">Alert content</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Title" value={alert.title} full />
          <Field label="Description" value={alert.description ? (
            <span className="whitespace-pre-wrap">{alert.description}</span>
          ) : null} full />
          <Field label="Severity" value={alert.severity} />
          <Field label="Severity rank" value={alert.severity_rank} mono />
          <Field label="User email" value={alert.user_email} mono />
        </div>
      </div>

      <div className="bg-surface border border-border rounded-lg p-4 space-y-3">
        <div className="text-sm font-medium text-fg">Lifecycle</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="State" value={STATE_LABEL[alert.state] || alert.state} />
          <Field label="Refire count" value={alert.refire_count} mono />
          <Field label="First seen" value={new Date(alert.first_seen_at).toLocaleString()} />
          <Field label="Last seen" value={new Date(alert.last_seen_at).toLocaleString()} />
          {alert.recovered_at && (
            <Field label="Recovered at" value={new Date(alert.recovered_at).toLocaleString()} />
          )}
          {alert.evaluated_at && (
            <Field label="Rules last evaluated" value={new Date(alert.evaluated_at).toLocaleString()} />
          )}
          {alert.next_evaluation_at && (
            <Field label="Next re-evaluation" value={new Date(alert.next_evaluation_at).toLocaleString()} />
          )}
          {alert.suppression_reason && (
            <Field label="Suppression reason" value={alert.suppression_reason} full />
          )}
        </div>
      </div>

      {(alert.ticket_id || alert.promoted_at) && (
        <div className="bg-surface border border-border rounded-lg p-4 space-y-3">
          <div className="text-sm font-medium text-fg">Ticket linkage</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Ticket" value={alert.ticket_id ? (
              <Link to={`/tickets/${alert.ticket_id}`} className="text-brand hover:underline font-mono">
                {alert.ticket_ref}
              </Link>
            ) : null} />
            <Field label="Ticket status" value={alert.ticket_status} />
            <Field label="Promoted at" value={alert.promoted_at ? new Date(alert.promoted_at).toLocaleString() : null} />
            <Field label="Promoted by rule" value={alert.promoted_by_rule_id} mono />
            <Field label="Promoted by user" value={alert.promoted_by_user_id} mono />
          </div>
        </div>
      )}

      <div className="bg-surface border border-border rounded-lg p-4 space-y-2">
        <div className="text-sm font-medium text-fg">Raw payload</div>
        <p className="text-xs text-fg-muted">Exactly what the source sent. Useful for tuning rules or filing bugs against a mapper.</p>
        <Json value={alert.raw_payload || {}} />
      </div>
    </div>
  );
}

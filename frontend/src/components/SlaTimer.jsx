import { useEffect, useState } from "react";

// Small live-updating badge pair for a ticket's SLA state.
//
// Shows up to two pills:
//   • Response  — until sla_first_response_at is set
//   • Resolve   — until resolved_at is set
// Each pill shows time-until-due (or "breached" / "due in <Nm>" /
// "responded" / "resolved"). Re-renders every minute so the countdown
// stays fresh without a server poll.
//
// Pause state surfaces as a grey "Paused" pill — the clock isn't moving.

function fmtDelta(ms) {
  const abs = Math.abs(ms);
  const m = Math.round(abs / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function pillClass(state) {
  switch (state) {
    case "breached":  return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200";
    case "at_risk":   return "bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200";
    case "ok":        return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200";
    case "done":      return "bg-surface-2 text-fg-muted line-through";
    case "paused":    return "bg-surface-2 text-fg-muted";
    default:          return "bg-surface-2 text-fg-muted";
  }
}

export default function SlaTimer({ ticket }) {
  // Force re-render every 60s for live countdown
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  if (!ticket) return null;
  const responseDue = ticket.sla_response_due_at ? new Date(ticket.sla_response_due_at) : null;
  const resolveDue  = ticket.sla_resolve_due_at  ? new Date(ticket.sla_resolve_due_at)  : null;
  if (!responseDue && !resolveDue) return null;

  const paused = !!ticket.sla_paused_at;
  const now = Date.now();

  // Response pill
  let responseEl = null;
  if (responseDue) {
    if (ticket.sla_first_response_at) {
      responseEl = { state: "done", label: "Response: replied" };
    } else if (paused) {
      responseEl = { state: "paused", label: "Response: paused" };
    } else if (ticket.sla_response_breached || responseDue.getTime() <= now) {
      responseEl = { state: "breached", label: `Response breached (${fmtDelta(now - responseDue.getTime())} ago)` };
    } else {
      const diff = responseDue.getTime() - now;
      const atRisk = diff < 60 * 60 * 1000;
      responseEl = { state: atRisk ? "at_risk" : "ok", label: `Response in ${fmtDelta(diff)}` };
    }
  }

  // Resolve pill
  let resolveEl = null;
  if (resolveDue) {
    if (ticket.resolved_at) {
      resolveEl = { state: "done", label: "Resolve: closed" };
    } else if (paused) {
      resolveEl = { state: "paused", label: "Resolve: paused" };
    } else if (ticket.sla_resolve_breached || resolveDue.getTime() <= now) {
      resolveEl = { state: "breached", label: `Resolve breached (${fmtDelta(now - resolveDue.getTime())} ago)` };
    } else {
      const diff = resolveDue.getTime() - now;
      const atRisk = diff < 4 * 60 * 60 * 1000;
      resolveEl = { state: atRisk ? "at_risk" : "ok", label: `Resolve in ${fmtDelta(diff)}` };
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {responseEl && (
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${pillClass(responseEl.state)}`}
          title={responseDue ? `Due ${responseDue.toLocaleString()}` : ""}
        >
          {responseEl.label}
        </span>
      )}
      {resolveEl && (
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${pillClass(resolveEl.state)}`}
          title={resolveDue ? `Due ${resolveDue.toLocaleString()}` : ""}
        >
          {resolveEl.label}
        </span>
      )}
    </span>
  );
}

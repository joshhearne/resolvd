import React from "react";

// Display helpers for monitored-item state, shared by status pages,
// maintenance and the alert-source admin.

export const ITEM_STATE = {
  up: { label: "Operational", dot: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-300" },
  down: { label: "Down", dot: "bg-red-500", text: "text-red-700 dark:text-red-300" },
  partial: { label: "Partial outage", dot: "bg-orange-500", text: "text-orange-700 dark:text-orange-300" },
  pending: { label: "Degraded", dot: "bg-amber-500", text: "text-amber-700 dark:text-amber-300" },
  maintenance: { label: "Maintenance", dot: "bg-sky-500", text: "text-sky-700 dark:text-sky-300" },
  unknown: { label: "No data", dot: "bg-slate-400", text: "text-fg-muted" },
};

export function stateInfo(state) {
  return ITEM_STATE[state] || ITEM_STATE.unknown;
}

export function StateDot({ state, className = "" }) {
  return <span className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${stateInfo(state).dot} ${className}`} aria-hidden="true" />;
}

export function fmtUptime(ratio) {
  if (ratio == null || ratio === "") return "—";
  const pct = Number(ratio) * 100;
  if (!Number.isFinite(pct)) return "—";
  return `${pct >= 99.995 ? "100" : pct.toFixed(2)}%`;
}

export function fmtDateTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export function fmtDuration(fromIso, toIso) {
  if (!fromIso) return "";
  const ms = (toIso ? new Date(toIso) : new Date()) - new Date(fromIso);
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `${h}h ${mins % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

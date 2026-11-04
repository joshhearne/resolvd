import React from "react";
import { fmtUptime } from "../utils/itemState";

// Uptime-Kuma-style history bar: one pip per bucket (6h over 14 days),
// coloured by the worst state seen in that bucket. Data comes from
// GET /api/status-pages/:slug → item.timeline:
//   [{ s: state, d: down_s, p: partial_s, g: degraded_s, m: maint_s, k: known_s }]

const PIP = {
  up: "bg-emerald-500",
  down: "bg-red-500",
  partial: "bg-orange-500",
  pending: "bg-amber-400",
  maintenance: "bg-sky-500",
  unknown: "bg-slate-300 dark:bg-slate-700",
};

const LABEL = {
  up: "Operational",
  down: "Down",
  partial: "Partial outage",
  pending: "Degraded",
  maintenance: "Maintenance",
  unknown: "No data",
};

function dur(sec) {
  const m = Math.max(1, Math.round(sec / 60));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

function pipTitle(b, start, end) {
  const fmt = (ms) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric" });
  const parts = [`${fmt(start)} – ${fmt(end)}`, LABEL[b.s] || b.s];
  if (b.d) parts.push(`down ${dur(b.d)}`);
  if (b.p) parts.push(`partial ${dur(b.p)}`);
  if (b.g) parts.push(`degraded ${dur(b.g)}`);
  if (b.m) parts.push(`maintenance ${dur(b.m)}`);
  return parts.join(" · ");
}

export default function StatusTimeline({ buckets, meta, uptime, size = "md", className = "" }) {
  if (!Array.isArray(buckets) || !buckets.length || !meta) return null;
  const n = buckets.length;
  const h = size === "sm" ? "h-4" : "h-6";
  // Phones show the most recent half (7 days) so pips stay tappable.
  const half = Math.floor(n / 2);
  return (
    <div className={`flex items-center gap-2 min-w-0 ${className}`}>
      <div className="flex-1 min-w-0 flex items-end gap-[2px]" role="img"
        aria-label={`Status history, last ${Math.round((meta.end - meta.start) / 86400000)} days`}>
        {buckets.map((b, i) => {
          const end = meta.end - (n - 1 - i) * meta.bucket_ms;
          const start = Math.max(meta.start, end - meta.bucket_ms);
          return (
            <span
              key={i}
              title={pipTitle(b, start, end)}
              className={`${i < half ? "hidden sm:block" : "block"} flex-1 min-w-[3px] ${h} rounded-sm ${PIP[b.s] || PIP.unknown} hover:opacity-70 transition-opacity`}
            />
          );
        })}
      </div>
      {uptime !== undefined && (
        <span className="text-[11px] text-fg-muted tabular-nums w-14 text-right shrink-0" title="Availability over the window (maintenance excluded)">
          {uptime == null ? "—" : fmtUptime(uptime)}
        </span>
      )}
    </div>
  );
}

export function TimelineAxis({ days = 14 }) {
  return (
    <div className="flex items-center gap-2 text-[10px] text-fg-dim">
      <div className="flex-1 flex justify-between">
        <span className="hidden sm:inline">{days} days ago</span>
        <span className="sm:hidden">{Math.round(days / 2)} days ago</span>
        <span>now</span>
      </div>
      <span className="w-14 text-right shrink-0">uptime</span>
    </div>
  );
}

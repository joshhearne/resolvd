import React from "react";
import MarkdownContent from "./MarkdownContent";

// Bulleted change list for the What's new pop-up and the admin update
// preview: features (blue), then improvements (green), then fixes (orange).
export const CHANGE_KINDS = [
  { kind: "feature", label: "New feature", dot: "bg-blue-500" },
  { kind: "improvement", label: "Improvement", dot: "bg-green-500" },
  { kind: "fix", label: "Bug fix", dot: "bg-orange-500" },
];

export default function ChangeList({ entries }) {
  const rows = [];
  for (const k of CHANGE_KINDS) {
    for (const e of entries || []) {
      if (e.kind !== k.kind) continue;
      (e.items || []).forEach((text, i) => rows.push({ key: `${e.id}-${i}`, text, dot: k.dot, label: k.label }));
    }
  }
  if (!rows.length) return <p className="text-sm text-fg-dim">No changes listed.</p>;
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.key} className="flex items-start gap-2.5 text-sm text-fg">
          <span className={`mt-[7px] h-2 w-2 shrink-0 rounded-full ${r.dot}`} title={r.label} aria-label={r.label} />
          <MarkdownContent className="min-w-0 flex-1 [&_p]:m-0">{r.text}</MarkdownContent>
        </li>
      ))}
    </ul>
  );
}

export function ChangeKey() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-fg-muted">
      {CHANGE_KINDS.map((k) => (
        <span key={k.kind} className="inline-flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${k.dot}`} />
          {k.label}
        </span>
      ))}
    </div>
  );
}

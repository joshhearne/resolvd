import React, { useMemo, useState } from "react";

// Searchable checklist of monitored items, grouped by integration.
// Used by the status-page editor and the maintenance form.
//   items    — rows from /api/status-pages/_meta/items
//   selected — Set of item ids
//   onToggle — (id, checked) => void
// SERVICE / PRIMARY tags for an item. PRIMARY sits only on the
// component itself; the service never repeats it.
export function ItemTags({ item }) {
  const tag = "text-[10px] uppercase tracking-wide rounded px-1 border";
  return (
    <>
      {item.item_type === "group" && (
        <span className={`ml-1.5 ${tag} text-fg-dim border-border`}>service</span>
      )}
      {item.parent_item_id && item.is_primary && (
        <span className={`ml-1.5 ${tag} text-brand border-brand/40`}>primary</span>
      )}
    </>
  );
}

export default function MonitoredItemPicker({ items, selected, onToggle, maxHeight = "18rem" }) {
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = new Map();
    for (const it of items) {
      const hay = `${it.label || ""} ${it.detail || ""} ${it.source_name || ""}`.toLowerCase();
      if (needle && !hay.includes(needle)) continue;
      if (!out.has(it.source_name)) out.set(it.source_name, []);
      out.get(it.source_name).push(it);
    }
    return [...out.entries()];
  }, [items, q]);

  return (
    <div className="space-y-2">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Filter items…"
        className="w-full bg-surface-2 border border-border rounded px-2 py-1 text-sm"
      />
      <div className="border border-border rounded overflow-y-auto" style={{ maxHeight }}>
        {groups.length === 0 ? (
          <div className="text-xs text-fg-dim italic p-3">
            No monitored items{q ? " match" : " yet. They appear once an integration polls or alerts"}.
          </div>
        ) : groups.map(([source, rows]) => (
          <div key={source}>
            <div className="sticky top-0 bg-surface-2 text-[11px] uppercase tracking-wide text-fg-muted px-2 py-1 border-b border-border">
              {source}
            </div>
            {rows.map((it) => (
              <label key={it.id}
                className={`flex items-start gap-2 px-2 py-1.5 text-sm hover:bg-surface-2 cursor-pointer ${it.active ? "" : "opacity-50"}`}>
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={selected.has(it.id)}
                  onChange={(e) => onToggle(it.id, e.target.checked)}
                />
                <span className="min-w-0">
                  <span className="text-fg">{it.label || `Item ${it.id}`}</span>
                  <ItemTags item={it} />
                  {it.detail && <span className="block text-xs text-fg-dim font-mono truncate">{it.detail}</span>}
                  {!it.active && <span className="block text-xs text-fg-dim">no longer reported by source</span>}
                </span>
              </label>
            ))}
          </div>
        ))}
      </div>
      <div className="text-xs text-fg-muted">{selected.size} selected</div>
    </div>
  );
}

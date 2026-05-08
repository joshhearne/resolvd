import React, { useEffect, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";

// Per-user column visibility, scoped by tableKey. Stores HIDDEN ids in
// users.preferences.hidden_columns[tableKey] — keeping the negative set
// means new columns added later default to visible without a migration.
//
// Columns flagged alwaysOn cannot be hidden (e.g. the row-link title cell
// or a checkbox column in bulk-mode). They render in the picker as a
// disabled, checked checkbox so users see why they can't toggle them.
export function useColumnPrefs(tableKey) {
  const { user, updatePrefs } = useAuth();
  const stored = user?.preferences?.hidden_columns?.[tableKey];
  const hiddenIds = new Set(Array.isArray(stored) ? stored : []);

  function isVisible(id) {
    return !hiddenIds.has(id);
  }

  async function toggle(id) {
    const next = new Set(hiddenIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    const blob = { ...(user?.preferences?.hidden_columns || {}) };
    blob[tableKey] = Array.from(next);
    try {
      await updatePrefs({ hidden_columns: blob });
    } catch {
      // Surface a toast at the call site if needed; keep the hook quiet.
    }
  }

  return { isVisible, toggle, hiddenIds };
}

export default function ColumnPicker({ columns, hiddenIds, onToggle, label = "Columns" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const hiddenCount = columns.filter((c) => !c.alwaysOn && hiddenIds.has(c.id)).length;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="btn btn-secondary btn-sm flex items-center gap-1.5"
        aria-expanded={open}
        aria-haspopup="true"
      >
        <span>⚙</span>
        {label}
        {hiddenCount > 0 && (
          <span className="ml-1 px-1.5 py-0.5 rounded bg-brand/15 text-brand text-[10px]">
            {hiddenCount} hidden
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-56 bg-surface border border-border rounded-md shadow-lg z-30 py-1">
          <div className="px-3 py-1.5 text-[11px] uppercase tracking-wider font-semibold text-fg-dim border-b border-border">
            Visible columns
          </div>
          <div className="max-h-72 overflow-y-auto">
            {columns.map((c) => {
              const checked = c.alwaysOn || !hiddenIds.has(c.id);
              return (
                <label
                  key={c.id}
                  className={`flex items-center gap-2 px-3 py-1.5 text-sm ${
                    c.alwaysOn ? "text-fg-muted cursor-not-allowed" : "text-fg cursor-pointer hover:bg-surface-2"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={c.alwaysOn}
                    onChange={() => !c.alwaysOn && onToggle(c.id)}
                  />
                  <span>{c.label}</span>
                  {c.alwaysOn && (
                    <span className="ml-auto text-[10px] text-fg-dim">required</span>
                  )}
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

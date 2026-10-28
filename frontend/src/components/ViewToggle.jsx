import React, { useEffect, useState } from "react";

// Cards ⇄ list switch for browse pages. The choice is a per-viewer
// convenience, so it lives in localStorage under the given key and
// falls back to the default when storage is unavailable.
export function useViewMode(key, fallback = "cards") {
  const [mode, setMode] = useState(() => {
    try { const v = localStorage.getItem(`view:${key}`); return v === "list" || v === "cards" ? v : fallback; } catch { return fallback; }
  });
  useEffect(() => { try { localStorage.setItem(`view:${key}`, mode); } catch { /* ignore */ } }, [key, mode]);
  return [mode, setMode];
}

export default function ViewToggle({ mode, onChange, className = "" }) {
  const btn = (value, label, icon) => (
    <button
      type="button"
      onClick={() => onChange(value)}
      aria-pressed={mode === value}
      title={label}
      className={`px-2 py-1 inline-flex items-center gap-1 text-xs ${mode === value ? "bg-accent/10 text-accent" : "text-fg-muted hover:text-fg hover:bg-surface-2"}`}
    >
      {icon}<span className="hidden sm:inline">{label}</span>
    </button>
  );
  return (
    <div className={`inline-flex rounded-md border border-border overflow-hidden ${className}`} role="group" aria-label="View">
      {btn("cards", "Cards", (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-3.5 h-3.5"><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /></svg>
      ))}
      {btn("list", "List", (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-3.5 h-3.5"><line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="18" x2="20" y2="18" /></svg>
      ))}
    </div>
  );
}

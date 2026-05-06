import React, { useState, useRef, useLayoutEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { parseRef, readbackString } from "../utils/phonetic";
import { useAuth } from "../context/AuthContext";
import { useBranding } from "../context/BrandingContext";

// Wraps a ticket ref (e.g. "WEB-0079") and reveals a phonetic readback on
// hover/focus so users dictating the ref to a vendor can read off
// "Whiskey Echo Bravo - 0 0 7 9". Letters get NATO words; digits and the
// dash are shown as-is. Theme-aware via Tailwind dark: classes.
//
// Popover is portaled to document.body with position:fixed so it is not
// clipped by ancestor overflow:hidden containers (e.g. the ticket list
// table wrapper).
//
// Gated by:
//   - admin org toggle (branding.phonetic_readback_enabled, default ON)
//   - per-user preference (preferences.phonetic_readback, default ON)
// Either OFF -> renders children/value verbatim with no popover.
export default function PhoneticPopover({ value, children, className = "" }) {
  const { user } = useAuth();
  const { branding } = useBranding();
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ left: 0, top: 0 });
  const anchorRef = useRef(null);

  const orgEnabled = branding?.phonetic_readback_enabled !== false;
  const userEnabled = (user?.preferences?.phonetic_readback ?? true) !== false;
  const enabled = orgEnabled && userEnabled;

  const updateCoords = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setCoords({ left: r.left, top: r.bottom + 4 });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updateCoords();
    const onScroll = () => updateCoords();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, updateCoords]);

  if (!enabled) {
    return <span className={className}>{children ?? value}</span>;
  }

  const tokens = parseRef(value);
  const flat = readbackString(value);

  return (
    <span
      ref={anchorRef}
      className={`inline-block ${className}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      title={flat}
    >
      {children ?? value}
      {open && tokens.length > 0 && createPortal(
        <span
          role="tooltip"
          style={{ position: "fixed", left: coords.left, top: coords.top }}
          className="z-[9999] whitespace-nowrap rounded-md border border-border bg-surface text-fg shadow-lg px-3 py-2 text-xs font-sans pointer-events-none"
        >
          <span className="flex items-baseline gap-2">
            {tokens.map((t, i) => (
              <span key={i} className="flex flex-col items-center leading-tight">
                <span
                  className={
                    t.type === "nato"
                      ? "font-mono text-[10px] text-fg-dim"
                      : "font-mono text-[10px] text-fg-dim opacity-0"
                  }
                  aria-hidden="true"
                >
                  {t.char}
                </span>
                <span
                  className={
                    t.type === "nato"
                      ? "text-blue-600 dark:text-blue-400 font-medium"
                      : t.type === "number"
                      ? "text-orange-600 dark:text-orange-400 font-mono font-medium"
                      : t.type === "dash"
                      ? "text-fg-muted font-mono"
                      : "text-fg font-mono"
                  }
                >
                  {t.word}
                </span>
              </span>
            ))}
          </span>
        </span>,
        document.body
      )}
    </span>
  );
}

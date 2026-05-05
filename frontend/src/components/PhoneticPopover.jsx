import React, { useState } from "react";
import { parseRef, readbackString } from "../utils/phonetic";
import { useAuth } from "../context/AuthContext";
import { useBranding } from "../context/BrandingContext";

// Wraps a ticket ref (e.g. "WEB-0079") and reveals a phonetic readback on
// hover/focus so users dictating the ref to a vendor can read off
// "Whiskey Echo Bravo - 0 0 7 9". Letters get NATO words; digits and the
// dash are shown as-is. Theme-aware via Tailwind dark: classes.
//
// Gated by:
//   - admin org toggle (branding.phonetic_readback_enabled, default ON)
//   - per-user preference (preferences.phonetic_readback, default ON)
// Either OFF -> renders children/value verbatim with no popover.
export default function PhoneticPopover({ value, children, className = "" }) {
  const { user } = useAuth();
  const { branding } = useBranding();
  const [open, setOpen] = useState(false);

  const orgEnabled = branding?.phonetic_readback_enabled !== false;
  const userEnabled = (user?.preferences?.phonetic_readback ?? true) !== false;
  const enabled = orgEnabled && userEnabled;

  if (!enabled) {
    return <span className={className}>{children ?? value}</span>;
  }

  const tokens = parseRef(value);
  const flat = readbackString(value);

  return (
    <span
      className={`relative inline-block ${className}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      title={flat}
    >
      {children ?? value}
      {open && tokens.length > 0 && (
        <span
          role="tooltip"
          className="absolute left-0 top-full mt-1 z-50 whitespace-nowrap rounded-md border border-border bg-surface text-fg shadow-lg px-3 py-2 text-xs font-sans"
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
        </span>
      )}
    </span>
  );
}

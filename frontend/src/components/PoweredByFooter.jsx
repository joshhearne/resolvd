import React from "react";

// Foot-of-page credit. Two independent parts, both set in Admin → Branding:
//   - the organization's own name (optionally linked), and
//   - the "Powered by Hearne Technologies" credit, which can be turned off.
// Renders nothing when both are off.
export default function PoweredByFooter({ branding, className = "" }) {
  const name = (branding?.footer_name || "").trim();
  const url = (branding?.footer_url || "").trim();
  const showCredit = branding?.show_powered_by !== false;
  if (!name && !showCredit) return null;

  return (
    <div className={`flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-fg-dim ${className}`}>
      {name &&
        (url ? (
          <a href={url} target="_blank" rel="noopener noreferrer" className="hover:text-fg-muted hover:underline">
            {name}
          </a>
        ) : (
          <span>{name}</span>
        ))}
      {name && showCredit && <span aria-hidden="true">·</span>}
      {showCredit && (
        <span className="inline-flex items-center gap-2">
          <span>Powered by</span>
          <a href="https://hearnetech.com/apps" target="_blank" rel="noopener noreferrer">
            <img
              src="/hearne-logo.png"
              alt="Hearne Technologies"
              className="h-4 w-auto object-contain opacity-70 hover:opacity-100 transition-opacity dark:brightness-0 dark:invert"
            />
          </a>
        </span>
      )}
    </div>
  );
}

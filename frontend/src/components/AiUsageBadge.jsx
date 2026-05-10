import { useState, useRef, useEffect } from "react";
import toast from "react-hot-toast";

// Compact "✨ AI" badge for comments + ticket descriptions when an AI
// rewrite was applied. Hover / focus reveals the full readout (provider,
// model, tokens, tone, verbosity, ELI5 flag, project-context-applied
// flag). Click copies the full metadata text to clipboard so the user
// can paste it back to admin / support.
//
// Visibility is enforced server-side — by the time this renders, the
// caller already verified the viewer is allowed to see metadata. This
// component only handles presentation.
//
// Designed to slot inline next to header timestamps + action buttons.
// Parent flex layout should set `flex-wrap` so it wraps cleanly on
// narrow viewports rather than overflowing.

export default function AiUsageBadge({
  provider,
  model,
  inputTokens,
  outputTokens,
  tone,
  verbosity,
  eli5,
  projectContextUsed,
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  // Close popover on outside-click / Esc — keeps it from sticking open
  // when the user scrolls past it.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Build the multi-line text used both for the popover body + clipboard.
  const lines = [];
  if (provider) lines.push(`Provider: ${provider}`);
  if (model) lines.push(`Model: ${model}`);
  if (inputTokens != null || outputTokens != null) {
    lines.push(`Tokens: ${inputTokens ?? "?"} in / ${outputTokens ?? "?"} out`);
  }
  if (tone) lines.push(`Tone: ${tone}`);
  if (verbosity) lines.push(`Verbosity: ${verbosity}`);
  if (eli5) lines.push(`ELI5: yes`);
  if (projectContextUsed) lines.push(`Project context: applied`);
  const clipboardText = lines.join("\n");

  async function copyToClipboard() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(clipboardText);
      } else {
        // Fallback for browsers without clipboard API access (insecure
        // contexts, older Safari). Hidden textarea + execCommand.
        const ta = document.createElement("textarea");
        ta.value = clipboardText;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      toast.success("AI metadata copied");
    } catch {
      toast.error("Copy failed");
    }
  }

  if (!provider) return null;

  return (
    <span
      ref={wrapRef}
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={copyToClipboard}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        title="Click to copy AI metadata"
        aria-label="AI usage details — click to copy"
        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[11px] font-mono text-fg-muted bg-surface-2 border border-border hover:border-border-strong hover:text-fg transition-colors"
      >
        ✨ AI
      </button>
      {open && (
        <div
          role="tooltip"
          className="absolute z-50 top-full left-0 mt-1 min-w-[180px] max-w-[280px] bg-surface border border-border-strong rounded-md shadow-lg text-[11px] text-fg-muted font-mono px-2 py-1.5 leading-snug"
        >
          {lines.map((line, i) => (
            <div key={i} className="whitespace-normal break-words">
              {line}
            </div>
          ))}
          <div className="mt-1 pt-1 border-t border-border text-[10px] text-fg-dim">
            Click to copy
          </div>
        </div>
      )}
    </span>
  );
}

import { useState } from "react";
import AiRewriteModal from "./AiRewriteModal";
import { useBranding } from "../context/BrandingContext";

// Inline ✨ AI button + modal. For surfaces that aren't a MarkdownEditor
// (plain <input> / <textarea> / template editors). Returns null when the
// org has disabled AI Assist so callers can drop it in unconditionally.

export default function AiRewriteButton({
  value,
  onChange,
  surface,
  disabled,
  className = "",
  size = "sm",
  label = "AI",
}) {
  const [open, setOpen] = useState(false);
  const { branding } = useBranding();
  if (!surface || branding?.ai_assist_enabled === false) return null;

  const sizeClass = size === "xs" ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-1 text-xs";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled || !value || !String(value).trim()}
        title="AI rewrite"
        aria-label="Rewrite with AI"
        className={`inline-flex items-center gap-1 ${sizeClass} text-fg-muted hover:text-fg hover:bg-surface-2 rounded border border-border-strong transition-colors disabled:opacity-40 ${className}`}
      >
        ✨ {label}
      </button>
      <AiRewriteModal
        open={open}
        onClose={() => setOpen(false)}
        originalText={String(value || "")}
        surface={surface}
        onAccept={(t) => onChange(t)}
      />
    </>
  );
}

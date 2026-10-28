import React, { useState } from "react";
import { api } from "../utils/api";

// Reveal the raw inbound email behind a toggle. The ingest pipeline strips
// signatures / quoted history / external-sender banners (and can mis-unwrap a
// reply-above-quote block) before writing the ticket description or comment
// body — this lets an internal handler see the ORIGINAL email on demand
// instead of losing that content.
//
// Lazy: the raw body is fetched only on first expand. Pass `commentId` to
// reveal a comment's source; omit it for the ticket description's source.
// Render this only when the ticket/comment actually has source_inbound_email_id
// and the viewer is an internal handler (the endpoint is role-gated too).
export default function SourceEmailReveal({ ticketId, commentId = null, className = "" }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (data || loading) return; // already loaded / in flight
    setLoading(true);
    setError(null);
    try {
      const qs = commentId ? `?comment_id=${commentId}` : "";
      const res = await api.get(`/api/tickets/${ticketId}/source-email${qs}`);
      setData(res);
    } catch (e) {
      setError(e?.message || "Failed to load original email");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={toggle}
        className="inline-flex items-center gap-1 text-[11px] text-fg-dim hover:text-brand transition-colors"
        title="Show the original email as received — including the signature, quoted history and banner content stripped from the body"
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
          />
        </svg>
        {open ? "Hide original email" : "Show original email"}
      </button>
      {open && (
        <div className="mt-1.5 rounded border border-border bg-bg p-2.5 text-xs">
          {loading && <span className="text-fg-dim">Loading…</span>}
          {error && <span className="text-red-500">{error}</span>}
          {data && (
            <>
              <div className="mb-2 space-y-0.5 border-b border-border pb-1.5 text-fg-dim">
                <div>
                  <span className="font-semibold text-fg-muted">From:</span>{" "}
                  {data.from_name ? `${data.from_name} <${data.from_addr}>` : data.from_addr || "(unknown)"}
                </div>
                {data.subject && (
                  <div>
                    <span className="font-semibold text-fg-muted">Subject:</span> {data.subject}
                  </div>
                )}
              </div>
              <pre className="whitespace-pre-wrap break-words font-sans leading-snug text-fg-muted">
                {data.body || "(empty body)"}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import { listKbLinks } from "../utils/kbLinks";
import MarkdownContent from "./MarkdownContent";

// AI "Target KB links": refine plain KB links in a reply into links that land
// on the exact PDF page / highlighted phrase, optionally rewriting a
// procedure as numbered steps with a targeted link per step. The server
// verifies every page and phrase against the document before building URLs.
export default function TargetLinksDialog({ open, onClose, ticketId, text, onApply }) {
  const links = useMemo(() => (open ? listKbLinks(text) : []), [open, text]);
  const [selected, setSelected] = useState({}); // base -> bool
  const [notes, setNotes] = useState({}); // base -> note
  const [stepped, setStepped] = useState(true);
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!open) return;
    setSelected(Object.fromEntries(links.map((l) => [l.base, true])));
    setNotes({}); setResult(null); setInstructions("");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const chosen = links.filter((l) => selected[l.base]);

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.post(`/api/kb/tickets/${ticketId}/target-links`, {
        text,
        targets: chosen.map((l) => ({ url: l.url, note: notes[l.base] || "" })),
        stepped,
        instructions,
      });
      setResult(r);
    } catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  }

  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 px-3" onClick={onClose}>
      <div className="bg-surface border border-border rounded-lg shadow-xl max-w-3xl w-full max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between px-5 pt-4 pb-2">
          <div>
            <h3 className="text-lg font-semibold text-fg">Target KB links</h3>
            <p className="text-xs text-fg-muted mt-0.5">
              AI points each link at the exact page and phrase in the document. Every page and phrase is checked against the document before a link is built.
            </p>
          </div>
          <button onClick={onClose} className="text-fg-muted hover:text-fg text-xl leading-none" aria-label="Close">×</button>
        </div>

        <div className="px-5 pb-4 space-y-3 overflow-y-auto">
          {links.length === 0 ? (
            <p className="text-sm text-fg-muted">No KB links in this text. Insert one first with “Insert KB link”.</p>
          ) : (
            <>
              <div className="space-y-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">Links to target</div>
                {links.map((l) => (
                  <div key={l.base} className={`rounded border p-2 space-y-1 ${selected[l.base] ? "border-brand/40 bg-brand/5" : "border-border opacity-70"}`}>
                    <label className="flex items-start gap-2 text-sm">
                      <input type="checkbox" className="mt-1" checked={!!selected[l.base]} onChange={(e) => setSelected((p) => ({ ...p, [l.base]: e.target.checked }))} />
                      <span className="min-w-0">
                        <span className="font-medium text-fg">{l.title || "Link"}</span>
                        <span className="block text-[11px] text-fg-dim truncate">{l.line}</span>
                      </span>
                    </label>
                    {selected[l.base] && (
                      <input
                        value={notes[l.base] || ""}
                        onChange={(e) => setNotes((p) => ({ ...p, [l.base]: e.target.value }))}
                        maxLength={500}
                        placeholder="Context for this link (optional), e.g. “the scan-to-folder setup, not email”"
                        className="w-full bg-surface border border-border rounded px-2 py-1 text-xs"
                      />
                    )}
                  </div>
                ))}
              </div>

              <label className="flex items-start gap-2 text-sm text-fg">
                <input type="checkbox" className="mt-1" checked={stepped} onChange={(e) => setStepped(e.target.checked)} />
                <span>
                  Rewrite procedures as numbered steps, with a targeted link on each step
                  <span className="block text-[11px] text-fg-dim">Off: only the existing links are refined in place.</span>
                </span>
              </label>
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={2}
                maxLength={1000}
                placeholder="Extra instructions (optional)"
                className="w-full bg-surface border border-border rounded px-2 py-1.5 text-xs"
              />

              {result && (
                <div className="space-y-2">
                  {result.warnings?.length > 0 && (
                    <div className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-800 dark:text-amber-200 space-y-0.5">
                      {result.warnings.map((w, i) => <div key={i}>{w}</div>)}
                    </div>
                  )}
                  <div className="rounded-md border border-border">
                    <div className="px-3 py-2 border-b border-border bg-surface-2/40 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">Result</div>
                    <div className="p-3 text-sm text-fg"><MarkdownContent>{result.text}</MarkdownContent></div>
                  </div>
                  {result.changes?.length > 0 && (
                    <ul className="text-[11px] text-fg-muted space-y-0.5">
                      {result.changes.map((c, i) => (
                        <li key={i}>
                          <a href={c.url} target="_blank" rel="noreferrer" className="text-brand hover:underline">{c.document}</a>
                          {c.page ? ` · p. ${c.page}` : ""}{c.search ? ` · “${c.search}”` : ""}
                          {c.notes?.length ? <span className="text-amber-600 dark:text-amber-400"> · {c.notes.join("; ")}</span> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                  {result.ai?.model && (
                    <div className="text-[10px] text-fg-dim font-mono">{result.ai.provider} · {result.ai.model}</div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border">
          <button type="button" onClick={onClose} className="btn btn-secondary btn-sm">Cancel</button>
          {links.length > 0 && (
            <button type="button" onClick={run} disabled={busy || chosen.length === 0} className="btn btn-secondary btn-sm disabled:opacity-50">
              {busy ? "Working…" : result ? "Try again" : "✨ Target links"}
            </button>
          )}
          {result && (
            <button type="button" onClick={() => { onApply(result.text, result); onClose(); }} className="btn btn-primary btn-sm">
              Use this
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

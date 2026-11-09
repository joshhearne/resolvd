import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../utils/api";
import { buildKbUrl, markdownLink } from "../utils/kbLinks";

// "Insert KB link" for the comment composer.
//   1. search Trove KB + local KB
//   2. open the document in a new tab to find the right spot
//   3. narrow it: page number (PDFs) and/or a search term to highlight
//   4. Insert writes a markdown link, titled with the article name
// PDFs get #page=N&search=term; HTML articles get a #:~:text= highlight.
const absolute = (u) => (u && u.startsWith("/") ? `${window.location.origin}${u}` : u);

export default function KbLinkInserter({ open, onClose, projectId, onInsert }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState(null);
  const [usePdf, setUsePdf] = useState(true);
  const [page, setPage] = useState("");
  const [term, setTerm] = useState("");
  const [title, setTitle] = useState("");

  useEffect(() => {
    if (!open) return;
    setQ(""); setHits([]); setPicked(null); setPage(""); setTerm(""); setTitle("");
  }, [open]);

  useEffect(() => {
    if (!open || q.trim().length < 2) { setHits([]); return; }
    let alive = true;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({ q: q.trim() });
        if (projectId) qs.set("project_id", String(projectId));
        const r = await api.get(`/api/kb/link-search?${qs}`);
        if (alive) setHits(r || []);
      } catch { if (alive) setHits([]); }
      finally { if (alive) setSearching(false); }
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [q, open, projectId]);

  function pick(h) {
    setPicked(h);
    setUsePdf(!!h.pdf_url);
    setTitle(h.title || "");
    setPage(""); setTerm("");
  }

  const isPdf = !!(picked && usePdf && picked.pdf_url);
  const base = picked ? absolute(isPdf ? picked.pdf_url : (picked.url || picked.open_url)) : "";
  const url = useMemo(() => (base ? buildKbUrl(base, { pdf: isPdf, page, search: term }) : ""), [base, isPdf, page, term]);

  if (!open) return null;

  const field = "w-full border border-border-strong rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40";

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 px-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-lg shadow-xl max-w-xl w-full max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <h3 className="text-lg font-semibold text-fg">Insert KB link</h3>
          <button onClick={onClose} className="text-fg-muted hover:text-fg text-xl leading-none" aria-label="Close">×</button>
        </div>

        <div className="px-5 pb-4 space-y-3 overflow-y-auto">
          {!picked ? (
            <>
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Trove KB and local articles…" className={field} />
              {searching && <p className="text-xs text-fg-dim">Searching…</p>}
              {!searching && q.trim().length >= 2 && hits.length === 0 && <p className="text-xs text-fg-dim">No matching articles.</p>}
              <ul className="divide-y divide-border border border-border rounded-md empty:hidden">
                {hits.map((h) => (
                  <li key={`${h.source}-${h.id}`}>
                    <button type="button" onClick={() => pick(h)} className="w-full text-left px-3 py-2 hover:bg-surface-2">
                      <div className="flex flex-wrap items-center gap-1.5 text-sm text-fg">
                        <span className="font-medium">{h.title}</span>
                        <Badge>{h.source === "trove" ? "Trove KB" : "Local"}</Badge>
                        {h.pdf && <Badge tone="brand">PDF</Badge>}
                        {!h.linkable && <Badge tone="amber">internal</Badge>}
                      </div>
                      {h.subtitle && <div className="text-xs text-fg-dim">{h.subtitle}</div>}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-fg">{picked.title}</div>
                  <div className="text-xs text-fg-dim">{[picked.source === "trove" ? "Trove KB" : "Local KB", picked.subtitle].filter(Boolean).join(" · ")}</div>
                </div>
                <button type="button" onClick={() => setPicked(null)} className="text-xs text-brand hover:underline shrink-0">← Back to results</button>
              </div>

              {!picked.linkable && (
                <div className="text-xs rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 px-3 py-2">
                  Internal article: the ticket's submitter won't be able to open this link. Fine for an internal note.
                </div>
              )}

              {picked.pdf_url && picked.url && (
                <div className="flex gap-3 text-sm">
                  <label className="inline-flex items-center gap-1.5"><input type="radio" checked={usePdf} onChange={() => setUsePdf(true)} /> PDF</label>
                  <label className="inline-flex items-center gap-1.5"><input type="radio" checked={!usePdf} onChange={() => setUsePdf(false)} /> Article page</label>
                </div>
              )}

              <a
                href={absolute(isPdf ? picked.pdf_url : picked.open_url)}
                target="_blank"
                rel="noreferrer"
                className="btn btn-secondary btn-sm inline-flex"
              >
                Open document in a new tab ↗
              </a>
              <p className="text-xs text-fg-muted -mt-1">
                Find the spot, then fill in {isPdf ? "the page number and/or a phrase to highlight" : "a phrase to highlight"}.
              </p>

              <div className={`grid gap-3 ${isPdf ? "grid-cols-[7rem_1fr]" : "grid-cols-1"}`}>
                {isPdf && (
                  <label className="block">
                    <span className="block text-xs font-medium text-fg-muted mb-1">Page</span>
                    <input
                      value={page}
                      onChange={(e) => setPage(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      inputMode="numeric"
                      pattern="[0-9]*"
                      placeholder="e.g. 110"
                      className={field}
                    />
                  </label>
                )}
                <label className="block">
                  <span className="block text-xs font-medium text-fg-muted mb-1">{isPdf ? "Search term" : "Highlight text"}</span>
                  <input value={term} onChange={(e) => setTerm(e.target.value)} maxLength={200} placeholder="e.g. Scan to Network" className={field} />
                </label>
              </div>

              <label className="block">
                <span className="block text-xs font-medium text-fg-muted mb-1">Link text</span>
                <input value={title} onChange={(e) => setTitle(e.target.value)} className={field} />
              </label>

              <div className="rounded-md border border-border bg-surface-2/40 px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-fg-muted mb-1">Link</div>
                <div className="text-xs font-mono break-all text-fg">{url}</div>
                <a href={url} target="_blank" rel="noreferrer" className="text-xs text-brand hover:underline">Test this link ↗</a>
              </div>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border">
          <button type="button" onClick={onClose} className="btn btn-secondary btn-sm">Cancel</button>
          <button
            type="button"
            disabled={!picked || !url}
            onClick={() => { onInsert(markdownLink(title || picked.title, url)); onClose(); }}
            className="btn btn-primary btn-sm disabled:opacity-50"
          >
            Insert
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Badge({ children, tone }) {
  const cls = tone === "brand"
    ? "bg-brand/15 text-brand"
    : tone === "amber"
    ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
    : "bg-surface-2 text-fg-muted border border-border";
  return <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded ${cls}`}>{children}</span>;
}

import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";
import { api } from "../utils/api";

// Ticket-side Bothy block: linked Bothy articles, title-based
// suggestions, and a search picker. Rendered inside the ticket's
// KnowledgePanel. Renders nothing when Bothy is off.
//   GET    /api/bothy/status
//   GET    /api/bothy/tickets/:id/links
//   GET    /api/bothy/tickets/:id/suggestions
//   GET    /api/bothy/search?q=
//   POST   /api/bothy/tickets/:id/links
//   DELETE /api/bothy/tickets/:id/links/:articleId
export default function BothyKnowledge({ ticketId, canEdit, onDraft }) {
  const [status, setStatus] = useState(null);
  const [drafting, setDrafting] = useState(false);
  const [withAi, setWithAi] = useState(true);
  const [draftNote, setDraftNote] = useState(null);
  const [links, setLinks] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [picker, setPicker] = useState("");
  const [hits, setHits] = useState([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    api.get("/api/bothy/status").then(setStatus).catch(() => setStatus({ enabled: false }));
  }, []);

  async function loadAll() {
    try { setLinks(await api.get(`/api/bothy/tickets/${ticketId}/links`)); } catch { setLinks([]); }
    if (canEdit) {
      try { setSuggestions(await api.get(`/api/bothy/tickets/${ticketId}/suggestions?limit=5`)); } catch { setSuggestions([]); }
    }
  }
  useEffect(() => { if (status?.enabled) loadAll(); }, [ticketId, status?.enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!canEdit || !status?.enabled || picker.trim().length < 2) { setHits([]); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await api.get(`/api/bothy/search?q=${encodeURIComponent(picker.trim())}&limit=8`);
        if (!cancelled) setHits(r.filter((h) => !links.find((l) => l.article_id === h.article_id)));
      } catch { if (!cancelled) setHits([]); }
      finally { if (!cancelled) setSearching(false); }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [picker, canEdit, status?.enabled, links]);

  async function link(articleId, kind) {
    try {
      await api.post(`/api/bothy/tickets/${ticketId}/links`, { article_id: articleId, kind });
      toast.success("Bothy article linked");
      setPicker(""); setHits([]);
      await loadAll();
    } catch (e) { toast.error(e.message); }
  }
  async function unlink(articleId) {
    try {
      await api.delete(`/api/bothy/tickets/${ticketId}/links/${articleId}`);
      toast.success("Unlinked");
      await loadAll();
    } catch (e) { toast.error(e.message); }
  }

  // Resolution draft: extractive digest of the linked (or best-matching)
  // articles, plus an AI summary when the user may use AI Assist.
  async function draftResolution() {
    if (!onDraft) return;
    setDrafting(true);
    setDraftNote(null);
    try {
      const r = await api.post(`/api/bothy/tickets/${ticketId}/resolution-draft`, {
        ai: withAi && status?.ai?.available === true,
      });
      if (!r.digest_md) { setDraftNote(r.ai?.note || "Nothing to draft from."); return; }
      const parts = [];
      if (r.ai?.summary_md) parts.push(r.ai.summary_md);
      parts.push(r.digest_md);
      onDraft(parts.join("\n\n"));
      if (r.ai?.note) setDraftNote(r.ai.note);
      toast.success(r.ai?.summary_md ? "Draft with AI summary added" : "Draft from articles added");
    } catch (e) { toast.error(e.message); }
    finally { setDrafting(false); }
  }

  if (!status?.enabled) return null;
  if (!canEdit && links.length === 0) return null;

  return (
    <div className="space-y-2 border-t border-border pt-2">
      <div className="text-[11px] text-fg-muted uppercase tracking-wide">
        Bothy {links.length > 0 && <span className="normal-case tracking-normal">({links.length})</span>}
      </div>

      {links.length === 0 ? (
        <div className="text-xs text-fg-dim italic">No Bothy articles linked.</div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {links.map((l) => (
            <span key={l.article_id} className="inline-flex items-center gap-1 text-xs bg-brand/10 text-brand rounded px-2 py-1">
              <Link to={`/kb/article/${l.article_id}?ticket=${ticketId}`} className="hover:underline" title={l.collection_name || ""}>{l.title}</Link>
              {l.scope === "public" && <span className="text-[9px] uppercase text-emerald-600 dark:text-emerald-300">pub</span>}
              {canEdit && (
                <button onClick={() => unlink(l.article_id)} className="text-brand/70 hover:text-red-600" title="Unlink">×</button>
              )}
            </span>
          ))}
        </div>
      )}

      {canEdit && (
        <div className="relative">
          <input
            type="text"
            value={picker}
            onChange={(e) => setPicker(e.target.value)}
            placeholder="Search Bothy to link an article…"
            className="w-full bg-surface-2 border border-border rounded px-2 py-1 text-xs"
          />
          {(hits.length > 0 || searching) && picker.trim().length >= 2 && (
            <div className="absolute z-20 left-0 right-0 mt-1 bg-surface border border-border rounded-md shadow-lg max-h-64 overflow-y-auto">
              {searching && hits.length === 0 && <div className="px-3 py-2 text-xs text-fg-dim">Searching…</div>}
              {hits.map((h) => (
                <button key={h.article_id} onClick={() => link(h.article_id, "manual")} className="w-full text-left px-3 py-2 hover:bg-surface-2 text-xs">
                  <div className="font-medium text-fg">{h.title}</div>
                  <div className="text-[10px] text-fg-dim mt-0.5 truncate">{[h.collection_name, h.category].filter(Boolean).join(" · ")}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {canEdit && onDraft && (links.length > 0 || suggestions.length > 0) && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button
            onClick={draftResolution}
            disabled={drafting}
            className="px-2 py-1 rounded border border-border bg-surface-2 text-fg hover:bg-surface disabled:opacity-50"
            title={links.length > 0 ? "Build a resolution write-up from the linked articles" : "Build a resolution write-up from the best-matching articles"}
          >
            {drafting ? "Drafting…" : "Draft resolution from Bothy"}
          </button>
          {status?.ai?.available ? (
            <label className="flex items-center gap-1 text-fg-muted">
              <input type="checkbox" checked={withAi} onChange={(e) => setWithAi(e.target.checked)} />
              AI summary
            </label>
          ) : (
            <span className="text-fg-dim" title={status?.ai?.note || ""}>Extracted passages only (no AI token)</span>
          )}
        </div>
      )}
      {draftNote && (
        <div className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-2 py-1 text-[11px] text-amber-800 dark:text-amber-200">{draftNote}</div>
      )}

      {canEdit && suggestions.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] text-fg-dim uppercase tracking-wide">Suggested from Bothy</div>
          {suggestions.map((s) => (
            <div key={s.article_id} className="flex items-center gap-2 text-xs">
              <Link to={`/kb/article/${s.article_id}?ticket=${ticketId}`} className="text-brand hover:underline flex-1 truncate" title={s.snippet || ""}>{s.title}</Link>
              <span className="text-fg-dim truncate max-w-[120px]">{s.collection_name}</span>
              <button onClick={() => link(s.article_id, "suggested_accepted")} className="text-[11px] px-2 py-0.5 bg-brand text-white rounded">Link</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

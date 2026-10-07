import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import MarkdownContent from "./MarkdownContent";

// Knowledge brief: scope a response before anything rewrites it.
//
// Left: the inputs, all editable, all scrollable. What the user reported
// (trusted), what the team already said, the tech's draft (trusted), the
// tech's corrections (what the user left out), the project context in
// force, and the Bothy articles that matched with include/exclude + a
// per-article note. Right: the output. "Build" composes with no AI
// (default). "Rewrite with AI" sends the curated brief to the provider.
// Both yield a Reply (for the user) and a Resolution (internal record).
export default function AssistBriefModal({ open, onClose, ticketId, draft, aiAvailable, aiNote, onUseReply, onUseResolution }) {
  const [brief, setBrief] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [composing, setComposing] = useState(false);
  const [result, setResult] = useState(null);
  const [search, setSearch] = useState("");
  const [searchHits, setSearchHits] = useState([]);
  const [showContext, setShowContext] = useState(false);

  useEffect(() => {
    if (!open) return;
    setResult(null); setError(null); setSearch(""); setSearchHits([]);
    setLoading(true);
    api.post(`/api/bothy/tickets/${ticketId}/assist/brief`, { draft })
      .then(setBrief)
      .catch((e) => setError(e.message || "Could not build the brief"))
      .finally(() => setLoading(false));
  }, [open, ticketId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Draft can keep changing in the composer while the modal is closed;
  // when it opens, the brief takes the current draft.
  useEffect(() => {
    if (!open || !brief) return;
    setBrief((b) => (b ? { ...b, draft: { ...b.draft, text: draft } } : b));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || search.trim().length < 2) { setSearchHits([]); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await api.get(`/api/bothy/search?q=${encodeURIComponent(search.trim())}&limit=8`);
        if (!cancelled) setSearchHits(r.filter((h) => !brief?.articles?.some((a) => a.article_id === h.article_id)));
      } catch { if (!cancelled) setSearchHits([]); }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [search, open, brief?.articles]);

  const includedCount = useMemo(() => (brief?.articles || []).filter((a) => a.included).length, [brief]);

  function setArticle(id, patch) {
    setBrief((b) => ({ ...b, articles: b.articles.map((a) => (a.article_id === id ? { ...a, ...patch } : a)) }));
  }
  function addArticle(h) {
    setBrief((b) => ({ ...b, articles: [...b.articles, { ...h, included: true, note: "" }] }));
    setSearch(""); setSearchHits([]);
  }
  function setReported(idx, text) {
    setBrief((b) => ({ ...b, reported: { ...b.reported, items: b.reported.items.map((i, j) => (j === idx ? { ...i, text } : i)) } }));
  }
  function dropReported(idx) {
    setBrief((b) => ({ ...b, reported: { ...b.reported, items: b.reported.items.filter((_, j) => j !== idx) } }));
  }

  async function compose(ai) {
    setComposing(true);
    setResult(null);
    try {
      const r = await api.post(`/api/bothy/tickets/${ticketId}/assist/compose`, { brief, ai });
      setResult(r);
      if (r.ai?.note) toast(r.ai.note, { icon: "ℹ️" });
      else toast.success(r.mode === "ai" ? "Rewritten with AI" : "Built from the brief");
    } catch (e) { toast.error(e.message || "Compose failed"); }
    finally { setComposing(false); }
  }

  if (!open) return null;

  const section = "rounded-md border border-border bg-surface-2/40 p-3 space-y-2";
  const label = "text-[11px] font-semibold uppercase tracking-wide text-fg-muted flex items-center justify-between";
  const ta = "w-full bg-surface border border-border rounded px-2 py-1.5 text-xs leading-relaxed";

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-3" onClick={onClose}>
      <div className="bg-surface rounded-lg shadow-2xl w-full max-w-6xl h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div>
            <h3 className="text-base font-semibold text-fg">Knowledge brief</h3>
            <p className="text-[11px] text-fg-muted mt-0.5">
              What is known, what the user left out, and which documentation applies. Reviewed by you before anything is written.
            </p>
          </div>
          <button onClick={onClose} className="text-fg-muted hover:text-fg text-xl leading-none" aria-label="Close">×</button>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center text-sm text-fg-muted">Gathering the ticket, comments, and matching articles…</div>
        ) : error ? (
          <div className="flex-1 flex items-center justify-center text-sm text-red-500">{error}</div>
        ) : brief && (
          <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2">
            {/* ── Inputs ── */}
            <div className="min-h-0 overflow-y-auto p-4 space-y-3 border-b lg:border-b-0 lg:border-r border-border">
              <div className={section}>
                <div className={label}>
                  <span>What the user reported</span>
                  <label className="normal-case tracking-normal font-normal flex items-center gap-1">
                    <input type="checkbox" checked={brief.reported.trusted !== false} onChange={(e) => setBrief((b) => ({ ...b, reported: { ...b.reported, trusted: e.target.checked } }))} />
                    treated as accurate
                  </label>
                </div>
                <div className="text-xs text-fg">
                  <div className="font-medium">{brief.ticket.title}</div>
                  {brief.ticket.description && <div className="text-fg-muted mt-1 whitespace-pre-wrap line-clamp-6">{brief.ticket.description}</div>}
                </div>
                {brief.reported.items.map((i, idx) => (
                  <div key={i.comment_id ?? idx} className="space-y-1">
                    <div className="flex items-center justify-between text-[11px] text-fg-dim">
                      <span>{i.name} <span className="uppercase">({i.who})</span></span>
                      <button onClick={() => dropReported(idx)} className="hover:text-red-500">remove</button>
                    </div>
                    <textarea value={i.text} onChange={(e) => setReported(idx, e.target.value)} rows={3} className={ta} />
                  </div>
                ))}
                <textarea
                  value={brief.reported.summary || ""}
                  onChange={(e) => setBrief((b) => ({ ...b, reported: { ...b.reported, summary: e.target.value } }))}
                  rows={2}
                  placeholder="Optional: the problem in one or two sentences, as you understand it."
                  className={ta}
                />
              </div>

              {brief.team.items.length > 0 && (
                <div className={section}>
                  <div className={label}><span>What the team has said</span></div>
                  {brief.team.items.map((i, idx) => (
                    <div key={i.comment_id ?? idx} className="text-xs text-fg-muted">
                      <span className="text-fg-dim">{i.name}:</span> <span className="whitespace-pre-wrap">{i.text}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className={section}>
                <div className={label}><span>Your response (draft)</span><span className="normal-case tracking-normal font-normal">treated as accurate</span></div>
                <textarea value={brief.draft.text} onChange={(e) => setBrief((b) => ({ ...b, draft: { ...b.draft, text: e.target.value } }))} rows={6} className={ta} placeholder="What you are telling the user." />
              </div>

              <div className={section}>
                <div className={label}><span>Corrections — what the user left out</span></div>
                <p className="text-[11px] text-fg-muted">
                  The real trigger, the system that is actually involved, what you already checked. Overrides the user's wording. Saved with this ticket and carried into the next brief.
                </p>
                <textarea
                  value={brief.corrections || ""}
                  onChange={(e) => setBrief((b) => ({ ...b, corrections: e.target.value }))}
                  rows={4}
                  className={ta}
                  placeholder={"e.g. Only happens after the laptop lid is closed: the network drops, so the G2 apps lose their session. Not an account problem."}
                />
              </div>

              <div className={section}>
                <div className={label}>
                  <span>Project context{brief.project.name ? ` — ${brief.project.name}` : ""}</span>
                  <label className="normal-case tracking-normal font-normal flex items-center gap-1">
                    <input type="checkbox" checked={brief.project.context_enabled !== false} onChange={(e) => setBrief((b) => ({ ...b, project: { ...b.project, context_enabled: e.target.checked } }))} />
                    include
                  </label>
                </div>
                <div className="text-[11px] text-fg-dim">
                  Collection: {brief.project.collection_name || brief.project.collection_id || <span className="italic">none mapped (Admin → AI Assist → Project contexts)</span>}
                </div>
                {brief.project.context_md ? (
                  <>
                    <button onClick={() => setShowContext((v) => !v)} className="text-[11px] text-brand hover:underline">{showContext ? "Hide" : "Show"} context ({brief.project.context_md.length} chars)</button>
                    {showContext && <div className="text-xs text-fg-muted max-h-48 overflow-y-auto border border-border rounded p-2"><MarkdownContent>{brief.project.context_md}</MarkdownContent></div>}
                  </>
                ) : (
                  <div className="text-[11px] text-fg-dim italic">No project context written yet.</div>
                )}
              </div>

              <div className={section}>
                <div className={label}><span>Documentation that matched</span><span className="normal-case tracking-normal font-normal">{includedCount} included</span></div>
                {!brief.bothy_enabled && <div className="text-[11px] text-amber-500">Bothy is not connected; no articles available.</div>}
                {brief.articles.length === 0 && brief.bothy_enabled && <div className="text-[11px] text-fg-dim italic">Nothing matched the title or your draft. Search below to add articles.</div>}
                {brief.articles.map((a) => (
                  <div key={a.article_id} className={`rounded border p-2 space-y-1 ${a.included ? "border-brand/40 bg-brand/5" : "border-border opacity-70"}`}>
                    <div className="flex items-start gap-2">
                      <input type="checkbox" checked={a.included !== false} onChange={(e) => setArticle(a.article_id, { included: e.target.checked })} className="mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium text-fg flex flex-wrap items-center gap-2">
                          <a href={`/kb/article/${a.article_id}?ticket=${ticketId}`} target="_blank" rel="noreferrer" className="hover:underline">{a.title}</a>
                          <span className={`text-[9px] uppercase px-1 rounded ${a.scope === "public" ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300" : "bg-amber-500/15 text-amber-600 dark:text-amber-300"}`}>{a.scope}</span>
                        </div>
                        <div className="text-[10px] text-fg-dim">{[a.collection_name, a.category, a.heading].filter(Boolean).join(" · ")}</div>
                        {a.snippet && <div className="text-[11px] text-fg-muted mt-1 line-clamp-4">{a.snippet}</div>}
                      </div>
                    </div>
                    {a.included !== false && (
                      <input
                        value={a.note || ""}
                        onChange={(e) => setArticle(a.article_id, { note: e.target.value })}
                        placeholder="Note on this article (e.g. applies only to model X; step 3 is outdated)"
                        className="w-full bg-surface border border-border rounded px-2 py-1 text-[11px]"
                      />
                    )}
                  </div>
                ))}
                {brief.bothy_enabled && (
                  <div className="relative">
                    <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search Bothy to add an article…" className={ta} />
                    {searchHits.length > 0 && (
                      <div className="absolute z-20 left-0 right-0 mt-1 bg-surface border border-border rounded-md shadow-lg max-h-56 overflow-y-auto">
                        {searchHits.map((h) => (
                          <button key={h.article_id} onClick={() => addArticle(h)} className="w-full text-left px-3 py-2 hover:bg-surface-2 text-xs">
                            <div className="font-medium text-fg">{h.title}</div>
                            <div className="text-[10px] text-fg-dim">{[h.collection_name, h.category].filter(Boolean).join(" · ")}</div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* ── Output ── */}
            <div className="min-h-0 flex flex-col">
              <div className="px-4 py-3 border-b border-border flex flex-wrap items-center gap-2">
                <button onClick={() => compose(false)} disabled={composing} className="btn btn-primary btn-sm">
                  {composing ? "Working…" : "Build (no AI)"}
                </button>
                <button
                  onClick={() => compose(true)}
                  disabled={composing || !aiAvailable}
                  className="btn btn-secondary btn-sm"
                  title={aiAvailable ? "Send the curated brief to the configured AI provider" : (aiNote || "AI unavailable")}
                >
                  ✨ Rewrite with AI
                </button>
                {!aiAvailable && <span className="text-[11px] text-fg-dim">{aiNote || "AI rewrite needs an API token (org key or your own)."}</span>}
                {result?.mode === "ai" && result.ai?.model && (
                  <span className="ml-auto text-[11px] text-fg-muted font-mono">{result.ai.provider} · {result.ai.model}{result.ai.usage ? ` · ${result.ai.usage.input_tokens || 0}/${result.ai.usage.output_tokens || 0} tok` : ""}</span>
                )}
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
                {!result ? (
                  <div className="text-sm text-fg-dim">
                    Review the inputs on the left, then <strong>Build</strong>. The default pass uses no AI: your response stays yours, with public documentation links added, and the resolution is assembled from the facts and the matched passages.
                  </div>
                ) : (
                  <>
                    {result.ai?.note && <div className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">{result.ai.note}</div>}
                    <OutputBlock title="Reply to the user" md={result.reply_md} onUse={onUseReply ? () => { onUseReply(result.reply_md, { logId: result.ai?.log_id || null, mode: result.mode }); onClose(); } : null} useLabel="Use as comment" />
                    <OutputBlock title="Resolution (internal record)" md={result.resolution_md} onUse={onUseResolution ? () => onUseResolution(result.resolution_md) : null} useLabel="Save as resolution" />
                    <div className="text-[10px] text-fg-dim">Brief #{result.brief_id} saved for audit · {result.mode === "ai" ? "AI rewrite" : "no AI"} · {result.articles_used?.length || 0} article{result.articles_used?.length === 1 ? "" : "s"} used</div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function OutputBlock({ title, md, onUse, useLabel }) {
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(md || "");
  useEffect(() => { setText(md || ""); setEdit(false); }, [md]);
  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-surface-2/40">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">{title}</div>
        <div className="flex items-center gap-2 text-xs">
          <button onClick={() => setEdit((v) => !v)} className="text-fg-muted hover:text-fg">{edit ? "Preview" : "Edit"}</button>
          <button onClick={() => navigator.clipboard?.writeText(text).then(() => toast.success("Copied")).catch(() => {})} className="text-fg-muted hover:text-fg">Copy</button>
          {onUse && <button onClick={() => onUse(text)} className="px-2 py-0.5 bg-brand text-white rounded">{useLabel}</button>}
        </div>
      </div>
      <div className="p-3 text-sm text-fg">
        {edit ? (
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={10} className="w-full bg-surface border border-border rounded px-2 py-1.5 text-xs leading-relaxed" />
        ) : text ? (
          <MarkdownContent>{text}</MarkdownContent>
        ) : (
          <div className="text-fg-dim italic text-xs">Nothing produced.</div>
        )}
      </div>
    </div>
  );
}

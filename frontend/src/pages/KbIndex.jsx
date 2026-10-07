import React, { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import ViewToggle, { useViewMode } from "../components/ViewToggle";

export default function KbIndex() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [troveKb, setTroveKb] = useState(null);
  const [collections, setCollections] = useState([]);
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") || "");
  const [collectionId, setCollectionId] = useState(params.get("collection") || "");
  const [hits, setHits] = useState(null);
  const [searching, setSearching] = useState(false);
  const [view, setView] = useViewMode("kb-collections", "cards");

  useEffect(() => {
    api.get("/api/trove-kb/status")
      .then((st) => {
        setTroveKb(st);
        if (st?.has_visible) api.get("/api/trove-kb/collections").then(setCollections).catch(() => setCollections([]));
      })
      .catch(() => setTroveKb({ enabled: false }));
  }, []);

  // Search runs from the URL (?q=&collection=) so results are linkable.
  useEffect(() => {
    const term = (params.get("q") || "").trim();
    const cid = params.get("collection") || "";
    setQ(term); setCollectionId(cid);
    if (!troveKb?.has_visible || term.length < 2) { setHits(null); return; }
    let cancelled = false;
    setSearching(true);
    api.get(`/api/trove-kb/search?q=${encodeURIComponent(term)}&limit=25${cid ? `&collection_id=${cid}` : ""}`)
      .then((r) => { if (!cancelled) setHits(r); })
      .catch((e) => { if (!cancelled) { setHits([]); toast.error(e.message); } })
      .finally(() => { if (!cancelled) setSearching(false); });
    return () => { cancelled = true; };
  }, [params, troveKb?.has_visible]);

  function submitSearch(e) {
    e.preventDefault();
    const next = {};
    if (q.trim()) next.q = q.trim();
    if (collectionId) next.collection = collectionId;
    setParams(next);
  }

  useEffect(() => {
    api
      .get("/api/kb/projects")
      .then(setProjects)
      .catch((e) => toast.error(e.message))
      .finally(() => setLoading(false));
  }, []);

  async function toggleStar(proj) {
    const next = !proj.starred;
    setProjects((prev) => {
      const flipped = prev.map((p) => (p.id === proj.id ? { ...p, starred: next } : p));
      return [...flipped].sort((a, b) => {
        if (!!a.starred !== !!b.starred) return a.starred ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    });
    try {
      if (next) await api.put(`/api/users/me/starred-projects/${proj.id}`, {});
      else await api.delete(`/api/users/me/starred-projects/${proj.id}`);
    } catch (err) {
      toast.error(err.message || "Star toggle failed");
      setProjects((prev) => prev.map((p) => (p.id === proj.id ? { ...p, starred: !next } : p)));
    }
  }

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">Knowledge Base</h1>
        <p className="text-sm text-fg-muted mt-1">
          {troveKb?.has_visible
            ? "Search the company knowledge base, or browse the per-project articles below."
            : "Per-project documentation. Pick a project to browse or edit its articles."}
        </p>
      </header>

      {troveKb?.has_visible && (
        <section className="rounded-lg border border-border bg-surface p-5 space-y-4">
          <form onSubmit={submitSearch} className="flex flex-col sm:flex-row gap-2">
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search documentation…"
              className="flex-1 bg-surface-2 border border-border rounded px-3 py-2 text-sm"
            />
            {collections.length > 1 && (
              <select
                value={collectionId}
                onChange={(e) => setCollectionId(e.target.value)}
                className="bg-surface-2 border border-border rounded px-2 py-2 text-sm"
              >
                <option value="">All collections</option>
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}{c.scope === "internal" ? " (internal)" : ""}</option>
                ))}
              </select>
            )}
            <button type="submit" className="btn btn-primary btn-sm">Search</button>
          </form>

          {searching && <div className="text-sm text-fg-muted">Searching…</div>}

          {!searching && hits && (
            hits.length === 0 ? (
              <div className="text-sm text-fg-dim italic">No articles matched.</div>
            ) : (
              <ul className="divide-y divide-border">
                {hits.map((h) => (
                  <li key={h.article_id} className="py-3">
                    <Link to={`/kb/article/${h.article_id}`} className="text-base font-medium text-fg hover:text-accent">
                      {h.title}
                    </Link>
                    <div className="text-[11px] text-fg-dim mt-0.5">
                      {[h.collection_name, h.category, h.subcategory].filter(Boolean).join(" · ")}
                      {h.scope === "public" && <span className="ml-2 uppercase text-emerald-600 dark:text-emerald-300">public</span>}
                    </div>
                    {h.snippet && <p className="text-sm text-fg-muted mt-1 line-clamp-2">{h.snippet}</p>}
                  </li>
                ))}
              </ul>
            )
          )}

          {!hits && (troveKb.base_url || troveKb.public_url) && (
            <div className="flex flex-wrap gap-3 text-xs">
              {troveKb.base_url && <a href={`${troveKb.base_url}/kb`} target="_blank" rel="noreferrer" className="text-brand hover:underline">Open Trove KB ↗</a>}
              {troveKb.public_url && <a href={troveKb.public_url} target="_blank" rel="noreferrer" className="text-brand hover:underline">Public site ↗</a>}
            </div>
          )}
        </section>
      )}

      {troveKb?.has_visible && !hits && collections.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-fg-muted uppercase tracking-wide">Collections</h2>
            <ViewToggle mode={view} onChange={setView} />
          </div>
          {view === "list" ? (
            <ul className="rounded-lg border border-border bg-surface divide-y divide-border">
              {collections.map((c) => (
                <li key={c.id}>
                  <Link to={`/kb/collection/${c.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2 group">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-fg group-hover:text-accent truncate">{c.name}</div>
                      {c.description && <div className="text-xs text-fg-muted truncate">{c.description}</div>}
                    </div>
                    <span className={`flex-shrink-0 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${c.scope === "public" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" : "bg-brand/10 text-brand"}`}>{c.scope === "public" ? "Public" : "Internal"}</span>
                    {c.articles != null && <span className="flex-shrink-0 w-16 text-right text-xs font-mono text-fg-muted">{c.articles}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {collections.map((c) => (
              <Link
                key={c.id}
                to={`/kb/collection/${c.id}`}
                className="block group rounded-lg border border-border bg-surface hover:bg-surface-2 hover:border-accent/40 transition-colors p-5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="text-base font-semibold text-fg group-hover:text-accent">{c.name}</div>
                  <span className={`flex-shrink-0 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${c.scope === "public" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" : "bg-brand/10 text-brand"}`}>{c.scope === "public" ? "Public" : "Internal"}</span>
                </div>
                {c.description && <p className="text-sm text-fg-muted mt-1 line-clamp-2">{c.description}</p>}
                <div className="mt-3 flex items-center gap-2 text-xs text-fg-muted">
                  {c.articles != null && <span className="px-2 py-0.5 rounded-full font-mono bg-surface-2 text-fg-muted">{c.articles}</span>}
                  <span>{c.articles == null ? "Browse" : `article${c.articles === 1 ? "" : "s"}`}</span>
                </div>
              </Link>
            ))}
          </div>
          )}
        </section>
      )}

      {troveKb?.has_visible && troveKb?.local_kb_enabled !== false && (
        <h2 className="text-sm font-semibold text-fg-muted uppercase tracking-wide pt-2">Project articles</h2>
      )}

      {troveKb?.local_kb_enabled === false ? null : loading ? (
        <div className="text-fg-muted text-sm">Loading…</div>
      ) : projects.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center">
          <p className="text-fg-muted">No projects available.</p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((p) => (
            <div key={p.id} className="relative">
              <Link
                to={`/kb/${p.id}`}
                className="block group rounded-lg border border-border bg-surface hover:bg-surface-2 hover:border-accent/40 transition-colors p-5 pr-14"
              >
                {/* pr-14 reserves space on the right for the absolute
                    star button so the title + count never tuck under
                    it on narrow cards. */}
                <div className="min-w-0">
                  <div className="text-xs font-mono text-fg-dim uppercase tracking-wider">
                    {p.prefix}
                  </div>
                  <div className="mt-1 text-base font-semibold text-fg truncate group-hover:text-accent">
                    {p.name}
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-2 text-xs text-fg-muted">
                  <span className="px-2 py-0.5 rounded-full font-mono bg-surface-2 text-fg-muted">
                    {p.article_count}
                  </span>
                  <span>
                    {p.article_count === 0
                      ? "No articles yet"
                      : `article${p.article_count === 1 ? "" : "s"}`}
                  </span>
                </div>
              </Link>
              <button
                type="button"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleStar(p); }}
                className={`absolute top-2 right-2 p-2 rounded-md hover:bg-surface-2 transition-colors min-w-[40px] min-h-[40px] inline-flex items-center justify-center ${p.starred ? "text-amber-400" : "text-fg-dim hover:text-fg-muted"}`}
                title={p.starred ? "Unstar" : "Star"}
                aria-label={p.starred ? "Unstar" : "Star"}
              >
                <svg viewBox="0 0 24 24" fill={p.starred ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.6" className="w-5 h-5">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

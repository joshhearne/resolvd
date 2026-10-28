import React, { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import ViewToggle, { useViewMode } from "../components/ViewToggle";

// Browse one Trove KB collection: categories (with subcategories and
// counts) on the left, the articles of the chosen category on the right,
// sortable, paged by cursor, with a search box scoped to the collection.
// URL carries category/subcategory/kind/sort/q so views are linkable.
export default function TroveKbCollection() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const category = params.get("category") ?? "";
  const subcategory = params.get("subcategory") ?? "";
  const kind = params.get("kind") ?? "";
  const sourceType = params.get("source_type") ?? "";
  const sort = params.get("sort") ?? "name";
  const dir = params.get("dir") ?? "asc";
  const q = params.get("q") ?? "";

  const [collection, setCollection] = useState(null);
  const [error, setError] = useState(null);
  const [articles, setArticles] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [hits, setHits] = useState(null);
  const [searching, setSearching] = useState(false);
  const [qInput, setQInput] = useState(q);
  const [railOpen, setRailOpen] = useState(false);
  const [view, setView] = useViewMode("kb-articles", "list");

  useEffect(() => {
    setError(null);
    api.get(`/api/trove-kb/collections/${id}`)
      .then(setCollection)
      .catch((e) => setError(e.message || "Collection not found"));
  }, [id]);

  function set(next) {
    const merged = { category, subcategory, kind, source_type: sourceType, sort, dir, q, ...next };
    const out = {};
    for (const [k, v] of Object.entries(merged)) if (v) out[k] = v;
    setParams(out);
  }

  // Article list (no query) — reload from the first page on any filter change.
  useEffect(() => {
    if (q.trim().length >= 2) return;
    let cancelled = false;
    setLoading(true); setArticles([]); setCursor(null); setHits(null);
    api.get(`/api/trove-kb/articles?collection_id=${id}&category=${encodeURIComponent(category)}&subcategory=${encodeURIComponent(subcategory)}&kind=${kind}&source_type=${sourceType}&sort=${sort}&dir=${dir}&limit=50`)
      .then((r) => { if (cancelled) return; setArticles(r.articles); setCursor(r.next_cursor); })
      .catch((e) => { if (!cancelled) toast.error(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id, category, subcategory, kind, sourceType, sort, dir, q]);

  // Scoped search.
  useEffect(() => {
    setQInput(q);
    if (q.trim().length < 2) { setHits(null); return; }
    let cancelled = false;
    setSearching(true);
    api.get(`/api/trove-kb/search?q=${encodeURIComponent(q.trim())}&collection_id=${id}&limit=50${kind ? `&kind=${kind}` : ""}`)
      .then((r) => { if (!cancelled) setHits(r); })
      .catch((e) => { if (!cancelled) { setHits([]); toast.error(e.message); } })
      .finally(() => { if (!cancelled) setSearching(false); });
    return () => { cancelled = true; };
  }, [id, q, kind]);

  async function loadMore() {
    if (!cursor) return;
    setMore(true);
    try {
      const r = await api.get(`/api/trove-kb/articles?collection_id=${id}&category=${encodeURIComponent(category)}&subcategory=${encodeURIComponent(subcategory)}&kind=${kind}&source_type=${sourceType}&sort=${sort}&dir=${dir}&limit=50&cursor=${encodeURIComponent(cursor)}`);
      setArticles((a) => [...a, ...r.articles]);
      setCursor(r.next_cursor);
    } catch (e) { toast.error(e.message); }
    finally { setMore(false); }
  }

  const selected = useMemo(() => collection?.categories.find((c) => c.category === category) || null, [collection, category]);
  const total = collection?.articles ?? null;

  if (error) {
    return (
      <div className="max-w-5xl mx-auto p-6">
        <div className="text-xs text-fg-muted mb-3"><Link to="/kb" className="hover:underline">Knowledge Base</Link></div>
        <div className="rounded-lg border border-border bg-surface p-8 text-center text-fg-muted">{error}</div>
      </div>
    );
  }

  // Document types: article vs runbook from `kinds`, and the source
  // format (PDF, Word, native) from `source_types` once Trove KB reports it.
  // Shown only when there is more than one thing to choose between.
  const kinds = collection?.kinds || null;
  const hasKinds = kinds && kinds.article > 0 && kinds.runbook > 0;
  const sourceTypes = (collection?.source_types || []).filter((t) => t.articles > 0);
  const hasSources = sourceTypes.length > 1;
  const SOURCE_LABEL = { md: "Article", html: "Article", txt: "Text", pdf: "PDF", docx: "Word", doc: "Word", xlsx: "Excel", pptx: "PowerPoint" };
  const seg = (active, onClick, label, count) => (
    <button key={label} onClick={onClick} className={`px-2 py-1 rounded text-xs inline-flex items-center gap-1 ${active ? "bg-accent/10 text-accent font-medium" : "text-fg-muted hover:bg-surface-2 hover:text-fg"}`}>
      {label}{count != null && <span className="font-mono text-[10px] opacity-70">{count}</span>}
    </button>
  );
  const typeBlock = collection && (hasKinds || hasSources) && (
    <div className="pb-2 mb-2 border-b border-border space-y-1">
      <div className="px-2 text-[10px] uppercase tracking-wide text-fg-dim">Type</div>
      {hasKinds && (
        <div className="flex flex-wrap gap-1 px-1">
          {seg(!kind, () => set({ kind: "" }), "All", kinds.article + kinds.runbook)}
          {seg(kind === "article", () => set({ kind: "article" }), "Articles", kinds.article)}
          {seg(kind === "runbook", () => set({ kind: "runbook" }), "Runbooks", kinds.runbook)}
        </div>
      )}
      {hasSources && (
        <div className="flex flex-wrap gap-1 px-1">
          {seg(!sourceType, () => set({ source_type: "" }), "Any format", null)}
          {sourceTypes.map((t) => seg(sourceType === t.source_type, () => set({ source_type: t.source_type }), SOURCE_LABEL[t.source_type] || t.source_type.toUpperCase(), t.articles))}
        </div>
      )}
    </div>
  );

  const rail = collection && (
    <nav className="space-y-0.5 text-sm">
      {typeBlock}
      <button onClick={() => { set({ category: "", subcategory: "" }); setRailOpen(false); }} className={`w-full text-left px-2 py-1.5 rounded flex items-center justify-between ${!category ? "bg-accent/10 text-accent font-medium" : "text-fg-muted hover:bg-surface-2 hover:text-fg"}`}>
        <span>All articles</span>{total != null && <span className="text-[11px] font-mono">{total}</span>}
      </button>
      {collection.categories.map((c) => (
        <div key={c.category || "~"}>
          <button onClick={() => { set({ category: c.category, subcategory: "" }); setRailOpen(false); }} className={`w-full text-left px-2 py-1.5 rounded flex items-center justify-between gap-2 ${category === c.category && !subcategory ? "bg-accent/10 text-accent font-medium" : "text-fg-muted hover:bg-surface-2 hover:text-fg"}`}>
            <span className="truncate">{c.category || "Uncategorized"}</span><span className="text-[11px] font-mono flex-shrink-0">{c.articles}</span>
          </button>
          {category === c.category && c.subcategories.length > 0 && (
            <div className="ml-3 border-l border-border pl-2 space-y-0.5 my-0.5">
              {c.subcategories.map((sc) => (
                <button key={sc.subcategory} onClick={() => { set({ category: c.category, subcategory: sc.subcategory }); setRailOpen(false); }} className={`w-full text-left px-2 py-1 rounded text-xs flex items-center justify-between gap-2 ${subcategory === sc.subcategory ? "bg-accent/10 text-accent font-medium" : "text-fg-muted hover:bg-surface-2 hover:text-fg"}`}>
                  <span className="truncate">{sc.subcategory}</span><span className="font-mono flex-shrink-0">{sc.articles}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </nav>
  );

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-4">
      <div className="text-xs text-fg-muted">
        <Link to="/kb" className="hover:underline">Knowledge Base</Link>
        <span className="mx-1">/</span>
        <span className="text-fg">{collection?.name || "…"}</span>
        {category && <><span className="mx-1">/</span>{category || "Uncategorized"}</>}
        {subcategory && <><span className="mx-1">/</span>{subcategory}</>}
      </div>

      <header className="flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-[240px]">
          <h1 className="text-2xl font-semibold tracking-tight text-fg flex items-center gap-2">
            {collection?.name || "Loading…"}
            {collection && (
              <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${collection.scope === "public" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" : "bg-brand/10 text-brand"}`}>{collection.scope === "public" ? "Public" : "Internal"}</span>
            )}
          </h1>
          {collection?.description && <p className="text-sm text-fg-muted mt-1">{collection.description}</p>}
          {collection?.site_url && <a href={collection.site_url} target="_blank" rel="noreferrer" className="text-xs text-brand hover:underline">Source site ↗</a>}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); set({ q: qInput.trim() }); }} className="flex items-center gap-2 w-full sm:w-auto">
          <input type="search" value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder={`Search ${collection?.name || "this collection"}…`} className="flex-1 sm:w-72 bg-surface-2 border border-border rounded px-3 py-2 text-sm" />
          <button type="submit" className="btn btn-primary btn-sm">Search</button>
          {q && <button type="button" onClick={() => { setQInput(""); set({ q: "" }); }} className="text-xs text-fg-muted hover:text-fg">Clear</button>}
        </form>
      </header>

      <div className="flex gap-6 items-start">
        {/* Category rail: sticky on wide screens, a drawer toggle on phones */}
        <aside className="hidden lg:block w-64 flex-shrink-0 sticky top-4 max-h-[calc(100vh-6rem)] overflow-y-auto rounded-lg border border-border bg-surface p-2">{rail}</aside>
        <div className="flex-1 min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button onClick={() => setRailOpen((v) => !v)} className="lg:hidden btn btn-secondary btn-sm">☰ {category || "All categories"}</button>
            {!hasKinds && kind && (
              <button onClick={() => set({ kind: "" })} className="text-fg-muted hover:text-fg">× {kind === "runbook" ? "Runbooks" : "Articles"} only</button>
            )}
            {!q && (
              <select value={`${sort}:${dir}`} onChange={(e) => { const [s, d] = e.target.value.split(":"); set({ sort: s, dir: d }); }} className="bg-surface-2 border border-border rounded px-2 py-1">
                <option value="name:asc">Title A–Z</option><option value="name:desc">Title Z–A</option>
                <option value="modified:desc">Newest first</option><option value="modified:asc">Oldest first</option>
              </select>
            )}
            {selected && <span className="text-fg-dim">{selected.articles} in {selected.category || "Uncategorized"}</span>}
            <ViewToggle mode={view} onChange={setView} className="ml-auto" />
          </div>
          {railOpen && <div className="lg:hidden rounded-lg border border-border bg-surface p-2">{rail}</div>}

          {q.trim().length >= 2 ? (
            <div className="rounded-lg border border-border bg-surface">
              {searching ? <div className="p-4 text-sm text-fg-muted">Searching…</div>
                : !hits || hits.length === 0 ? <div className="p-6 text-sm text-fg-dim italic">No articles matched “{q}”.</div>
                : <Items items={hits} view={view} snippet />}
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-surface">
              {loading ? <div className="p-4 text-sm text-fg-muted">Loading…</div>
                : articles.length === 0 ? <div className="p-6 text-sm text-fg-dim italic">Nothing here.</div>
                : <Items items={articles} view={view} />}
              {cursor && !loading && (
                <div className="p-3 border-t border-border text-center">
                  <button onClick={loadMore} disabled={more} className="btn btn-secondary btn-sm">{more ? "Loading…" : "Load more"}</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Items({ items, view, snippet = false }) {
  if (view === "cards") {
    return (
      <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3 p-3">
        {items.map((a) => (
          <Link key={a.article_id} to={`/kb/article/${a.article_id}`} className="block rounded-lg border border-border bg-surface-2/40 hover:bg-surface-2 hover:border-accent/40 transition-colors p-4 group">
            <div className="flex items-start gap-2">
              <div className="text-sm font-medium text-fg group-hover:text-accent line-clamp-2 flex-1">{a.title}</div>
              {a.kind === "runbook" && <span className="flex-shrink-0 text-[9px] uppercase px-1 rounded bg-brand/10 text-brand">Runbook</span>}
            </div>
            <div className="text-[11px] text-fg-dim mt-1 truncate">{[a.category, a.subcategory].filter(Boolean).join(" · ")}</div>
            {snippet && a.snippet && <p className="text-xs text-fg-muted mt-2 line-clamp-3">{a.snippet}</p>}
            {a.date_modified && <div className="text-[11px] text-fg-dim mt-2">{new Date(a.date_modified).toLocaleDateString()}</div>}
          </Link>
        ))}
      </div>
    );
  }
  return <ul className="divide-y divide-border">{items.map((a) => <Row key={a.article_id} a={a} snippet={snippet} />)}</ul>;
}

function Row({ a, snippet = false }) {
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link to={`/kb/article/${a.article_id}`} className="text-sm font-medium text-fg hover:text-accent">{a.title}</Link>
        {a.kind === "runbook" && <span className="text-[9px] uppercase px-1 rounded bg-brand/10 text-brand">Runbook</span>}
        {a.date_modified && <span className="ml-auto text-[11px] text-fg-dim">{new Date(a.date_modified).toLocaleDateString()}</span>}
      </div>
      <div className="text-[11px] text-fg-dim mt-0.5">{[a.category, a.subcategory, snippet ? a.heading : null].filter(Boolean).join(" · ")}</div>
      {snippet && a.snippet && <p className="text-xs text-fg-muted mt-1 line-clamp-2">{a.snippet}</p>}
    </li>
  );
}

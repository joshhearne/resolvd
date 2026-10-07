import React, { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import MarkdownContent from "../components/MarkdownContent";

// Reads one Trove KB article inside Resolvd. The body is Markdown from
// Trove KB; images inside it are relative to Trove KB and need a signed-in
// Trove KB session, so the "Open in Trove KB" link is always offered.
export default function TroveKbArticle() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const ticketId = params.get("ticket");
  const [article, setArticle] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api.get(`/api/trove-kb/articles/${id}${ticketId ? `?ticket_id=${encodeURIComponent(ticketId)}` : ""}`)
      .then(setArticle)
      .catch((e) => { setError(e.message || "Failed to load"); if (e.status !== 404) toast.error(e.message); })
      .finally(() => setLoading(false));
  }, [id, ticketId]);

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-4">
      <div className="text-xs text-fg-muted">
        <Link to="/kb" className="hover:underline">Knowledge Base</Link>
        {article?.collection_name && <> <span className="mx-1">/</span> <Link to={`/kb/collection/${article.collection_id}`} className="hover:underline">{article.collection_name}</Link></>}
        {article?.category && <> <span className="mx-1">/</span> <Link to={`/kb/collection/${article.collection_id}?category=${encodeURIComponent(article.category)}${article.subcategory ? `&subcategory=${encodeURIComponent(article.subcategory)}` : ""}`} className="hover:underline">{article.category}{article.subcategory ? ` / ${article.subcategory}` : ""}</Link></>}
      </div>

      {loading ? (
        <div className="text-sm text-fg-muted">Loading…</div>
      ) : error ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center text-fg-muted">{error}</div>
      ) : (
        <article className="bg-surface border border-border rounded-lg p-6 space-y-4">
          <header className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${article.scope === "public" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" : "bg-brand/10 text-brand"}`}>
                {article.scope === "public" ? "Public" : "Internal"}
              </span>
              {article.collection_name && <span className="text-xs text-fg-muted">{article.collection_name}</span>}
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-fg">{article.title}</h1>
            <div className="flex flex-wrap gap-3 text-xs text-fg-dim">
              {article.date_modified && <span>Updated {new Date(article.date_modified).toLocaleDateString()}</span>}
              {article.staff_url && <a href={article.staff_url} target="_blank" rel="noreferrer" className="text-brand hover:underline">Open in Trove KB ↗</a>}
              {article.public_url && <a href={article.public_url} target="_blank" rel="noreferrer" className="text-brand hover:underline">Public link ↗</a>}
              {article.source_url && <a href={article.source_url} target="_blank" rel="noreferrer" className="hover:underline">Original source ↗</a>}
            </div>
          </header>

          {article.note && (
            <div className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">{article.note}</div>
          )}

          <div className="text-sm text-fg">
            <MarkdownContent>{article.body || "_This article has no text._"}</MarkdownContent>
          </div>

          {(article.attachments?.documents?.length > 0 || article.attachments?.images?.length > 0) && (
            <footer className="border-t border-border pt-3 text-xs text-fg-muted">
              This article has attachments. Open it in Trove KB to view them.
            </footer>
          )}
        </article>
      )}
    </div>
  );
}

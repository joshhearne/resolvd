import React, { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import { useAuth } from "../context/AuthContext";

const EDIT_ROLES = ["Admin", "Manager", "Tech"];

export default function KbProject() {
  const { projectId } = useParams();
  const { user } = useAuth();
  const canEdit = useMemo(() => EDIT_ROLES.includes(user?.role), [user]);

  const [project, setProject] = useState(null);
  const [articles, setArticles] = useState([]);
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [activeTags, setActiveTags] = useState([]);

  function buildArticlesUrl() {
    const parts = [];
    if (q) parts.push(`q=${encodeURIComponent(q)}`);
    if (statusFilter) parts.push(`status=${statusFilter}`);
    if (activeTags.length) parts.push(`tag=${encodeURIComponent(activeTags.join(","))}`);
    return `/api/kb/projects/${projectId}/articles${parts.length ? `?${parts.join("&")}` : ""}`;
  }

  async function load() {
    setLoading(true);
    try {
      const [p, list, tagList] = await Promise.all([
        api.get(`/api/projects/${projectId}`).catch(() => null),
        api.get(buildArticlesUrl()),
        api.get(`/api/kb/tags?project_id=${projectId}`).catch(() => []),
      ]);
      setProject(p);
      setArticles(list || []);
      setTags(tagList || []);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, statusFilter, activeTags]);

  function onSearchSubmit(e) {
    e.preventDefault();
    load();
  }

  function toggleTag(tag) {
    setActiveTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  }

  function clearTags() {
    setActiveTags([]);
  }

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <Link to="/kb" className="text-xs text-fg-muted hover:text-fg">
            ← Knowledge Base
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight text-fg mt-1">
            {project?.name || "Project"}
            <span className="ml-2 text-xs font-mono text-fg-dim align-middle">
              {project?.prefix}
            </span>
          </h1>
        </div>
        {canEdit && (
          <Link
            to={`/kb/${projectId}/new`}
            className="px-3 py-2 rounded-md text-sm font-medium bg-brand text-brand-fg hover:bg-brand-bright"
          >
            New article
          </Link>
        )}
      </header>

      <div className="flex gap-2 flex-wrap">
        <form onSubmit={onSearchSubmit} className="flex-1 min-w-[200px]">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search articles…"
            className="w-full px-3 py-2 rounded-md bg-surface border border-border text-fg placeholder:text-fg-dim focus:outline-none focus:ring-2 focus:ring-brand"
          />
        </form>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2 rounded-md bg-surface border border-border text-fg text-sm"
        >
          <option value="">Published + Draft</option>
          <option value="published">Published only</option>
          <option value="draft">Draft only</option>
          <option value="archived">Archived</option>
        </select>
      </div>

      {tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-fg-dim uppercase tracking-wider mr-1">Tags:</span>
          {tags.map((t) => {
            const active = activeTags.includes(t.tag);
            return (
              <button
                key={t.tag}
                type="button"
                onClick={() => toggleTag(t.tag)}
                className={`text-xs rounded-full px-2 py-0.5 border transition-colors ${
                  active
                    ? "bg-brand text-brand-fg border-brand"
                    : "bg-surface border-border text-fg-muted hover:bg-surface-2 hover:text-fg"
                }`}
              >
                {t.tag}
                <span className={`ml-1 ${active ? "opacity-80" : "text-fg-dim"}`}>
                  {t.article_count}
                </span>
              </button>
            );
          })}
          {activeTags.length > 0 && (
            <button
              type="button"
              onClick={clearTags}
              className="text-xs text-fg-dim hover:text-fg ml-1"
            >
              clear
            </button>
          )}
        </div>
      )}

      {loading ? (
        <div className="text-fg-muted text-sm">Loading…</div>
      ) : articles.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-10 text-center">
          <p className="text-fg-muted">
            {activeTags.length || q || statusFilter
              ? "No articles match these filters."
              : "No articles yet."}
          </p>
          {canEdit && !activeTags.length && !q && !statusFilter && (
            <Link
              to={`/kb/${projectId}/new`}
              className="inline-block mt-3 text-accent hover:underline text-sm"
            >
              Write the first one →
            </Link>
          )}
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface overflow-hidden">
          {articles.map((a) => (
            <li key={a.id} className="hover:bg-surface-2 transition-colors">
              <Link to={`/kb/${projectId}/${a.slug}`} className="block p-4">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-fg truncate">{a.title}</span>
                  {a.status !== "published" && (
                    <span
                      className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full font-mono ${
                        a.status === "draft"
                          ? "bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300"
                          : "bg-surface-2 text-fg-muted"
                      }`}
                    >
                      {a.status}
                    </span>
                  )}
                  {a.agent_only && (
                    <span
                      className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full font-mono bg-amber-200/70 dark:bg-amber-800/60 text-amber-900 dark:text-amber-100"
                      title="Agent-only: only project handlers see this article."
                    >
                      Agent only
                    </span>
                  )}
                  {a.tags?.length > 0 && (
                    <span className="flex flex-wrap gap-1">
                      {a.tags.map((t) => (
                        <span
                          key={t}
                          className={`text-[10px] rounded px-1.5 py-0.5 ${
                            activeTags.includes(t)
                              ? "bg-brand/20 text-brand"
                              : "bg-brand/10 text-brand"
                          }`}
                        >
                          {t}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
                {a.excerpt && (
                  <p className="mt-1 text-sm text-fg-muted line-clamp-2">{a.excerpt}</p>
                )}
                <div className="mt-2 flex items-center gap-3 text-xs text-fg-dim">
                  <span>{a.last_edited_by_name || "Unknown"}</span>
                  <span>·</span>
                  <span>{new Date(a.updated_at).toLocaleString()}</span>
                  {a.view_count > 0 && (
                    <>
                      <span>·</span>
                      <span>{a.view_count} views</span>
                    </>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

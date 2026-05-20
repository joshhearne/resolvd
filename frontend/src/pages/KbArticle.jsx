import React, { useEffect, useMemo, useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { api } from "../utils/api";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";

const EDIT_ROLES = ["Admin", "Manager", "Tech"];

// Mount BlockNote only after content_json is known; otherwise the hook
// captures an empty doc on first render and never picks up the loaded
// article body.
function ReadOnlyBody({ initialContent, resolvedTheme }) {
  const editor = useCreateBlockNote({ initialContent });
  return (
    <BlockNoteView
      editor={editor}
      editable={false}
      theme={resolvedTheme === "dark" ? "dark" : "light"}
    />
  );
}

export default function KbArticle() {
  const { projectId, slug } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { resolved } = useTheme();
  const canEdit = useMemo(() => EDIT_ROLES.includes(user?.role), [user]);

  const [article, setArticle] = useState(null);
  const [loading, setLoading] = useState(true);
  const [versions, setVersions] = useState(null);

  useEffect(() => {
    setLoading(true);
    api
      .get(`/api/kb/projects/${projectId}/articles/${slug}`)
      .then(setArticle)
      .catch((e) => {
        toast.error(e.message);
        if (e.status === 404) navigate(`/kb/${projectId}`);
      })
      .finally(() => setLoading(false));
  }, [projectId, slug, navigate]);

  const initialContent = useMemo(() => {
    if (!article) return undefined;
    const c = article.content_json;
    if (!c || (Array.isArray(c) && c.length === 0)) return undefined;
    return c;
  }, [article]);

  async function loadVersions() {
    if (versions) {
      setVersions(null);
      return;
    }
    try {
      const v = await api.get(`/api/kb/articles/${article.id}/versions`);
      setVersions(v);
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function archive() {
    if (!confirm("Archive this article? Editors can still find it under Archived filter.")) return;
    try {
      await api.delete(`/api/kb/articles/${article.id}`);
      toast.success("Archived");
      navigate(`/kb/${projectId}`);
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function restore(versionNo) {
    if (!confirm(`Restore version ${versionNo}? Current content will be saved as a new version first.`)) return;
    try {
      await api.post(`/api/kb/articles/${article.id}/restore/${versionNo}`);
      toast.success(`Restored v${versionNo}`);
      // Refetch
      const fresh = await api.get(`/api/kb/projects/${projectId}/articles/${slug}`);
      setArticle(fresh);
      setVersions(null);
    } catch (e) {
      toast.error(e.message);
    }
  }

  if (loading) return <div className="max-w-3xl mx-auto p-6 text-fg-muted">Loading…</div>;
  if (!article) return null;

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Link to={`/kb/${projectId}`} className="text-xs text-fg-muted hover:text-fg">
          ← Back to articles
        </Link>
        {canEdit && (
          <div className="flex gap-2">
            <button
              onClick={loadVersions}
              className="px-3 py-1.5 rounded-md text-sm bg-surface border border-border text-fg hover:bg-surface-2"
            >
              {versions ? "Hide history" : "History"}
            </button>
            <Link
              to={`/kb/${projectId}/${slug}/edit`}
              className="px-3 py-1.5 rounded-md text-sm font-medium bg-brand text-brand-fg hover:bg-brand-bright"
            >
              Edit
            </Link>
            <button
              onClick={archive}
              className="px-3 py-1.5 rounded-md text-sm bg-surface border border-border text-fg-muted hover:bg-surface-2"
            >
              Archive
            </button>
          </div>
        )}
      </div>

      <header className="space-y-2 border-b border-border pb-5">
        <div className="flex items-center gap-2 flex-wrap">
          {article.status !== "published" && (
            <span
              className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full font-mono ${
                article.status === "draft"
                  ? "bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300"
                  : "bg-surface-2 text-fg-muted"
              }`}
            >
              {article.status}
            </span>
          )}
          {article.agent_only && (
            <span
              className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full font-mono bg-amber-200/70 dark:bg-amber-800/60 text-amber-900 dark:text-amber-100"
              title="Visible only to project handlers (Admin / Manager / Tech globally, or agent / handler override on this project)."
            >
              Agent only
            </span>
          )}
          {article.kind === "runbook" && (
            <span
              className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full font-mono bg-brand/15 text-brand"
              title="Runbook — show on the ticket Runbook tab with checkboxes + canned-response pills."
            >
              Runbook
            </span>
          )}
        </div>
        <h1 className="text-3xl font-bold tracking-tight text-fg">{article.title}</h1>
        {article.tags?.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-1">
            {article.tags.map((t) => (
              <span key={t} className="text-xs bg-brand/10 text-brand rounded px-2 py-0.5">{t}</span>
            ))}
          </div>
        )}
        <div className="text-xs text-fg-dim flex flex-wrap gap-2">
          <span>By {article.author_name || "Unknown"}</span>
          <span>·</span>
          <span>Updated {new Date(article.updated_at).toLocaleString()}</span>
          {article.last_edited_by_name && article.last_edited_by_name !== article.author_name && (
            <>
              <span>·</span>
              <span>Last edited by {article.last_edited_by_name}</span>
            </>
          )}
        </div>
      </header>

      {versions && (
        <div className="rounded-lg border border-border bg-surface p-4">
          <h2 className="text-sm font-semibold text-fg mb-2">Version history</h2>
          <ul className="divide-y divide-border text-sm">
            {versions.map((v) => (
              <li key={v.id} className="py-2 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-fg font-mono text-xs">v{v.version_no}</div>
                  <div className="text-fg-muted text-xs truncate">
                    {v.change_summary || "No summary"} · {v.author_name || "Unknown"} ·{" "}
                    {new Date(v.created_at).toLocaleString()}
                  </div>
                </div>
                <button
                  onClick={() => restore(v.version_no)}
                  className="text-xs text-accent hover:underline shrink-0"
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <article className="kb-prose">
        <ReadOnlyBody
          key={article.id + ':' + article.updated_at}
          initialContent={initialContent}
          resolvedTheme={resolved}
        />
      </article>
    </div>
  );
}

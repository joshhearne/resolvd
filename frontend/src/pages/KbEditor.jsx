import React, { useEffect, useRef, useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { api } from "../utils/api";
import { useTheme } from "../context/ThemeContext";

// Editor body must mount AFTER initialContent is known, otherwise
// useCreateBlockNote captures an empty doc and never picks up the
// loaded article body. Isolating the editor in a child guarantees
// the hook runs once with the final initialContent.
function EditorBody({ initialContent, onReady, resolvedTheme }) {
  const editor = useCreateBlockNote({ initialContent });
  useEffect(() => {
    onReady(editor);
    // editor identity stable for life of mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <BlockNoteView
      editor={editor}
      theme={resolvedTheme === "dark" ? "dark" : "light"}
    />
  );
}

export default function KbEditor() {
  const { projectId, slug } = useParams();
  const navigate = useNavigate();
  const { resolved } = useTheme();
  const isNew = !slug;

  const [article, setArticle] = useState(null);
  const [title, setTitle] = useState("");
  const [slugInput, setSlugInput] = useState("");
  const [status, setStatus] = useState("draft");
  const [changeSummary, setChangeSummary] = useState("");
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const editorRef = useRef(null);

  useEffect(() => {
    if (isNew) return;
    setLoading(true);
    api
      .get(`/api/kb/projects/${projectId}/articles/${slug}`)
      .then((a) => {
        setArticle(a);
        setTitle(a.title);
        setSlugInput(a.slug);
        setStatus(a.status);
      })
      .catch((e) => {
        toast.error(e.message);
        navigate(`/kb/${projectId}`);
      })
      .finally(() => setLoading(false));
  }, [projectId, slug, isNew, navigate]);

  const initialContent = (() => {
    if (isNew) return undefined;
    if (!article) return undefined;
    const c = article.content_json;
    if (!c || (Array.isArray(c) && c.length === 0)) return undefined;
    return c;
  })();

  const editorReady = isNew || !!article;

  async function save(nextStatus = status) {
    if (!title.trim()) {
      toast.error("Title required");
      return;
    }
    if (!editorRef.current) {
      toast.error("Editor not ready");
      return;
    }
    setSaving(true);
    try {
      const content = editorRef.current.document;
      if (isNew) {
        const created = await api.post(`/api/kb/projects/${projectId}/articles`, {
          title: title.trim(),
          slug: slugInput.trim() || undefined,
          content_json: content,
          status: nextStatus,
        });
        toast.success("Created");
        navigate(`/kb/${projectId}/${created.slug}`);
      } else {
        const updated = await api.patch(`/api/kb/articles/${article.id}`, {
          title: title.trim(),
          slug: slugInput.trim(),
          content_json: content,
          status: nextStatus,
          change_summary: changeSummary.trim() || null,
        });
        toast.success("Saved");
        navigate(`/kb/${projectId}/${updated.slug}`);
      }
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="max-w-3xl mx-auto p-6 text-fg-muted">Loading…</div>;

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Link
          to={isNew ? `/kb/${projectId}` : `/kb/${projectId}/${slug}`}
          className="text-xs text-fg-muted hover:text-fg"
        >
          ← Cancel
        </Link>
        <div className="flex gap-2">
          <button
            disabled={saving}
            onClick={() => save("draft")}
            className="px-3 py-1.5 rounded-md text-sm bg-surface border border-border text-fg hover:bg-surface-2 disabled:opacity-50"
          >
            Save draft
          </button>
          <button
            disabled={saving}
            onClick={() => save("published")}
            className="px-3 py-1.5 rounded-md text-sm font-medium bg-brand text-brand-fg hover:bg-brand-bright disabled:opacity-50"
          >
            {status === "published" ? "Save" : "Publish"}
          </button>
        </div>
      </div>

      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Article title"
        className="w-full text-3xl font-bold tracking-tight bg-transparent text-fg placeholder:text-fg-dim focus:outline-none border-0 border-b border-border pb-2"
      />

      <div className="grid sm:grid-cols-2 gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-fg-muted text-xs uppercase tracking-wider">Slug</span>
          <input
            value={slugInput}
            onChange={(e) => setSlugInput(e.target.value)}
            placeholder="auto-generated from title"
            className="px-2 py-1 rounded bg-surface border border-border text-fg font-mono text-xs"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-fg-muted text-xs uppercase tracking-wider">Status</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="px-2 py-1 rounded bg-surface border border-border text-fg text-sm"
          >
            <option value="draft">Draft</option>
            <option value="published">Published</option>
            <option value="archived">Archived</option>
          </select>
        </label>
      </div>

      {!isNew && (
        <input
          value={changeSummary}
          onChange={(e) => setChangeSummary(e.target.value)}
          placeholder="What changed? (optional, shown in history)"
          className="w-full px-3 py-2 rounded-md bg-surface border border-border text-fg text-sm placeholder:text-fg-dim"
        />
      )}

      <div className="kb-editor rounded-lg border border-border min-h-[500px] py-4">
        {editorReady && (
          <EditorBody
            initialContent={initialContent}
            resolvedTheme={resolved}
            onReady={(e) => { editorRef.current = e; }}
          />
        )}
      </div>
    </div>
  );
}

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
  const [agentOnly, setAgentOnly] = useState(false);
  const [kind, setKind] = useState("article");
  const [changeSummary, setChangeSummary] = useState("");
  const [tags, setTags] = useState([]);
  const [tagDraft, setTagDraft] = useState("");
  const [keywords, setKeywords] = useState([]);
  const [keywordDraft, setKeywordDraft] = useState("");
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
        setAgentOnly(!!a.agent_only);
        setKind(a.kind || "article");
        setTags(a.tags || []);
        setKeywords(a.keywords || []);
      })
      .catch((e) => {
        toast.error(e.message);
        navigate(`/kb/${projectId}`);
      })
      .finally(() => setLoading(false));
  }, [projectId, slug, isNew, navigate]);

  function commitChip(setter, current, draft, setDraft) {
    const v = draft.trim().toLowerCase();
    if (!v) return;
    if (current.includes(v)) { setDraft(""); return; }
    setter([...current, v]);
    setDraft("");
  }
  function removeChip(setter, current, value) {
    setter(current.filter((c) => c !== value));
  }

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
          tags,
          keywords,
          agent_only: agentOnly,
          kind,
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
          tags,
          keywords,
          agent_only: agentOnly,
          kind,
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

      <div className="space-y-1">
        <span className="text-fg-muted text-xs uppercase tracking-wider">Tags</span>
        <div className="flex flex-wrap gap-1.5 items-center">
          {tags.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 text-xs bg-brand/10 text-brand rounded px-2 py-0.5">
              {t}
              <button
                type="button"
                onClick={() => removeChip(setTags, tags, t)}
                className="text-brand/70 hover:text-red-600"
                aria-label={`Remove tag ${t}`}
              >×</button>
            </span>
          ))}
          <input
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "," || e.key === "Tab") {
                e.preventDefault();
                commitChip(setTags, tags, tagDraft, setTagDraft);
              } else if (e.key === "Backspace" && !tagDraft && tags.length) {
                setTags(tags.slice(0, -1));
              }
            }}
            onBlur={() => commitChip(setTags, tags, tagDraft, setTagDraft)}
            placeholder="add tag (Enter / comma)"
            className="text-xs bg-transparent text-fg placeholder:text-fg-dim focus:outline-none px-1 py-0.5 min-w-[10rem]"
          />
        </div>
      </div>

      <details className="space-y-1">
        <summary className="cursor-pointer text-fg-muted text-xs uppercase tracking-wider">
          Boost match (keywords)
        </summary>
        <p className="text-[11px] text-fg-dim mt-1">
          Add extra terms to help the suggestion ranker tie articles to
          tickets when the title alone is too generic.
        </p>
        <div className="flex flex-wrap gap-1.5 items-center mt-1">
          {keywords.map((k) => (
            <span key={k} className="inline-flex items-center gap-1 text-xs bg-surface-2 text-fg-muted rounded px-2 py-0.5">
              {k}
              <button
                type="button"
                onClick={() => removeChip(setKeywords, keywords, k)}
                className="hover:text-red-600"
                aria-label={`Remove keyword ${k}`}
              >×</button>
            </span>
          ))}
          <input
            value={keywordDraft}
            onChange={(e) => setKeywordDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "," || e.key === "Tab") {
                e.preventDefault();
                commitChip(setKeywords, keywords, keywordDraft, setKeywordDraft);
              } else if (e.key === "Backspace" && !keywordDraft && keywords.length) {
                setKeywords(keywords.slice(0, -1));
              }
            }}
            onBlur={() => commitChip(setKeywords, keywords, keywordDraft, setKeywordDraft)}
            placeholder="add keyword (Enter / comma)"
            className="text-xs bg-transparent text-fg placeholder:text-fg-dim focus:outline-none px-1 py-0.5 min-w-[10rem]"
          />
        </div>
      </details>

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
        <label className="flex flex-col gap-1">
          <span className="text-fg-muted text-xs uppercase tracking-wider">Kind</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="px-2 py-1 rounded bg-surface border border-border text-fg text-sm"
            title="Article = freeform docs. Runbook = checklist + canned-response pills, shown on the ticket Runbook tab."
          >
            <option value="article">Article</option>
            <option value="runbook">Runbook</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-fg-muted text-xs uppercase tracking-wider">Visibility</span>
          <label
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-surface border border-border text-fg text-sm cursor-pointer select-none"
            title="When on, only project handlers (global Admin/Manager/Tech or project agent/handler-override) can read or write this article. Only an Admin can delete it."
          >
            <input
              type="checkbox"
              checked={agentOnly}
              onChange={(e) => setAgentOnly(e.target.checked)}
            />
            <span>Agent only</span>
          </label>
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

import React, { useEffect, useState, useCallback } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";

// Lightweight BlockNote-JSON walker scoped to what runbooks actually
// use. Heavy lifting (tables, embeds, etc.) stays in the KB article
// view; here we render headings, paragraphs, ordered + bulleted lists
// (with nesting via block.children), checklist items with persistent
// boxes, fenced code blocks with a copy affordance, inline links, and
// inline @canned:<title> pills that prefill the comment composer.
//
// flattenInline returns plain text for the cases where we only need a
// string — counting steps, scanning a checkListItem label for canned
// pills, etc. Rich rendering (links + styles) goes through renderInline.
function flattenInline(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(flattenInline).join("");
  if (typeof node === "object") {
    if (typeof node.text === "string") return node.text;
    if (node.content) return flattenInline(node.content);
  }
  return "";
}

// Walk BlockNote inline content and emit React nodes. Recognises:
//   - { type:'text', text, styles:{bold,italic,code,strike,underline} }
//   - { type:'link', href, content:[…] } — clickable, opens in new tab
// Anything unrecognised falls back to its `.text` field or recurses
// into `.content` so future BlockNote features at least render their
// text instead of disappearing.
function renderInline(content, keyPrefix = "i") {
  if (content == null) return null;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((n, i) => (
      <React.Fragment key={`${keyPrefix}-${i}`}>
        {renderInline(n, `${keyPrefix}-${i}`)}
      </React.Fragment>
    ));
  }
  if (typeof content !== "object") return null;
  if (content.type === "link" && content.href) {
    return (
      <a
        href={content.href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-brand hover:underline break-all"
      >
        {renderInline(content.content, `${keyPrefix}-l`)}
      </a>
    );
  }
  if (typeof content.text === "string") {
    let node = content.text;
    const s = content.styles || {};
    if (s.code) node = (
      <code className="bg-surface px-1 py-0.5 rounded text-[0.85em] font-mono border border-border text-brand">{node}</code>
    );
    if (s.bold) node = <strong className="font-semibold">{node}</strong>;
    if (s.italic) node = <em className="italic">{node}</em>;
    if (s.strike) node = <s>{node}</s>;
    if (s.underline) node = <u>{node}</u>;
    return node;
  }
  if (content.content) return renderInline(content.content, keyPrefix);
  return null;
}

// Splits text on `@canned:<title>` tokens. Multi-word titles are
// supported — convention is that the canned reference is the LAST
// thing on a step line (BlockNote stores each step as one block, so
// "end of line" = end of the rendered text run). Title eats up to
// the end of the string; trim whitespace. Author wraps with a
// bracket pair `@canned:[Vendor escalation]` if they need text to
// follow the pill on the same step.
function tokenizeCannedPills(text) {
  if (!text) return [];
  // Bracketed form `@canned:[Title]` — explicit boundary, can sit
  // mid-line. Pull these out first.
  const bracketRe = /@canned:\[([^\]\n]+)\]/g;
  const parts = [];
  let lastIdx = 0;
  let m;
  while ((m = bracketRe.exec(text)) !== null) {
    if (m.index > lastIdx) parts.push({ kind: "text", value: text.slice(lastIdx, m.index) });
    parts.push({ kind: "canned", value: m[1].trim() });
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) parts.push({ kind: "text", value: text.slice(lastIdx) });

  // Bare form `@canned:Title text` — title runs to end-of-string
  // within the same text run. BlockNote step blocks render as a
  // single line so "end of string" = "end of step".
  const tailRe = /@canned:(.+?)\s*$/;
  const out = [];
  for (const part of parts) {
    if (part.kind !== "text") { out.push(part); continue; }
    const tail = tailRe.exec(part.value);
    if (!tail) { out.push(part); continue; }
    if (tail.index > 0) out.push({ kind: "text", value: part.value.slice(0, tail.index) });
    out.push({ kind: "canned", value: tail[1].trim() });
  }
  return out;
}

// Renders inline content: text runs (with styles + canned-pill
// tokenisation), and link nodes (passed through to renderInline so
// they stay clickable). Pill detection only fires on plain-text
// segments — a URL inside a link node never matches @canned syntax.
function InlineRow({ content, cannedByTitle, onCannedClick }) {
  const items = Array.isArray(content) ? content : (content ? [content] : []);
  return (
    <span>
      {items.map((node, idx) => {
        if (node && node.type === "link" && node.href) {
          return (
            <React.Fragment key={`l-${idx}`}>
              {renderInline(node, `l-${idx}`)}
            </React.Fragment>
          );
        }
        const text = typeof node === "string"
          ? node
          : (typeof node?.text === "string" ? node.text : "");
        if (!text) {
          // Unrecognised inline shape — try renderInline so styled text
          // / nested inline content still appears instead of vanishing.
          return (
            <React.Fragment key={`x-${idx}`}>
              {renderInline(node, `x-${idx}`)}
            </React.Fragment>
          );
        }
        const styles = node?.styles || {};
        const parts = tokenizeCannedPills(text);
        return (
          <React.Fragment key={`t-${idx}`}>
            {parts.map((p, i) => {
              if (p.kind === "text") {
                let frag = p.value;
                if (styles.code) frag = (
                  <code className="bg-surface px-1 py-0.5 rounded text-[0.85em] font-mono border border-border text-brand">{frag}</code>
                );
                if (styles.bold) frag = <strong className="font-semibold">{frag}</strong>;
                if (styles.italic) frag = <em className="italic">{frag}</em>;
                if (styles.strike) frag = <s>{frag}</s>;
                if (styles.underline) frag = <u>{frag}</u>;
                return <React.Fragment key={i}>{frag}</React.Fragment>;
              }
              const canned = cannedByTitle.get(p.value.toLowerCase());
              if (canned) {
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => onCannedClick(canned)}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded text-[11px] bg-brand/10 text-brand hover:bg-brand/20"
                    title={`Apply canned response "${canned.title}" to the comment composer`}
                  >
                    📋 {canned.title}
                  </button>
                );
              }
              return (
                <span key={i} className="inline-block px-1 mx-0.5 rounded text-[11px] bg-surface-2 text-fg-dim"
                  title="Canned response not found in this project's scope">
                  @canned:{p.value} (?)
                </span>
              );
            })}
          </React.Fragment>
        );
      })}
    </span>
  );
}

// Fenced code-block renderer. Shows the language badge (if any) in the
// top-right corner and exposes a copy-to-clipboard button on hover —
// same affordance as MarkdownContent. Code blocks in runbooks are
// commonly templated vendor-email bodies; the copy button is the whole
// point of putting them in a fenced block.
function CodeBlockRow({ block }) {
  const [copied, setCopied] = React.useState(false);
  const code = flattenInline(block.content).replace(/\n$/, "");
  const lang = block.props?.language;
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API blocked (insecure context, etc.) — user can
      // still select + copy by hand.
    }
  }
  return (
    <div className="relative group my-2">
      {lang && (
        <span className="absolute top-1.5 right-14 text-[10px] font-mono uppercase tracking-wide text-fg-dim bg-surface-2 border border-border rounded px-1.5 py-0.5 pointer-events-none select-none">
          {lang}
        </span>
      )}
      <button
        type="button"
        onClick={copy}
        className="absolute top-1.5 right-1.5 text-[10px] font-mono uppercase tracking-wide text-fg-muted hover:text-fg bg-surface-2 hover:bg-surface border border-border rounded px-1.5 py-0.5 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
        aria-label="Copy code"
        title="Copy code"
      >
        {copied ? "✓" : "Copy"}
      </button>
      <pre className="bg-surface border border-border rounded-lg p-3 overflow-x-auto text-xs font-mono text-fg leading-relaxed whitespace-pre-wrap">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function HeadingBlock({ block, opts }) {
  const level = Math.min(3, Math.max(1, block.props?.level || 2));
  const Tag = `h${level + 1}`; // h2/h3/h4 — keep page hierarchy sane
  return (
    <Tag className="font-semibold text-fg mt-3 mb-1 text-sm">
      <InlineRow content={block.content} cannedByTitle={opts.cannedByTitle} onCannedClick={opts.onCannedClick} />
    </Tag>
  );
}

function ParagraphBlock({ block, opts }) {
  return (
    <p className="text-sm text-fg leading-relaxed my-1">
      <InlineRow content={block.content} cannedByTitle={opts.cannedByTitle} onCannedClick={opts.onCannedClick} />
    </p>
  );
}

function CheckListBlock({ block, opts }) {
  const id = block.id || `b-${Math.random().toString(36).slice(2, 9)}`;
  const state = opts.stepStates[id] || {};
  return (
    <label className="flex items-start gap-2 py-1 cursor-pointer hover:bg-surface-2/50 rounded px-1">
      <input
        type="checkbox"
        checked={!!state.checked}
        onChange={(e) => opts.setStep(id, e.target.checked)}
        className="mt-1 flex-shrink-0"
      />
      <div className="flex-1 text-sm">
        <InlineRow content={block.content} cannedByTitle={opts.cannedByTitle} onCannedClick={opts.onCannedClick} />
        {state.checked && state.checked_by_name && (
          <span className="ml-2 text-[10px] text-fg-dim">
            ✓ {state.checked_by_name}
            {state.checked_at && ` · ${new Date(state.checked_at).toLocaleString()}`}
          </span>
        )}
        {Array.isArray(block.children) && block.children.length > 0 && (
          <div className="mt-1">{renderBlocks(block.children, opts)}</div>
        )}
      </div>
    </label>
  );
}

// Walk a flat sequence of BlockNote blocks and emit React nodes.
// Consecutive numberedListItem / bulletListItem siblings get grouped
// into a single <ol> / <ul> so list numbering stays continuous and
// the markers (decimal / disc) render. block.children carries any
// indented sub-items — recurse with the same grouping logic so a
// nested numbered list under step 3 renders as its own <ol> inside
// that <li>.
function renderBlocks(blocks, opts) {
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  const out = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    if (b?.type === "numberedListItem" || b?.type === "bulletListItem") {
      const listType = b.type;
      const group = [];
      while (i < blocks.length && blocks[i]?.type === listType) {
        group.push(blocks[i]);
        i++;
      }
      const ordered = listType === "numberedListItem";
      const ListTag = ordered ? "ol" : "ul";
      const listClass = ordered
        ? "list-decimal list-outside ml-6 my-1 space-y-0.5"
        : "list-disc list-outside ml-6 my-1 space-y-0.5";
      out.push(
        <ListTag key={`list-${i}-${group[0]?.id || ""}`} className={listClass}>
          {group.map((item, idx) => (
            <li key={item.id || idx} className="text-sm text-fg">
              <InlineRow
                content={item.content}
                cannedByTitle={opts.cannedByTitle}
                onCannedClick={opts.onCannedClick}
              />
              {Array.isArray(item.children) && item.children.length > 0
                && renderBlocks(item.children, opts)}
            </li>
          ))}
        </ListTag>
      );
      continue;
    }
    out.push(<BlockRow key={b?.id || `b-${i}`} block={b} opts={opts} />);
    i++;
  }
  return out;
}

function BlockRow({ block, opts }) {
  if (!block) return null;
  if (block.type === "heading") return <HeadingBlock block={block} opts={opts} />;
  if (block.type === "checkListItem") return <CheckListBlock block={block} opts={opts} />;
  if (block.type === "codeBlock") return <CodeBlockRow block={block} />;
  return <ParagraphBlock block={block} opts={opts} />;
}

export default function RunbookPanel({ ticket, user, projectMembers, onApplyCanned }) {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [available, setAvailable] = useState([]);
  const [canned, setCanned] = useState([]);
  const ticketId = ticket?.id;
  const projectId = ticket?.project_id;

  const userById = React.useMemo(() => {
    const m = new Map();
    (projectMembers || []).forEach((mem) => {
      if (mem?.user_id) m.set(mem.user_id, mem.display_name || mem.email);
    });
    if (user?.id) m.set(user.id, user.displayName || user.email || `user-${user.id}`);
    return m;
  }, [projectMembers, user]);

  const cannedByTitle = React.useMemo(() => {
    const m = new Map();
    canned.forEach((c) => m.set(String(c.title || "").toLowerCase(), c));
    return m;
  }, [canned]);

  const loadRuns = useCallback(async () => {
    if (!ticketId) return;
    setLoading(true);
    try {
      const list = await api.get(`/api/kb/tickets/${ticketId}/runbook-runs`);
      setRuns(Array.isArray(list) ? list : []);
    } catch {
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }, [ticketId]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  // Canned-response list — needed to resolve @canned:<title> pills.
  // Loaded once per project change; project-scoped picker.
  useEffect(() => {
    if (!projectId) return;
    api.get(`/api/canned-responses?project_id=${projectId}`)
      .then((c) => setCanned(Array.isArray(c) ? c : []))
      .catch(() => setCanned([]));
  }, [projectId]);

  async function openPicker() {
    setPickerOpen(true);
    try {
      const list = await api.get(`/api/kb/projects/${projectId}/articles?kind=runbook&status=published`);
      const running = new Set(runs.map((r) => r.article_id));
      setAvailable((Array.isArray(list) ? list : []).filter((a) => !running.has(a.id)));
    } catch (e) {
      toast.error(e.message);
      setAvailable([]);
    }
  }

  async function startRun(articleId) {
    try {
      await api.post(`/api/kb/tickets/${ticketId}/runbook-runs`, { article_id: articleId });
      setPickerOpen(false);
      await loadRuns();
      toast.success("Runbook started");
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function setStep(run, stepId, checked) {
    const patch = {
      [stepId]: checked
        ? {
            checked: true,
            checked_by: user?.id || null,
            checked_by_name: user?.displayName || user?.email || null,
            checked_at: new Date().toISOString(),
          }
        : { checked: false, checked_by: null, checked_by_name: null, checked_at: null },
    };
    // Optimistic.
    setRuns((prev) =>
      prev.map((r) =>
        r.article_id === run.article_id
          ? { ...r, step_states: { ...(r.step_states || {}), ...patch } }
          : r,
      ),
    );
    try {
      await api.patch(`/api/kb/tickets/${ticketId}/runbook-runs/${run.article_id}`, {
        step_states: patch,
      });
    } catch (e) {
      toast.error(e.message);
      loadRuns();
    }
  }

  async function resetRun(run) {
    if (!window.confirm(`Reset "${run.title}"? All checkboxes will be cleared.`)) return;
    try {
      await api.delete(`/api/kb/tickets/${ticketId}/runbook-runs/${run.article_id}`);
      await loadRuns();
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function toggleComplete(run, next) {
    try {
      await api.patch(`/api/kb/tickets/${ticketId}/runbook-runs/${run.article_id}`, { completed: next });
      await loadRuns();
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function handleCannedClick(canned) {
    try {
      const r = await api.post(`/api/canned-responses/${canned.id}/render`, { ticket_id: ticketId });
      onApplyCanned?.(r.rendered || r.source_body || "");
      toast.success(`Applied "${canned.title}" to the comment composer`);
    } catch (e) {
      toast.error(e.message);
    }
  }

  if (loading) {
    return <div className="p-4 text-sm text-fg-dim">Loading runbooks…</div>;
  }

  return (
    <div className="p-4 space-y-4">
      <div className="text-xs text-fg-muted bg-brand/5 border border-brand/20 rounded px-2 py-1.5">
        Runbooks are checklists you can run against this ticket. Boxes are persisted per-ticket so
        a handoff picks up where the last handler left off. Canned-response pills inside steps
        prefill the Comment composer when clicked.
      </div>

      {runs.length === 0 && !pickerOpen && (
        <div className="text-sm text-fg-dim text-center py-6 border border-dashed border-border rounded">
          No runbooks running on this ticket yet.
        </div>
      )}

      {runs.map((run) => {
        const blocks = Array.isArray(run.content_json) ? run.content_json : [];
        const stepStatesEnriched = {};
        for (const [k, v] of Object.entries(run.step_states || {})) {
          stepStatesEnriched[k] = {
            ...v,
            checked_by_name: v?.checked_by_name
              || (v?.checked_by && userById.get(v.checked_by))
              || null,
          };
        }
        const totalSteps = blocks.filter((b) => b.type === "checkListItem").length;
        const doneSteps = blocks.filter((b) => b.type === "checkListItem"
          && stepStatesEnriched[b.id]?.checked).length;
        return (
          <div key={run.article_id} className="border border-border rounded-lg bg-surface p-3 space-y-2">
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-fg">{run.title}</span>
                  <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full font-mono bg-brand/15 text-brand">
                    Runbook
                  </span>
                  {run.agent_only && (
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full font-mono bg-amber-200/70 dark:bg-amber-800/60 text-amber-900 dark:text-amber-100">
                      Agent only
                    </span>
                  )}
                  {run.completed_at && (
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full font-mono bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                      Complete
                    </span>
                  )}
                </div>
                <div className="text-xs text-fg-dim mt-0.5">
                  Started by {run.started_by_name || "unknown"}
                  {run.started_at && ` · ${new Date(run.started_at).toLocaleString()}`}
                  {totalSteps > 0 && ` · ${doneSteps}/${totalSteps} steps`}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  type="button"
                  onClick={() => toggleComplete(run, !run.completed_at)}
                  className="text-xs text-fg-muted hover:text-brand"
                >
                  {run.completed_at ? "Reopen" : "Mark complete"}
                </button>
                <button
                  type="button"
                  onClick={() => resetRun(run)}
                  className="text-xs text-fg-dim hover:text-red-500"
                >
                  Reset
                </button>
              </div>
            </div>
            <div className="space-y-1.5 pt-2 border-t border-border">
              {blocks.length === 0 && (
                <p className="text-xs text-fg-dim italic">(empty runbook)</p>
              )}
              {renderBlocks(blocks, {
                stepStates: stepStatesEnriched,
                setStep: (stepId, checked) => setStep(run, stepId, checked),
                cannedByTitle,
                onCannedClick: handleCannedClick,
              })}
            </div>
          </div>
        );
      })}

      {pickerOpen && (
        <div className="border border-border rounded-lg bg-surface-2 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-fg">Start a runbook</span>
            <button
              type="button"
              onClick={() => setPickerOpen(false)}
              className="text-xs text-fg-dim hover:text-fg"
            >
              Cancel
            </button>
          </div>
          {available.length === 0 ? (
            <p className="text-xs text-fg-dim">
              No published runbooks in this project. Create one in Knowledge Base with Kind=Runbook.
            </p>
          ) : (
            <ul className="divide-y divide-border border border-border rounded bg-bg">
              {available.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => startRun(a.id)}
                    className="block w-full text-left px-3 py-2 hover:bg-surface-2"
                  >
                    <div className="text-sm font-medium text-fg">{a.title}</div>
                    {a.excerpt && (
                      <div className="text-xs text-fg-muted truncate">{a.excerpt}</div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div>
        <button
          type="button"
          onClick={openPicker}
          className="btn btn-secondary"
        >
          + Start a runbook
        </button>
      </div>
    </div>
  );
}

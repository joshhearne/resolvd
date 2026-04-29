import { useState, useRef } from "react";
import MentionTextarea from "./MentionTextarea";
import MarkdownContent from "./MarkdownContent";

// Apply markdown wrapping to selected text in a textarea.
// Returns { value, selStart, selEnd } with updated string and cursor.
function applyFormat(el, value, fmt) {
  const start = el.selectionStart;
  const end = el.selectionEnd;
  const selected = value.slice(start, end);

  let before = value.slice(0, start);
  let after = value.slice(end);
  let insert = "";
  let cursorOffset = 0;

  switch (fmt) {
    case "bold":
      insert = `**${selected || "bold text"}**`;
      cursorOffset = selected ? insert.length : 2;
      break;
    case "italic":
      insert = `_${selected || "italic text"}_`;
      cursorOffset = selected ? insert.length : 1;
      break;
    case "code":
      insert = `\`${selected || "code"}\``;
      cursorOffset = selected ? insert.length : 1;
      break;
    case "codeblock": {
      const nl = before.length && !before.endsWith("\n") ? "\n" : "";
      insert = `${nl}\`\`\`\n${selected || "code here"}\n\`\`\`\n`;
      cursorOffset = selected ? insert.length : nl.length + 4;
      break;
    }
    case "link":
      insert = selected ? `[${selected}](url)` : "[link text](url)";
      cursorOffset = selected ? insert.length - 1 : 1;
      break;
    case "heading":
      if (!before.endsWith("\n") && before.length) before += "\n";
      insert = `## ${selected || "Heading"}`;
      cursorOffset = insert.length;
      break;
    case "bullet":
      if (!before.endsWith("\n") && before.length) before += "\n";
      insert = `- ${selected || "item"}`;
      cursorOffset = insert.length;
      break;
    case "numbered":
      if (!before.endsWith("\n") && before.length) before += "\n";
      insert = `1. ${selected || "item"}`;
      cursorOffset = insert.length;
      break;
    case "quote":
      if (!before.endsWith("\n") && before.length) before += "\n";
      insert = `> ${selected || "quote"}`;
      cursorOffset = insert.length;
      break;
    default:
      return null;
  }

  const newValue = before + insert + after;
  const newCursor = before.length + cursorOffset;
  return { value: newValue, selStart: newCursor, selEnd: newCursor };
}

const TOOLS = [
  { id: "bold",      label: "B",   title: "Bold (Ctrl+B)",        style: "font-bold" },
  { id: "italic",    label: "I",   title: "Italic (Ctrl+I)",       style: "italic" },
  { id: "code",      label: "</>", title: "Inline code (Ctrl+`)",  style: "" },
  { id: "codeblock", label: "{ }", title: "Code block",            style: "" },
  { id: "sep" },
  { id: "heading",   label: "H",   title: "Heading",               style: "font-bold text-xs", mobileHide: true },
  { id: "bullet",    label: "•—",  title: "Bullet list",           style: "" },
  { id: "numbered",  label: "1.",  title: "Numbered list",         style: "", mobileHide: true },
  { id: "quote",     label: "❝",   title: "Blockquote",            style: "", mobileHide: true },
  { id: "sep" },
  { id: "link",      label: "🔗",  title: "Link",                  style: "", mobileHide: true },
];

export default function MarkdownEditor({
  value,
  onChange,
  onKeyDown,
  placeholder,
  rows = 5,
  className = "",
  mentionProjectId,   // if provided, use MentionTextarea instead of plain textarea
}) {
  const [tab, setTab] = useState("write");
  const ref = useRef(null);

  function format(fmt) {
    const el = ref.current;
    if (!el) return;
    const result = applyFormat(el, value, fmt);
    if (!result) return;
    onChange({ target: { value: result.value } });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(result.selStart, result.selEnd);
    });
  }

  function handleKeyDown(e) {
    if (e.ctrlKey || e.metaKey) {
      if (e.key === "b") { e.preventDefault(); format("bold"); return; }
      if (e.key === "i") { e.preventDefault(); format("italic"); return; }
      if (e.key === "`") { e.preventDefault(); format("code"); return; }
    }
    onKeyDown?.(e);
  }

  const inputClass =
    "w-full border border-border-strong rounded-b-md rounded-tr-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40 " +
    className;

  return (
    <div className="w-full">
      {/* Tabs + toolbar row */}
      <div className="flex items-center border border-border-strong rounded-t-md bg-surface-2 px-2 pt-1 gap-2 overflow-x-auto">
        <div className="flex gap-1 flex-shrink-0">
          {["write", "preview"].map(t => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-2 py-1 text-xs rounded-t font-medium transition-colors ${
                tab === t
                  ? "bg-bg text-fg border border-b-0 border-border-strong -mb-px"
                  : "text-fg-muted hover:text-fg"
              }`}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        {tab === "write" && (
          <div className="flex items-center gap-0.5 flex-shrink-0 ml-auto">
            {TOOLS.map((tool, i) =>
              tool.id === "sep" ? (
                <span key={i} className="w-px h-4 bg-border mx-1 hidden sm:block" />
              ) : (
                <button
                  key={tool.id}
                  type="button"
                  title={tool.title}
                  onClick={() => format(tool.id)}
                  className={`px-2 py-1 text-xs text-fg-muted hover:text-fg hover:bg-surface rounded transition-colors touch-manipulation ${tool.style} ${tool.mobileHide ? "hidden sm:inline-flex" : ""}`}
                >
                  {tool.label}
                </button>
              )
            )}
          </div>
        )}
      </div>

      {/* Input or preview */}
      {tab === "write" ? (
        mentionProjectId !== undefined ? (
          <MentionTextarea
            ref={ref}
            value={value}
            onChange={onChange}
            onKeyDown={handleKeyDown}
            rows={rows}
            placeholder={placeholder}
            projectId={mentionProjectId}
            className={inputClass}
          />
        ) : (
          <textarea
            ref={ref}
            value={value}
            onChange={onChange}
            onKeyDown={handleKeyDown}
            rows={rows}
            placeholder={placeholder}
            className={inputClass}
          />
        )
      ) : (
        <div className="border border-border-strong border-t-0 rounded-b-md px-3 py-2 min-h-[80px] bg-bg">
          {value.trim() ? (
            <MarkdownContent>{value}</MarkdownContent>
          ) : (
            <span className="text-xs text-fg-dim italic">Nothing to preview.</span>
          )}
        </div>
      )}
    </div>
  );
}

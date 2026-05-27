import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Walk a react-markdown child subtree and pull the raw text. We can't
// just read pre.textContent at render time because react-markdown gives
// us the parsed children, not the DOM — but the children for fenced
// code is a <code> whose own children is the raw string.
function extractText(node) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node.props?.children) return extractText(node.props.children);
  return "";
}

function CodeBlock({ children, lang }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      const text = extractText(children).replace(/\n$/, "");
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API blocked (e.g. cross-origin iframe, insecure context).
      // Fall back silently — user can still select + copy by hand.
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
      <pre className="bg-surface border border-border rounded-lg p-3 overflow-x-auto">
        {children}
      </pre>
    </div>
  );
}

export default function MarkdownContent({ children, className = "" }) {
  if (!children) return null;
  return (
    <div className={`markdown-body ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // react-markdown v9+ removed the `inline` prop on the code
          // component. Block code is now emitted as <pre><code class=
          // "language-X">…</code></pre>; bare inline backticks come
          // through as <code> with no language className. Detect by
          // className so backticks render inline instead of accidentally
          // hitting the <pre> branch and breaking the surrounding line.
          // <pre> wraps fenced blocks. We snoop the child <code>'s
          // language-* className so we can render a small "bash" /
          // "ps1" / "html" badge in the top-right corner of the block.
          // Helps readers (and pasted-into-email recipients) tell at a
          // glance what they're looking at. Unknown / no-language
          // fences render with no badge — same UX as before.
          pre({ children }) {
            const child = Array.isArray(children) ? children[0] : children;
            const cls = child?.props?.className || "";
            const m = /language-([\w+-]+)/.exec(cls);
            const lang = m ? m[1] : null;
            return <CodeBlock lang={lang}>{children}</CodeBlock>;
          },
          code({ className: cls, children: code, ...props }) {
            const isFenced = /language-/.test(cls || "");
            if (isFenced) {
              return (
                <code className={`text-xs font-mono text-fg leading-relaxed ${cls || ""}`} {...props}>
                  {code}
                </code>
              );
            }
            return (
              <code
                className="bg-surface px-1 py-0.5 rounded text-[0.85em] font-mono border border-border text-brand"
                {...props}
              >
                {code}
              </code>
            );
          },
          // Links open in new tab
          a({ href, children: link, ...props }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand hover:underline"
                {...props}
              >
                {link}
              </a>
            );
          },
          // Headings
          h1: ({ children: h }) => <h1 className="text-lg font-bold text-fg mt-3 mb-1">{h}</h1>,
          h2: ({ children: h }) => <h2 className="text-base font-bold text-fg mt-3 mb-1">{h}</h2>,
          h3: ({ children: h }) => <h3 className="text-sm font-bold text-fg mt-2 mb-1">{h}</h3>,
          // Lists
          ul: ({ children: c }) => <ul className="list-disc list-outside ml-4 my-1 space-y-0.5">{c}</ul>,
          ol: ({ children: c }) => <ol className="list-decimal list-outside ml-4 my-1 space-y-0.5">{c}</ol>,
          li: ({ children: c }) => <li className="text-fg">{c}</li>,
          // Blockquote
          blockquote: ({ children: c }) => (
            <blockquote className="border-l-2 border-brand/40 pl-3 my-2 text-fg-muted italic">{c}</blockquote>
          ),
          // Paragraph
          p: ({ children: c }) => <p className="text-fg leading-relaxed my-1">{c}</p>,
          // Horizontal rule
          hr: () => <hr className="border-border my-3" />,
          // Strong / em
          strong: ({ children: c }) => <strong className="font-semibold text-fg">{c}</strong>,
          em: ({ children: c }) => <em className="italic text-fg">{c}</em>,
          // Tables (remark-gfm)
          table: ({ children: c }) => (
            <div className="overflow-x-auto my-2">
              <table className="w-full text-sm border-collapse border border-border">{c}</table>
            </div>
          ),
          thead: ({ children: c }) => <thead className="bg-surface-2">{c}</thead>,
          th: ({ children: c }) => <th className="border border-border px-2 py-1 text-left font-semibold text-fg text-xs">{c}</th>,
          td: ({ children: c }) => <td className="border border-border px-2 py-1 text-fg text-xs">{c}</td>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

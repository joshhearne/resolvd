import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export default function MarkdownContent({ children, className = "" }) {
  if (!children) return null;
  return (
    <div className={`markdown-body ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Code blocks and inline code
          code({ inline, className: cls, children: code, ...props }) {
            return inline ? (
              <code
                className="bg-surface px-1 py-0.5 rounded text-[0.85em] font-mono border border-border text-brand"
                {...props}
              >
                {code}
              </code>
            ) : (
              <pre className="bg-surface border border-border rounded-lg p-3 overflow-x-auto my-2">
                <code className="text-xs font-mono text-fg leading-relaxed" {...props}>
                  {code}
                </code>
              </pre>
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

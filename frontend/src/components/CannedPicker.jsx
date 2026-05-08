import React, { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";

// Inline picker for canned responses. Click button → popover with search
// + grouped list. Selecting a row fetches the rendered body (with tag
// substitution against the active ticket + actor) and calls onInsert.
//
// Caller decides what "insert" means — appending to a textarea, replacing
// the value, etc. We just hand back the rendered string.
export default function CannedPicker({ ticketId, projectId, onInsert, label = "Canned" }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    const url = projectId
      ? `/api/canned-responses?project_id=${projectId}`
      : "/api/canned-responses";
    api.get(url)
      .then(setItems)
      .catch((e) => toast.error(e.message))
      .finally(() => setLoading(false));
  }, [open, projectId]);

  async function pick(row) {
    try {
      const r = await api.post(`/api/canned-responses/${row.id}/render`, {
        ticket_id: ticketId || null,
        record_use: true,
      });
      onInsert(r.rendered);
      setOpen(false);
    } catch (e) {
      toast.error(e.message);
    }
  }

  const filtered = items.filter((r) => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return (
      r.title.toLowerCase().includes(q) ||
      (r.category || "").toLowerCase().includes(q) ||
      r.body.toLowerCase().includes(q)
    );
  });

  const grouped = filtered.reduce((acc, r) => {
    const key = r.category || "Uncategorized";
    (acc[key] = acc[key] || []).push(r);
    return acc;
  }, {});

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="btn btn-secondary btn-sm flex items-center gap-1.5"
        aria-expanded={open}
      >
        📋 {label}
      </button>
      {open && (
        <div className="absolute left-0 mt-1 w-80 bg-surface border border-border rounded-md shadow-lg z-30">
          <div className="p-2 border-b border-border">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="w-full bg-surface-2 border border-border rounded px-2 py-1 text-sm"
            />
          </div>
          <div className="max-h-80 overflow-y-auto">
            {loading ? (
              <div className="text-sm text-fg-dim p-3">Loading…</div>
            ) : filtered.length === 0 ? (
              <div className="text-sm text-fg-dim italic p-3">
                {items.length === 0 ? (
                  <>
                    No responses yet. Manage in{" "}
                    <a href="/admin/canned-responses" className="text-brand underline">
                      Admin → Canned responses
                    </a>
                    .
                  </>
                ) : (
                  "No matches."
                )}
              </div>
            ) : (
              Object.entries(grouped).map(([cat, rows]) => (
                <div key={cat}>
                  <div className="px-3 pt-2 pb-1 text-[11px] uppercase tracking-wider font-semibold text-fg-dim">
                    {cat}
                  </div>
                  {rows.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => pick(r)}
                      className="w-full text-left px-3 py-1.5 hover:bg-surface-2"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-fg truncate">{r.title}</span>
                        {r.scope === "global" && (
                          <span className="text-[10px] uppercase px-1 rounded bg-brand/15 text-brand">
                            global
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-fg-muted truncate mt-0.5">{r.body}</div>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

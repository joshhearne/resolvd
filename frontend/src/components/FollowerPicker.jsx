import React, { useEffect, useRef, useState } from "react";
import { api } from "../utils/api";

// Typeahead + chip list for CC'ing users onto a ticket at creation time.
// Searches /api/users/search with purpose=followers so the results honour
// the project's restrict_followers_to_members flag (the server re-checks
// on create). `value` is an array of { id, display_name, email }.
export default function FollowerPicker({ projectId, value, onChange, excludeIds = [] }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef(null);
  const inputRef = useRef(null);

  const hidden = new Set([...excludeIds, ...value.map((v) => v.id)].filter(Boolean));
  const visible = results.filter((u) => !hidden.has(u.id));

  useEffect(() => {
    if (!open || !projectId) return;
    let alive = true;
    const t = setTimeout(() => {
      const qs = new URLSearchParams({ q: query.trim(), project_id: String(projectId), purpose: "followers" });
      api
        .get(`/api/users/search?${qs}`)
        .then((rows) => { if (alive) { setResults(rows || []); setActive(0); } })
        .catch(() => { if (alive) setResults([]); });
    }, 150);
    return () => { alive = false; clearTimeout(t); };
  }, [query, open, projectId]);

  useEffect(() => {
    function onDoc(e) {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function add(u) {
    onChange([...value, { id: u.id, display_name: u.display_name, email: u.email }]);
    setQuery("");
    setActive(0);
    inputRef.current?.focus();
  }

  function remove(id) {
    onChange(value.filter((v) => v.id !== id));
  }

  function onKeyDown(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, Math.max(visible.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      // Never submit the ticket form from the picker.
      e.preventDefault();
      if (open && visible[active]) add(visible[active]);
    } else if (e.key === "Escape") {
      if (open) { e.stopPropagation(); setOpen(false); }
    } else if (e.key === "Backspace" && !query && value.length) {
      remove(value[value.length - 1].id);
    }
  }

  const disabled = !projectId;

  return (
    <div ref={boxRef} className="relative">
      <div
        className={`flex flex-wrap items-center gap-1.5 w-full border border-border-strong rounded-md px-2 py-1.5 text-sm focus-within:ring-2 focus-within:ring-brand/40 ${disabled ? "opacity-60" : ""}`}
        onClick={() => !disabled && inputRef.current?.focus()}
      >
        {value.map((u) => (
          <span
            key={u.id}
            className="inline-flex items-center gap-1 rounded-full bg-surface-2 border border-border px-2 py-0.5 text-xs text-fg"
          >
            {u.display_name || u.email}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); remove(u.id); }}
              className="text-fg-dim hover:text-red-500"
              aria-label={`Remove ${u.display_name || u.email}`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={query}
          disabled={disabled}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={disabled ? "Select a project first" : value.length ? "Add another…" : "Search people to CC…"}
          className="flex-1 min-w-[8rem] bg-transparent outline-none py-0.5"
          autoComplete="off"
        />
      </div>
      {open && !disabled && visible.length > 0 && (
        <ul className="absolute z-20 mt-1 w-full max-h-56 overflow-y-auto bg-surface border border-border rounded-md shadow-lg">
          {visible.map((u, i) => (
            <li key={u.id}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => add(u)}
                onMouseEnter={() => setActive(i)}
                className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 ${i === active ? "bg-surface-2" : ""}`}
              >
                <span className="text-fg">{u.display_name || u.email}</span>
                {u.display_name && u.email && (
                  <span className="text-xs text-fg-dim ml-auto truncate">{u.email}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

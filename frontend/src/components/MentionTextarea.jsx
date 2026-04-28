import { useState, useRef, useEffect } from 'react';
import { api } from '../utils/api';

// Matches @token at end of text-before-cursor, capturing the token chars.
const TRIGGER_RE = /@([A-Za-z0-9_.+-]*)$/;

function detectMention(text, cursor) {
  const m = text.slice(0, cursor).match(TRIGGER_RE);
  if (!m) return null;
  return { query: m[1], tokenStart: cursor - m[0].length };
}

function tokenForUser(u) {
  const name = u.display_name
    ? u.display_name.toLowerCase().replace(/\s+/g, '.')
    : u.email.split('@')[0];
  return '@' + name;
}

export default function MentionTextarea({ value, onChange, onKeyDown, projectId, ...props }) {
  const [drop, setDrop] = useState(null); // { query, tokenStart, results, idx }
  const ref = useRef(null);
  const timer = useRef(null);

  function fetchUsers(query) {
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const qs = projectId ? `q=${encodeURIComponent(query)}&project_id=${projectId}` : `q=${encodeURIComponent(query)}`;
        const results = await api.get(`/api/users/search?${qs}`);
        setDrop(prev => prev ? { ...prev, results, idx: 0 } : null);
      } catch { /* silent */ }
    }, 150);
  }

  function handleChange(e) {
    onChange(e);
    const cursor = e.target.selectionStart;
    const detected = detectMention(e.target.value, cursor);
    if (detected) {
      setDrop(prev => ({
        query: detected.query,
        tokenStart: detected.tokenStart,
        results: prev?.results ?? [],
        idx: 0,
      }));
      fetchUsers(detected.query);
    } else {
      setDrop(null);
    }
  }

  function selectUser(u) {
    const token = tokenForUser(u) + ' ';
    const cursor = ref.current?.selectionStart ?? value.length;
    const before = value.slice(0, drop.tokenStart);
    const after = value.slice(cursor);
    onChange({ target: { value: before + token + after } });
    setDrop(null);
    setTimeout(() => {
      if (!ref.current) return;
      const pos = before.length + token.length;
      ref.current.setSelectionRange(pos, pos);
      ref.current.focus();
    }, 0);
  }

  function handleKeyDown(e) {
    if (drop?.results?.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setDrop(prev => ({ ...prev, idx: Math.min(prev.idx + 1, prev.results.length - 1) }));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setDrop(prev => ({ ...prev, idx: Math.max(prev.idx - 1, 0) }));
        return;
      }
      if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault();
        selectUser(drop.results[drop.idx]);
        return;
      }
      if (e.key === 'Escape') {
        setDrop(null);
        return;
      }
    }
    onKeyDown?.(e);
  }

  useEffect(() => {
    function onDown(e) {
      if (ref.current && !ref.current.contains(e.target)) setDrop(null);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  return (
    <div className="relative">
      <textarea
        ref={ref}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        {...props}
      />
      {drop?.results?.length > 0 && (
        <ul className="absolute z-50 left-0 right-0 top-full mt-1 bg-bg border border-border rounded-md shadow-lg max-h-48 overflow-y-auto text-sm">
          {drop.results.map((u, i) => (
            <li
              key={u.id}
              onMouseDown={(e) => { e.preventDefault(); selectUser(u); }}
              className={`px-3 py-2 cursor-pointer flex items-center gap-2 ${
                i === drop.idx
                  ? 'bg-brand/10 text-brand'
                  : 'hover:bg-surface-hover text-fg'
              }`}
            >
              <span className="font-medium">{u.display_name}</span>
              <span className="text-xs text-fg-muted">{u.email}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

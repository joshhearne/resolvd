import React, { useEffect, useMemo, useRef, useState } from "react";
import { ItemTags } from "./MonitoredItemPicker";

// "On this page" editor for a status page: named sections holding
// items, both reordered by dragging their grip handles. Dragging uses
// pointer events (not HTML5 drag and drop) so it works with touch too.
//
// sections: [{ key, name, fixed?, items: [{ item_id, label, display_name }] }]
// The first section is the fixed "no heading" bucket; it can't be
// renamed, moved or deleted.

const NONE_KEY = "_none";
let seq = 0;
export const newSectionKey = () => `s${Date.now().toString(36)}${(seq++).toString(36)}`;

// Flat page items (in sort order) -> sections, grouped by section name.
export function toSections(rows) {
  const out = [{ key: NONE_KEY, name: "", fixed: true, items: [] }];
  const byName = new Map();
  for (const r of rows) {
    const name = (r.section || "").trim();
    if (!name) { out[0].items.push(r); continue; }
    if (!byName.has(name)) {
      const s = { key: newSectionKey(), name, items: [] };
      byName.set(name, s);
      out.push(s);
    }
    byName.get(name).items.push(r);
  }
  return out;
}

// Sections -> flat items for PUT /items; sort_order follows the layout.
export function fromSections(sections) {
  const out = [];
  for (const s of sections) {
    for (const it of s.items) {
      out.push({
        item_id: it.item_id,
        section: s.fixed ? "" : s.name.trim(),
        display_name: it.display_name,
        sort_order: out.length,
      });
    }
  }
  return out;
}

// Problems that block saving, or null.
export function layoutProblem(sections) {
  const names = new Set();
  for (const s of sections) {
    if (s.fixed) continue;
    const n = s.name.trim().toLowerCase();
    if (!n) return "Every section needs a name.";
    if (names.has(n)) return `Section "${s.name.trim()}" is used twice.`;
    names.add(n);
  }
  return null;
}

function Grip({ className = "" }) {
  return (
    <svg viewBox="0 0 10 16" className={`w-2.5 h-4 ${className}`} fill="currentColor" aria-hidden="true">
      {[2, 8, 14].map((y) => (
        <React.Fragment key={y}>
          <circle cx="2.5" cy={y} r="1.3" />
          <circle cx="7.5" cy={y} r="1.3" />
        </React.Fragment>
      ))}
    </svg>
  );
}

function Chevron({ open }) {
  return (
    <svg viewBox="0 0 16 16" className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-90" : ""}`}
      fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const DropLine = () => <div className="h-0.5 bg-brand rounded-full mx-1 my-0.5" />;

export default function StatusPageLayoutEditor({ sections, setSections, all, onRemoveItem, maxHeight = "28rem" }) {
  const [drag, setDrag] = useState(null); // { kind: 'item'|'section', id, label, x, y }
  const [drop, setDrop] = useState(null); // item: { sectionKey, index }; section: { index }
  const [open, setOpen] = useState(() => new Set());
  const listRef = useRef(null);
  const dropRef = useRef(null);
  const pointerY = useRef(0);
  const focusKey = useRef(null);

  const byId = useMemo(() => new Map(all.map((a) => [a.id, a])), [all]);
  const childrenOf = useMemo(() => {
    const m = new Map();
    for (const a of all) {
      if (!a.parent_item_id || !a.active) continue;
      if (!m.has(a.parent_item_id)) m.set(a.parent_item_id, []);
      m.get(a.parent_item_id).push(a);
    }
    for (const list of m.values()) {
      list.sort((x, y) => (y.is_primary ? 1 : 0) - (x.is_primary ? 1 : 0) || String(x.label).localeCompare(String(y.label)));
    }
    return m;
  }, [all]);

  const nameCounts = useMemo(() => {
    const m = new Map();
    for (const s of sections) {
      if (s.fixed) continue;
      const n = s.name.trim().toLowerCase();
      if (n) m.set(n, (m.get(n) || 0) + 1);
    }
    return m;
  }, [sections]);

  // Where the pointer would drop the dragged thing. Picks the section
  // under the pointer (or the nearest one), then the slot among its
  // items by midpoint; the dragged element itself is skipped so the
  // index applies after it is lifted out.
  function computeDrop(kind, id, y) {
    const root = listRef.current;
    if (!root) return null;
    if (kind === "section") {
      const els = [...root.querySelectorAll("[data-section-key]")]
        .filter((el) => el.dataset.fixed !== "1" && el.dataset.sectionKey !== id);
      let index = 0;
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (y > r.top + r.height / 2) index += 1;
      }
      return { index };
    }
    const secEls = [...root.querySelectorAll("[data-section-key]")];
    let target = null;
    let best = Infinity;
    for (const el of secEls) {
      const r = el.getBoundingClientRect();
      const dist = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      if (dist < best) { best = dist; target = el; }
    }
    if (!target) return null;
    const itemEls = [...target.querySelectorAll("[data-item-id]")]
      .filter((el) => el.dataset.itemId !== String(id));
    let index = 0;
    for (const el of itemEls) {
      const r = el.getBoundingClientRect();
      if (y > r.top + r.height / 2) index += 1;
    }
    return { sectionKey: target.dataset.sectionKey, index };
  }

  function commit(d, at) {
    if (!d || !at) return;
    setSections((prev) => {
      if (d.kind === "section") {
        const fixed = prev.filter((s) => s.fixed);
        const rest = prev.filter((s) => !s.fixed);
        const from = rest.findIndex((s) => s.key === d.id);
        if (from < 0) return prev;
        const [moved] = rest.splice(from, 1);
        rest.splice(Math.min(at.index, rest.length), 0, moved);
        return [...fixed, ...rest];
      }
      let moved = null;
      const lifted = prev.map((s) => {
        const i = s.items.findIndex((it) => it.item_id === d.id);
        if (i < 0) return s;
        moved = s.items[i];
        return { ...s, items: s.items.filter((_, j) => j !== i) };
      });
      if (!moved) return prev;
      return lifted.map((s) => {
        if (s.key !== at.sectionKey) return s;
        const items = [...s.items];
        items.splice(Math.min(at.index, items.length), 0, moved);
        return { ...s, items };
      });
    });
  }

  useEffect(() => {
    if (!drag) return undefined;
    const { kind, id } = drag;
    function onMove(e) {
      pointerY.current = e.clientY;
      setDrag((d) => d && { ...d, x: e.clientX, y: e.clientY });
      const at = computeDrop(kind, id, e.clientY);
      dropRef.current = at;
      setDrop(at);
    }
    function end(apply) {
      if (apply) commit({ kind, id }, dropRef.current);
      dropRef.current = null;
      setDrop(null);
      setDrag(null);
    }
    const onUp = () => end(true);
    const onCancel = () => end(false);
    const onKey = (e) => { if (e.key === "Escape") end(false); };
    // Scroll the list while the pointer rests near its top or bottom edge.
    const timer = setInterval(() => {
      const el = listRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const y = pointerY.current;
      const step = y < r.top + 40 ? -10 : y > r.bottom - 40 ? 10 : 0;
      if (!step) return;
      el.scrollTop += step;
      const at = computeDrop(kind, id, y);
      dropRef.current = at;
      setDrop(at);
    }, 30);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
    document.body.style.userSelect = "none";
    return () => {
      clearInterval(timer);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
      document.body.style.userSelect = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.kind, drag?.id]);

  function startDrag(e, kind, id, label) {
    if (e.button !== 0) return;
    e.preventDefault();
    pointerY.current = e.clientY;
    const at = computeDrop(kind, id, e.clientY);
    dropRef.current = at;
    setDrop(at);
    setDrag({ kind, id, label, x: e.clientX, y: e.clientY });
  }

  function renameSection(key, name) {
    setSections((prev) => prev.map((s) => (s.key === key ? { ...s, name } : s)));
  }
  function deleteSection(key) {
    setSections((prev) => prev.filter((s) => s.key !== key));
  }
  function addSection() {
    const key = newSectionKey();
    focusKey.current = key;
    setSections((prev) => [...prev, { key, name: "", items: [] }]);
  }
  function updateItem(itemId, patch) {
    setSections((prev) => prev.map((s) => ({
      ...s,
      items: s.items.map((it) => (it.item_id === itemId ? { ...it, ...patch } : it)),
    })));
  }
  function toggleOpen(itemId) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId); else next.add(itemId);
      return next;
    });
  }

  const dragging = (kind, id) => drag && drag.kind === kind && drag.id === id;
  const handleCls = "shrink-0 flex items-center justify-center w-6 h-7 -ml-1 rounded text-fg-dim hover:text-fg hover:bg-surface-2 cursor-grab active:cursor-grabbing";
  let sectionSlot = 0;

  return (
    <div className="space-y-2">
      <div ref={listRef} className="space-y-2 overflow-y-auto pr-1" style={{ maxHeight }}>
        {sections.map((s) => {
          const isDragged = dragging("section", s.key);
          const showSectionLine = drag?.kind === "section" && !s.fixed && !isDragged && drop?.index === sectionSlot;
          if (!s.fixed && !isDragged) sectionSlot += 1;
          const dup = !s.fixed && nameCounts.get(s.name.trim().toLowerCase()) > 1;
          const itemTarget = drag?.kind === "item" && drop?.sectionKey === s.key;
          let itemSlot = 0;
          return (
            <React.Fragment key={s.key}>
              {showSectionLine && <DropLine />}
              <div
                data-section-key={s.key}
                data-fixed={s.fixed ? "1" : "0"}
                className={`rounded border ${itemTarget ? "border-brand/60" : "border-border"} ${isDragged ? "opacity-40" : ""}`}
              >
                <div className="flex items-center gap-1.5 px-2 py-1.5 bg-surface-2/60 border-b border-border">
                  {s.fixed ? (
                    <span className="text-xs text-fg-muted py-1">No section <span className="text-fg-dim">· shown without a heading</span></span>
                  ) : (
                    <>
                      <span
                        role="button"
                        aria-label={`Drag section ${s.name || "untitled"}`}
                        className={handleCls}
                        style={{ touchAction: "none" }}
                        onPointerDown={(e) => startDrag(e, "section", s.key, s.name || "Untitled section")}
                      >
                        <Grip className="w-3 h-4" />
                      </span>
                      <input
                        value={s.name}
                        autoFocus={focusKey.current === s.key}
                        onFocus={() => { focusKey.current = null; }}
                        onChange={(e) => renameSection(s.key, e.target.value)}
                        placeholder="Section name"
                        maxLength={120}
                        className={`flex-1 min-w-0 bg-transparent border rounded px-1.5 py-0.5 text-sm font-semibold text-fg ${dup || !s.name.trim() ? "border-red-400" : "border-transparent hover:border-border focus:border-border"}`}
                      />
                      <span className="text-xs text-fg-dim shrink-0">{s.items.length}</span>
                      <button
                        type="button"
                        onClick={() => deleteSection(s.key)}
                        disabled={s.items.length > 0}
                        title={s.items.length ? "Move or remove its items first" : "Delete section"}
                        className="shrink-0 text-xs text-red-500 hover:underline disabled:text-fg-dim disabled:no-underline disabled:cursor-not-allowed px-1"
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
                {dup && <div className="px-2 pt-1 text-xs text-red-500">Another section has this name.</div>}
                <ul className="p-1 min-h-[2.25rem]">
                  {s.items.map((r) => {
                    const meta = byId.get(r.item_id);
                    const kids = childrenOf.get(r.item_id) || [];
                    const isOpen = open.has(r.item_id);
                    const itemDragged = dragging("item", r.item_id);
                    const line = itemTarget && !itemDragged && drop.index === itemSlot;
                    if (!itemDragged) itemSlot += 1;
                    return (
                      <React.Fragment key={r.item_id}>
                        {line && <DropLine />}
                        <li data-item-id={r.item_id} className={`rounded ${itemDragged ? "opacity-40" : ""}`}>
                          <div className="flex items-center gap-1 flex-wrap sm:flex-nowrap px-1 py-1 hover:bg-surface-2/50 rounded">
                            <span
                              role="button"
                              aria-label={`Drag ${r.label || "item"}`}
                              className={handleCls}
                              style={{ touchAction: "none" }}
                              onPointerDown={(e) => startDrag(e, "item", r.item_id, r.display_name || r.label)}
                            >
                              <Grip />
                            </span>
                            {kids.length ? (
                              <button type="button" onClick={() => toggleOpen(r.item_id)}
                                aria-expanded={isOpen} aria-label={isOpen ? "Hide components" : "Show components"}
                                className="shrink-0 w-5 h-6 flex items-center justify-center text-fg-muted hover:text-fg">
                                <Chevron open={isOpen} />
                              </button>
                            ) : <span className="shrink-0 w-5" />}
                            <span className="text-sm text-fg flex-1 min-w-0 truncate">
                              {r.label || `Item ${r.item_id}`}
                              {meta && <ItemTags item={meta} />}
                              {kids.length > 0 && <span className="ml-1.5 text-xs text-fg-dim">{kids.length}</span>}
                            </span>
                            <input
                              value={r.display_name}
                              onChange={(e) => updateItem(r.item_id, { display_name: e.target.value })}
                              placeholder="Display name"
                              maxLength={160}
                              className="order-last sm:order-none basis-full sm:basis-auto ml-12 sm:ml-0 sm:w-40 bg-surface-2 border border-border rounded px-2 py-0.5 text-xs"
                            />
                            <button type="button" onClick={() => onRemoveItem(r.item_id)}
                              aria-label={`Remove ${r.label || "item"}`}
                              className="shrink-0 w-6 h-6 flex items-center justify-center text-fg-dim hover:text-red-500">
                              ×
                            </button>
                          </div>
                          {isOpen && kids.length > 0 && (
                            <ul className="ml-12 mb-1 border-l border-border pl-2 space-y-0.5">
                              {kids.map((k) => (
                                <li key={k.id} className="text-xs text-fg-muted truncate">
                                  {k.label}
                                  <ItemTags item={k} />
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      </React.Fragment>
                    );
                  })}
                  {itemTarget && drop.index === itemSlot && <DropLine />}
                  {s.items.length === 0 && !itemTarget && (
                    <li className="text-xs text-fg-dim italic px-2 py-1.5">
                      {s.fixed ? "Drop items here to show them without a heading." : "Drag items here."}
                    </li>
                  )}
                </ul>
              </div>
            </React.Fragment>
          );
        })}
        {drag?.kind === "section" && drop?.index === sectionSlot && <DropLine />}
      </div>

      <button type="button" onClick={addSection} className="btn btn-secondary btn-sm">+ Add section</button>

      {drag && (
        <div
          className="fixed z-50 pointer-events-none px-2 py-1 rounded border border-brand/50 bg-surface shadow-lg text-sm text-fg max-w-xs truncate"
          style={{ left: drag.x + 12, top: drag.y - 14 }}
        >
          {drag.kind === "section" ? `Section: ${drag.label}` : drag.label || "Item"}
        </div>
      )}
    </div>
  );
}

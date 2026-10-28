import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Kebab-style "more actions" menu used in admin tables. The trigger
// renders inline; the panel is portaled to <body> with position:fixed
// so it escapes overflow:hidden table wrappers and never forces the
// page to scroll.
//
// Positioning rules (RTL-flyout by default since the menu sits in the
// right-edge actions column):
//   - Horizontal: align the panel's right edge to the trigger's right
//     edge. If that pushes the left edge off-screen, clamp to 8px from
//     the viewport's left edge.
//   - Vertical: prefer below. If the panel won't fit between the
//     trigger and the viewport bottom, flip and anchor the panel's
//     bottom to the trigger's top. Never grow taller than the viewport
//     (max-height + internal scroll as last resort).
//
// We avoid hover-to-open: hover menus near the viewport edge are
// fragile, and re-positioning can pull the panel out from under the
// cursor. Click toggles instead, with outside-click + Escape to close.
//
// Props:
//   items: [{ label, onClick, danger?, disabled?, hidden? }]
//   buttonAriaLabel: a11y text for the trigger
//   buttonClassName: optional override for the kebab button
export default function RowMenu({ items, buttonAriaLabel = "Open actions menu", buttonClassName = "" }) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ left: 0, top: 0, maxHeight: undefined, openUp: false });
  const triggerRef = useRef(null);
  const panelRef = useRef(null);

  // 224px = w-56, the panel's design width. We size at render but the
  // actual measured width takes over via panelRef once it's mounted.
  const NOMINAL_WIDTH = 224;
  const EDGE_PAD = 8;

  const recompute = () => {
    const trig = triggerRef.current;
    if (!trig) return;
    const r = trig.getBoundingClientRect();
    const panelW = panelRef.current?.offsetWidth || NOMINAL_WIDTH;
    const panelH = panelRef.current?.offsetHeight || 0;
    const vh = window.innerHeight;
    const vw = window.innerWidth;

    // Right-align under the trigger by default.
    let left = r.right - panelW;
    if (left < EDGE_PAD) left = EDGE_PAD;
    if (left + panelW > vw - EDGE_PAD) left = vw - panelW - EDGE_PAD;

    const spaceBelow = vh - r.bottom - EDGE_PAD;
    const spaceAbove = r.top - EDGE_PAD;

    // Prefer down. Flip up when down can't hold the panel AND up has
    // strictly more room. Cap height to whichever side we land on so
    // an unusually tall menu scrolls internally instead of pushing
    // the page.
    let openUp = false;
    let maxHeight = spaceBelow;
    if (panelH > spaceBelow && spaceAbove > spaceBelow) {
      openUp = true;
      maxHeight = spaceAbove;
    }
    const top = openUp ? Math.max(EDGE_PAD, r.top - (panelRef.current?.offsetHeight || 0) - 4)
                       : r.bottom + 4;
    setCoords({ left, top, maxHeight, openUp });
  };

  // Recompute on open, on resize, on scroll. We bind scroll with
  // capture:true so we catch ancestor scroll containers too.
  useLayoutEffect(() => {
    if (!open) return;
    recompute();
    // Second pass after layout settles so the measured panel height
    // can correct an initial under-estimate (panel started at h=0).
    const raf = requestAnimationFrame(recompute);
    const onScroll = () => recompute();
    const onResize = () => recompute();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  // Outside click + Escape closes.
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e) => {
      if (triggerRef.current?.contains(e.target)) return;
      if (panelRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const visibleItems = (items || []).filter((it) => !it.hidden);
  if (!visibleItems.length) return null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={buttonAriaLabel}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className={
          buttonClassName ||
          "inline-flex items-center justify-center w-7 h-7 rounded hover:bg-surface-2 text-fg-muted hover:text-fg"
        }
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="8" cy="3" r="1.4" />
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="8" cy="13" r="1.4" />
        </svg>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          role="menu"
          style={{
            position: "fixed",
            left: coords.left,
            top: coords.top,
            width: NOMINAL_WIDTH,
            maxHeight: coords.maxHeight ? `${coords.maxHeight}px` : undefined,
          }}
          className="z-[9999] bg-surface border border-border rounded-md shadow-lg py-1 overflow-auto"
          onClick={(e) => e.stopPropagation()}
        >
          {visibleItems.map((it, i) => (
            <button
              key={i}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              onClick={() => {
                if (it.disabled) return;
                setOpen(false);
                it.onClick?.();
              }}
              className={
                "w-full text-left px-3 py-1.5 text-sm hover:bg-surface-2 disabled:opacity-50 disabled:hover:bg-transparent " +
                (it.danger ? "text-red-600 dark:text-red-400" : "text-fg")
              }
            >
              {it.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

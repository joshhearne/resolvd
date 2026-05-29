import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import TaskQuickCreate from "./TaskQuickCreate";

// Split "+|New v" button. Left half always fires the default (top of
// the list — Ticket). Right half drops a menu of creation targets.
// Items either navigate to a creation page (Ticket / Project /
// Inventory / Consumable / KB Article) or pop a context-aware modal
// in place (Task). The KB option requires a project pick first
// because KB articles are project-scoped; we shortcut to the user's
// default project when set, otherwise navigate to the project
// picker.
//
// Props:
//   user        session user (drives role gating of menu items)
//   projects    optional cached project list for the KB shortcut
export default function NewMenu({ user, projects = [] }) {
  const navigate = useNavigate();
  const location = useLocation();
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ left: 0, top: 0, maxHeight: undefined });
  const [taskOpen, setTaskOpen] = useState(false);

  const role = user?.role;
  const isAgent = ["Admin", "Manager", "Tech"].includes(role);
  const isAdminOrMgr = ["Admin", "Manager"].includes(role);
  const canSubmit = isAgent || role === "Submitter";

  // Detect the source ticket id from the URL so Task → quick-create
  // can link the new task back. Matches /tickets/:id (with optional
  // trailing segments).
  const ticketMatch = location.pathname.match(/^\/tickets\/(\d+)/);
  const sourceTicketId = ticketMatch ? Number(ticketMatch[1]) : null;

  function goNewTicket() { navigate("/tickets/new"); }
  function goNewProject() { navigate("/admin/projects"); }
  function goNewInventory() { navigate("/inventory/new"); }
  function goNewConsumable() { navigate("/consumables?new=1"); }
  function goNewKb() {
    if (user?.default_project_id) {
      navigate(`/kb/${user.default_project_id}/new`);
      return;
    }
    const first = projects.find((p) => p.status === "active");
    if (first) navigate(`/kb/${first.id}/new`);
    else navigate("/kb");
  }

  const items = [
    canSubmit && { label: "Ticket", description: "Open a new issue", onClick: goNewTicket },
    canSubmit && { label: "Task", description: "Personal follow-up (pops in place)", onClick: () => setTaskOpen(true), kind: "task" },
    isAdminOrMgr && { label: "Project", description: "Admin → Projects", onClick: goNewProject },
    isAgent && { label: "Inventory item", description: "Add an asset", onClick: goNewInventory },
    isAgent && { label: "Consumable", description: "Add a stocked part", onClick: goNewConsumable },
    isAgent && { label: "KB article", description: "Knowledge Base entry", onClick: goNewKb },
  ].filter(Boolean);

  const PANEL_WIDTH = 240;
  const EDGE_PAD = 8;

  useLayoutEffect(() => {
    if (!open) return;
    function recompute() {
      const trig = triggerRef.current;
      if (!trig) return;
      const r = trig.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // Anchor the panel to the trigger's right edge so it doesn't
      // jump when the sidebar collapses / nav width shifts.
      let left = r.right - PANEL_WIDTH;
      if (left < EDGE_PAD) left = EDGE_PAD;
      if (left + PANEL_WIDTH > vw - EDGE_PAD) left = vw - PANEL_WIDTH - EDGE_PAD;
      const top = r.bottom + 4;
      const maxHeight = vh - top - EDGE_PAD;
      setCoords({ left, top, maxHeight });
    }
    recompute();
    const onScroll = () => recompute();
    const onResize = () => recompute();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (triggerRef.current?.contains(e.target)) return;
      if (panelRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!items.length) return null;

  const defaultAction = items[0];

  return (
    <>
      <div ref={triggerRef} className="inline-flex items-stretch rounded-md overflow-hidden bg-brand text-brand-fg text-sm font-medium shadow-sm">
        <button type="button"
          onClick={() => defaultAction.onClick()}
          className="inline-flex items-center gap-1.5 pl-2.5 pr-2 py-1.5 hover:bg-brand-hover transition-colors"
          aria-label={`New ${defaultAction.label.toLowerCase()}`}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
            strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          <span className="hidden sm:inline">New</span>
        </button>
        <span aria-hidden="true" className="w-px bg-brand-fg/30 self-stretch" />
        <button type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu" aria-expanded={open}
          aria-label="Choose what to create"
          className="inline-flex items-center px-1.5 hover:bg-brand-hover transition-colors">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
            strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </div>

      {open && createPortal(
        <div ref={panelRef} role="menu"
          style={{
            position: "fixed",
            left: coords.left,
            top: coords.top,
            width: PANEL_WIDTH,
            maxHeight: coords.maxHeight ? `${coords.maxHeight}px` : undefined,
          }}
          className="z-[9999] bg-surface border border-border rounded-md shadow-lg py-1 overflow-auto"
          onClick={(e) => e.stopPropagation()}>
          {items.map((it, i) => (
            <button key={i} type="button" role="menuitem"
              onClick={() => { setOpen(false); it.onClick(); }}
              className="w-full text-left px-3 py-2 hover:bg-surface-2">
              <div className="text-sm text-fg flex items-center gap-2">
                {it.label}
                {it.kind === "task" && sourceTicketId && (
                  <span className="text-[10px] uppercase tracking-wide bg-brand/10 text-brand border border-brand/30 rounded px-1.5 py-0.5">
                    linked
                  </span>
                )}
              </div>
              {it.description && (
                <div className="text-[11px] text-fg-dim">{it.description}</div>
              )}
            </button>
          ))}
        </div>,
        document.body,
      )}

      <TaskQuickCreate
        open={taskOpen}
        defaultTicketId={sourceTicketId}
        onClose={() => setTaskOpen(false)}
      />
    </>
  );
}

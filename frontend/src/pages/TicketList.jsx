import React, { useEffect, useMemo, useState, useCallback } from "react";
import { Link, useSearchParams } from "react-router-dom";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import { priorityRowClass } from "../utils/helpers";
import { useAuth } from "../context/AuthContext";
import { useStatuses } from "../context/StatusesContext";
import PriorityBadge from "../components/PriorityBadge";
import StatusBadge from "../components/StatusBadge";
import PhoneticPopover from "../components/PhoneticPopover";
import PageShell from "../components/PageShell";
import ColumnPicker, { useColumnPrefs } from "../components/ColumnPicker";
import {
  useTicketFilters,
  useTicketFilterLookups,
  buildTicketQs,
  summarizeFilters,
  TicketFiltersModal,
  DEFAULT_TICKET_FILTERS,
} from "../components/TicketFilters";
import {
  getRecentTickets,
  pushRecentTicket,
  clearRecentTickets,
} from "../utils/recentTickets";

const TICKET_COLUMNS = [
  { id: "ref", label: "Ref", alwaysOn: true },
  { id: "title", label: "Title", alwaysOn: true },
  { id: "priority", label: "Priority" },
  { id: "internal", label: "Internal status" },
  { id: "external", label: "External status" },
  { id: "vendor_ref", label: "Vendor ref" },
  { id: "alert_ref", label: "Alert ref" },
  { id: "blocker", label: "Blocker" },
  { id: "flagged", label: "Flagged" },
  { id: "updated", label: "Updated" },
];

const LIMIT = 50;

// URL ?preset=foo → filter overlay applied on top of the current
// persisted filter state. Lets dashboard tiles + email links deep-link
// into a specific view without inventing a new URL schema.
const URL_PRESETS = {
  open:           { statuses: ["Open"],            excludeClosed: true },
  in_progress:    { statuses: ["In Progress"],     excludeClosed: true },
  awaiting_mot:   { statuses: ["Awaiting Input"],  excludeClosed: true },
  pending_review: { statuses: ["Pending Review"],  excludeClosed: true },
  flagged:        { flagged: true,                 excludeClosed: true },
  closed:         { statuses: ["Closed"],          excludeClosed: false },
  sla_breached:   { excludeClosed: true },
  mine:           { mine: true,                    excludeClosed: true },
};

function DateTimeStack({ value }) {
  if (!value) return <span className="text-fg-dim">—</span>;
  const d = new Date(value.endsWith("Z") ? value : value + "Z");
  const date = d.toLocaleDateString("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const time = d.toLocaleTimeString("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return (
    <>
      <div className="whitespace-nowrap">{date}</div>
      <div className="text-fg-dim whitespace-nowrap">{time}</div>
    </>
  );
}

export default function TicketList() {
  const { user } = useAuth();
  const isAdmin = user?.role === "Admin";
  const { internal: internalStatuses } = useStatuses();
  const [searchParams, setSearchParams] = useSearchParams();
  const cols = useColumnPrefs("tickets");

  const { filters, setFilters, reset } = useTicketFilters();
  const { projects, statuses } = useTicketFilterLookups();

  // One-shot apply of ?preset=… on mount or when URL changes. Overlay
  // on top of the persisted filter — leaves the user's other choices
  // (range, projects) alone unless the preset explicitly changes them.
  useEffect(() => {
    const preset = searchParams.get("preset");
    if (!preset || !URL_PRESETS[preset]) return;
    setFilters((f) => ({ ...f, ...URL_PRESETS[preset] }));
    // Strip the param so a subsequent filter change doesn't re-overlay.
    const next = new URLSearchParams(searchParams);
    next.delete("preset");
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.get("preset")]);

  // Search bar drives ?q= so it survives reloads + breadcrumb resets.
  const [q, setQ] = useState(searchParams.get("q") || "");
  useEffect(() => {
    const urlQ = searchParams.get("q") || "";
    if (urlQ !== q) setQ(urlQ);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.get("q")]);

  // Pagination resets on any filter / sort / search / preset change.
  const [page, setPage] = useState(1);
  useEffect(() => {
    setPage(1);
  }, [filters, q]);

  const [tickets, setTickets] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const [filtersOpen, setFiltersOpen] = useState(false);

  // Saved views — kept but moved into a compact menu instead of a
  // side-rail block. Selecting a view replaces the current filter set.
  const [savedViews, setSavedViews] = useState([]);
  const [savedMenuOpen, setSavedMenuOpen] = useState(false);
  const [saveName, setSaveName] = useState("");

  useEffect(() => {
    api.get("/api/views").then(setSavedViews).catch(() => setSavedViews([]));
  }, []);

  // Recently opened — drives the left rail. Pulled fresh on every
  // localStorage change so opening a ticket in another tab is visible.
  const [recents, setRecents] = useState(() => getRecentTickets());
  useEffect(() => {
    function onChange() {
      setRecents(getRecentTickets());
    }
    window.addEventListener("resolvd:recent-tickets-changed", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener("resolvd:recent-tickets-changed", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  // Bulk edit (admin only) — preserved from prior implementation.
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkStatus, setBulkStatus] = useState("");
  const [bulkAssignee, setBulkAssignee] = useState("");
  const [bulkProject, setBulkProject] = useState("");
  const [bulkUsers, setBulkUsers] = useState([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkReplyOpen, setBulkReplyOpen] = useState(false);
  const [bulkReplyBody, setBulkReplyBody] = useState("");
  const [bulkReplyExternal, setBulkReplyExternal] = useState(false);
  const [bulkReplyBusy, setBulkReplyBusy] = useState(false);

  // Restrict the bulk-assignee dropdown to eligible handlers: global
  // Admin/Manager/Tech plus any user with is_agent on a project. When the
  // selection is scoped to a single project, restrict to that project's
  // agents; otherwise fall back to the org-wide eligible set.
  useEffect(() => {
    if (!bulkMode || !isAdmin) return;
    const projectIds = new Set(
      tickets
        .filter((t) => selectedIds.has(t.id))
        .map((t) => t.project_id)
        .filter(Boolean)
    );
    const scope = projectIds.size === 1
      ? `?project_id=${[...projectIds][0]}`
      : "";
    api
      .get(`/api/agents/eligible${scope}`)
      .then((rows) => setBulkUsers(rows || []))
      .catch(() => {});
  }, [bulkMode, isAdmin, selectedIds, tickets]);

  function exitBulkMode() {
    setBulkMode(false);
    setSelectedIds(new Set());
    setBulkStatus("");
    setBulkAssignee("");
    setBulkProject("");
    setBulkReplyOpen(false);
    setBulkReplyBody("");
    setBulkReplyExternal(false);
  }

  async function applyBulkReply() {
    if (!selectedIds.size) {
      toast.error("Select at least one ticket");
      return;
    }
    const body = bulkReplyBody.trim();
    if (!body) {
      toast.error("Comment body required");
      return;
    }
    setBulkReplyBusy(true);
    try {
      const res = await api.post("/api/tickets/bulk/comment", {
        ids: Array.from(selectedIds),
        body,
        is_external_visible: bulkReplyExternal,
      });
      const okN = res.posted?.length || 0;
      const skipN = res.skipped?.length || 0;
      if (okN) toast.success(`Posted on ${okN} ticket${okN === 1 ? "" : "s"}`);
      if (skipN) toast.error(`Skipped ${skipN} (${res.skipped[0]?.reason || "error"})`);
      setBulkReplyOpen(false);
      setBulkReplyBody("");
      setBulkReplyExternal(false);
      exitBulkMode();
      fetchTickets();
    } catch (e) {
      toast.error(e.message || "Bulk reply failed");
    } finally {
      setBulkReplyBusy(false);
    }
  }

  function toggleId(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const fetchTickets = useCallback(() => {
    setLoading(true);
    const qs = buildTicketQs(filters, {
      q: q.trim() || null,
      page,
      limit: LIMIT,
    });
    api
      .get(`/api/tickets${qs}`)
      .then((data) => {
        setTickets(data.tickets || []);
        setTotal(data.total || 0);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [filters, q, page]);

  useEffect(() => {
    fetchTickets();
  }, [fetchTickets]);

  async function applyBulk() {
    if (!selectedIds.size) {
      toast.error("Select at least one ticket");
      return;
    }
    const updates = {};
    if (bulkStatus) updates.status = bulkStatus;
    if (bulkAssignee !== "") {
      updates.assigned_to = bulkAssignee === "0" ? null : Number(bulkAssignee);
    }
    if (bulkProject) updates.project_id = Number(bulkProject);
    if (Object.keys(updates).length === 0) {
      toast.error("Pick at least one update field");
      return;
    }
    setBulkBusy(true);
    try {
      const res = await api.post("/api/tickets/bulk", {
        ids: Array.from(selectedIds),
        ...updates,
      });
      const okN = res.updated?.length || 0;
      const skipN = res.skipped?.length || 0;
      if (okN) toast.success(`Updated ${okN} ticket${okN === 1 ? "" : "s"}`);
      if (skipN) toast.error(`Skipped ${skipN} (${res.skipped[0]?.reason || "error"})`);
      exitBulkMode();
      fetchTickets();
    } catch (e) {
      toast.error(e.message || "Bulk update failed");
    } finally {
      setBulkBusy(false);
    }
  }

  async function persistView() {
    const name = saveName.trim();
    if (!name) {
      toast.error("Name required");
      return;
    }
    try {
      const v = await api.post("/api/views", {
        name,
        filters: { v2: true, ...filters, q: q.trim() || "" },
      });
      setSavedViews((prev) => [...prev, v].sort((a, b) => a.name.localeCompare(b.name)));
      setSaveName("");
      toast.success(`Saved "${v.name}"`);
    } catch (e) {
      toast.error(e.message);
    }
  }

  function loadView(view) {
    const f = view.filters || {};
    if (f.v2) {
      const { q: viewQ, v2, ...rest } = f;
      setFilters({ ...DEFAULT_TICKET_FILTERS, ...rest });
      setQ(viewQ || "");
    } else {
      // Legacy view shape — best-effort translation into v2.
      const next = { ...DEFAULT_TICKET_FILTERS };
      if (f.internal_status) next.statuses = [f.internal_status];
      if (f.effective_priority) next.priorities = [Number(f.effective_priority)];
      if (f.flagged_for_review === "true") next.flagged = true;
      if (f.has_fix === "1") next.hasFix = true;
      if (f.project_id) next.projectIds = [Number(f.project_id)];
      setFilters(next);
      setQ(f.q || "");
    }
    setSavedMenuOpen(false);
  }

  async function deleteView(e, id) {
    e.stopPropagation();
    try {
      await api.delete(`/api/views/${id}`);
      setSavedViews((prev) => prev.filter((v) => v.id !== id));
      toast.success("View deleted");
    } catch (e) {
      toast.error(e.message);
    }
  }

  const summary = useMemo(
    () => summarizeFilters(filters, projects, statuses),
    [filters, projects, statuses],
  );

  // The first project's has_external_vendor flag drives vendor column
  // visibility when the filter narrows to one project. With no project
  // filter (or multiple) — show vendor columns.
  const singleProject =
    filters.projectIds.length === 1
      ? projects.find((p) => p.id === filters.projectIds[0])
      : null;
  const showVendorCols =
    !singleProject || singleProject.has_external_vendor !== false;

  function onRowOpen(t) {
    pushRecentTicket({ id: t.id, ref: t.internal_ref, title: t.title });
  }

  function handleSort(col) {
    // Translate column sort clicks into the filters.sort token so the
    // modal + breadcrumb stay coherent.
    const map = {
      effective_priority: "priority",
      updated_at: filters.sort === "updated_desc" ? "updated_asc" : "updated_desc",
      created_at: filters.sort === "created_desc" ? "created_asc" : "created_desc",
    };
    const next = map[col];
    if (next) setFilters((f) => ({ ...f, sort: next }));
  }

  function SortHeader({ col, label }) {
    const tokens = {
      effective_priority: "priority",
      updated_at: ["updated_desc", "updated_asc"],
      created_at: ["created_desc", "created_asc"],
    };
    const t = tokens[col];
    const active = Array.isArray(t) ? t.includes(filters.sort) : filters.sort === t;
    return (
      <button
        onClick={() => handleSort(col)}
        className={`text-left font-medium text-xs uppercase tracking-wide hover:text-brand transition-colors ${
          active ? "text-brand" : "text-fg-muted"
        }`}
      >
        {label}{" "}
        {active
          ? Array.isArray(t)
            ? filters.sort.endsWith("_asc")
              ? "↑"
              : "↓"
            : "↑"
          : ""}
      </button>
    );
  }

  const filterCount =
    (filters.mine ? 1 : 0) +
    (filters.flagged ? 1 : 0) +
    (filters.hasFix !== null ? 1 : 0) +
    filters.projectIds.length +
    filters.statuses.length +
    filters.priorities.length;

  // Mobile drawer toggle for the Recently opened rail. Desktop hides
  // the hamburger and just renders the rail inline.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(() => {
    try {
      return localStorage.getItem("tickets:nav-collapsed") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("tickets:nav-collapsed", navCollapsed ? "1" : "0");
    } catch {}
  }, [navCollapsed]);

  return (
    <PageShell variant="wide" className="flex gap-5 items-start">
      {/* Mobile backdrop */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      {/* ── Left rail: Recently opened ── */}
      <aside
        className={`
          space-y-2 md:w-52 md:flex-shrink-0 md:self-start md:sticky md:top-14 md:max-h-[calc(100vh-6.5rem)] md:overflow-y-auto md:pr-2 md:relative md:bg-transparent md:shadow-none
          ${
            drawerOpen
              ? "fixed inset-y-0 left-0 z-50 w-72 bg-surface shadow-xl overflow-y-auto p-4"
              : navCollapsed
                ? "hidden"
                : "hidden md:block"
          }
        `}
      >
        <div className="flex items-center justify-between mb-2 md:hidden">
          <span className="font-semibold text-fg text-sm">Recently opened</span>
          <div className="flex items-center gap-2">
            {recents.length > 0 && (
              <button
                onClick={() => clearRecentTickets()}
                className="text-[11px] text-fg-dim hover:text-fg"
              >
                clear
              </button>
            )}
            <button
              onClick={() => setDrawerOpen(false)}
              className="text-fg-dim hover:text-fg-muted text-2xl leading-none"
            >
              ×
            </button>
          </div>
        </div>
        <div className="hidden md:flex items-center justify-between px-3 mb-1">
          <span className="text-xs font-semibold uppercase tracking-wider text-fg-dim">
            Recently opened
          </span>
          {recents.length > 0 && (
            <button
              onClick={() => clearRecentTickets()}
              className="text-[10px] text-fg-dim hover:text-fg"
              title="Clear history"
            >
              clear
            </button>
          )}
        </div>
        {recents.length === 0 ? (
          <p className="px-3 py-2 text-xs text-fg-dim italic">
            Open a ticket to start building history.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {recents.map((r) => (
              <li key={r.id}>
                <Link
                  to={`/tickets/${r.id}`}
                  className="block px-3 py-1.5 rounded-md text-sm text-fg-muted hover:bg-surface-2 hover:text-fg transition-colors"
                  title={r.title}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-brand shrink-0">
                      {r.ref}
                    </span>
                    <span className="truncate">{r.title || "(no title)"}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </aside>

      {/* ── Main content ── */}
      <div className="flex-1 min-w-0 space-y-4 md:self-start md:max-h-[calc(100vh-6.5rem)] md:overflow-y-auto md:pr-1">
        {/* Header */}
        <div className="space-y-2">
          {/* Row 1: title + primary actions (Mine, Filters, +). Compact
              on mobile; the rest goes to row 2 / desktop-only. */}
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 min-w-0">
              <button
                onClick={() => setDrawerOpen(true)}
                className="md:hidden p-1.5 rounded-md text-fg-muted hover:bg-surface-2 hover:text-fg transition-colors"
                aria-label="Open recently opened drawer"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
                </svg>
              </button>
              <button
                onClick={() => setNavCollapsed((v) => !v)}
                className="hidden md:inline-flex p-1.5 rounded-md text-fg-muted hover:bg-surface-2 hover:text-fg transition-colors"
                aria-label={navCollapsed ? "Expand recently opened rail" : "Collapse recently opened rail"}
                title={navCollapsed ? "Show recently opened" : "Hide recently opened"}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  {navCollapsed ? (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                  ) : (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7M19 19l-7-7 7-7" />
                  )}
                </svg>
              </button>
              <h1 className="text-xl font-semibold text-fg truncate">
                Tickets <span className="text-base font-normal text-fg-dim">({total})</span>
              </h1>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => setFilters((f) => ({ ...f, mine: !f.mine }))}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  filters.mine
                    ? "bg-brand text-brand-fg hover:bg-brand-bright"
                    : "bg-surface border border-border text-fg hover:bg-surface-2"
                }`}
                title="Show tickets assigned to me"
              >
                Mine
              </button>
              <button
                onClick={() => setFiltersOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm bg-surface border border-border text-fg hover:bg-surface-2"
                title="Edit ticket filters"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="w-4 h-4 text-fg-muted"
                >
                  <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                </svg>
                Filters
                {filterCount > 0 && (
                  <span className="bg-brand/15 text-brand rounded-full text-[10px] font-semibold px-1.5 py-0.5">
                    {filterCount}
                  </span>
                )}
              </button>
              <Link to="/tickets/new" className="btn-primary btn btn-sm whitespace-nowrap">
                + New
              </Link>
            </div>
          </div>

          {/* Row 2: search (full width on mobile) + secondary actions
              (desktop-only — keep mobile clean). */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[160px] md:flex-initial">
              <input
                type="text"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search…"
                className="w-full md:w-56 border border-border-strong rounded-md px-3 py-1.5 pr-7 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
              />
              {q && (
                <button
                  onClick={() => {
                    setQ("");
                    const next = new URLSearchParams(searchParams);
                    next.delete("q");
                    setSearchParams(next, { replace: true });
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-dim hover:text-fg-muted text-lg leading-none"
                >
                  ×
                </button>
              )}
            </div>
            <div className="hidden md:flex items-center gap-2">
              <SavedViewsButton
                open={savedMenuOpen}
                setOpen={setSavedMenuOpen}
                views={savedViews}
                onLoad={loadView}
                onDelete={deleteView}
                saveName={saveName}
                setSaveName={setSaveName}
                onSave={persistView}
              />
              {isAdmin && !bulkMode && (
                <button
                  onClick={() => setBulkMode(true)}
                  className="btn-secondary btn btn-sm whitespace-nowrap"
                  title="Apply status / assignee / project changes to many tickets"
                >
                  Bulk Edit
                </button>
              )}
              <ColumnPicker
                columns={TICKET_COLUMNS}
                hiddenIds={cols.hiddenIds}
                onToggle={cols.toggle}
              />
            </div>
          </div>

          {/* Breadcrumb — describes the current filter set in plain text */}
          <div className="flex items-center gap-2 text-xs text-fg-muted flex-wrap">
            <span className="text-fg-dim uppercase tracking-wider">Showing:</span>
            <span className="text-fg-muted">{summary}</span>
            {(filterCount > 0 || filters.days !== 60 || filters.sort !== "priority" || !filters.excludeClosed) && (
              <button
                onClick={() => {
                  reset();
                  setQ("");
                }}
                className="text-fg-dim hover:text-fg underline underline-offset-2"
              >
                reset
              </button>
            )}
          </div>
        </div>

        {/* Bulk edit bar */}
        {bulkMode && (
          <div className="flex items-center gap-2 flex-wrap p-3 rounded-md bg-surface-2 border border-border">
            <span className="text-sm text-fg-muted">{selectedIds.size} selected</span>
            <select
              value={bulkStatus}
              onChange={(e) => setBulkStatus(e.target.value)}
              disabled={bulkBusy}
              className="border border-border-strong rounded-md px-2 py-1.5 text-sm"
            >
              <option value="">Status — no change</option>
              {(internalStatuses || []).map((s) => (
                <option key={s.id} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
            <select
              value={bulkAssignee}
              onChange={(e) => setBulkAssignee(e.target.value)}
              disabled={bulkBusy}
              className="border border-border-strong rounded-md px-2 py-1.5 text-sm"
            >
              <option value="">Assignee — no change</option>
              <option value="0">Unassign</option>
              {bulkUsers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.display_name || u.email}
                </option>
              ))}
            </select>
            <select
              value={bulkProject}
              onChange={(e) => setBulkProject(e.target.value)}
              disabled={bulkBusy}
              className="border border-border-strong rounded-md px-2 py-1.5 text-sm"
            >
              <option value="">Project — no change</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              onClick={applyBulk}
              disabled={bulkBusy || !selectedIds.size}
              className="btn-primary btn btn-sm disabled:opacity-50"
            >
              {bulkBusy ? "Applying…" : `Apply${selectedIds.size ? ` (${selectedIds.size})` : ""}`}
            </button>
            <button
              onClick={() => setBulkReplyOpen(true)}
              disabled={bulkBusy || !selectedIds.size}
              className="btn-secondary btn btn-sm disabled:opacity-50"
              title="Post the same comment to every selected ticket"
            >
              Reply…
            </button>
            <button
              onClick={exitBulkMode}
              disabled={bulkBusy}
              className="btn-secondary btn btn-sm"
            >
              Cancel
            </button>
          </div>
        )}

        {/* Bulk reply modal */}
        {bulkReplyOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
            onClick={() => !bulkReplyBusy && setBulkReplyOpen(false)}
          >
            <div
              className="bg-surface border border-border rounded-lg shadow-xl w-full max-w-lg p-4 space-y-3"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold text-fg">
                  Reply to {selectedIds.size} ticket{selectedIds.size === 1 ? "" : "s"}
                </h3>
                <button
                  onClick={() => setBulkReplyOpen(false)}
                  disabled={bulkReplyBusy}
                  className="text-fg-dim hover:text-fg text-2xl leading-none"
                >
                  ×
                </button>
              </div>
              <textarea
                value={bulkReplyBody}
                onChange={(e) => setBulkReplyBody(e.target.value)}
                disabled={bulkReplyBusy}
                rows={6}
                placeholder="Toner has been ordered. ETA next business day."
                className="w-full border border-border-strong rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
                autoFocus
              />
              <label className="flex items-center gap-2 text-sm text-fg-muted">
                <input
                  type="checkbox"
                  checked={bulkReplyExternal}
                  onChange={(e) => setBulkReplyExternal(e.target.checked)}
                  disabled={bulkReplyBusy}
                />
                Send to vendor contacts (external visibility)
              </label>
              <p className="text-xs text-fg-dim">
                Same body is posted as a new comment on every selected ticket.
                Mentions and notifications fire per ticket.
              </p>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => setBulkReplyOpen(false)}
                  disabled={bulkReplyBusy}
                  className="btn-secondary btn btn-sm"
                >
                  Cancel
                </button>
                <button
                  onClick={applyBulkReply}
                  disabled={bulkReplyBusy || !bulkReplyBody.trim() || !selectedIds.size}
                  className="btn-primary btn btn-sm disabled:opacity-50"
                >
                  {bulkReplyBusy
                    ? "Posting…"
                    : `Post${selectedIds.size ? ` (${selectedIds.size})` : ""}`}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Table */}
        <div className="bg-surface rounded-lg border border-border shadow-sm overflow-hidden">
          {loading ? (
            <div className="text-center text-fg-dim py-12">Loading…</div>
          ) : tickets.length === 0 ? (
            <div className="text-center text-fg-dim py-12">No tickets found</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-border">
                <thead className="bg-surface-2">
                  <tr>
                    {bulkMode && (
                      <th className="px-3 py-2.5 w-8">
                        <input
                          type="checkbox"
                          aria-label="Select all on page"
                          checked={tickets.length > 0 && tickets.every((t) => selectedIds.has(t.id))}
                          onChange={(e) => {
                            setSelectedIds((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) tickets.forEach((t) => next.add(t.id));
                              else tickets.forEach((t) => next.delete(t.id));
                              return next;
                            });
                          }}
                        />
                      </th>
                    )}
                    {cols.isVisible("ref") && (
                      <th className="px-4 py-2.5">
                        <span className="text-xs font-medium text-fg-muted uppercase tracking-wide">Ref</span>
                      </th>
                    )}
                    {cols.isVisible("title") && (
                      <th className="px-4 py-2.5 text-left">
                        <span className="text-xs font-medium text-fg-muted uppercase tracking-wide">Title</span>
                      </th>
                    )}
                    {cols.isVisible("priority") && (
                      <th className="px-4 py-2.5">
                        <SortHeader col="effective_priority" label="Pri" />
                      </th>
                    )}
                    {cols.isVisible("internal") && (
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-fg-muted uppercase tracking-wide">
                        Internal
                      </th>
                    )}
                    {showVendorCols && cols.isVisible("external") && (
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-fg-muted uppercase tracking-wide">
                        External
                      </th>
                    )}
                    {cols.isVisible("vendor_ref") && (
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-fg-muted uppercase tracking-wide">
                        Vendor ref
                      </th>
                    )}
                    {cols.isVisible("alert_ref") && (
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-fg-muted uppercase tracking-wide">
                        Alert ref
                      </th>
                    )}
                    {cols.isVisible("blocker") && (
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-fg-muted uppercase tracking-wide">
                        Blocker
                      </th>
                    )}
                    {cols.isVisible("flagged") && (
                      <th className="px-4 py-2.5 text-xs font-medium text-fg-muted uppercase tracking-wide">
                        ★
                      </th>
                    )}
                    {cols.isVisible("updated") && (
                      <th className="px-4 py-2.5">
                        <SortHeader col="updated_at" label="Updated" />
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {tickets.map((t) => (
                    <tr
                      key={t.id}
                      className={`${priorityRowClass(t.effective_priority)} transition-colors`}
                    >
                      {bulkMode && (
                        <td className="px-3 py-3 w-8">
                          <input
                            type="checkbox"
                            aria-label={`Select ${t.internal_ref}`}
                            checked={selectedIds.has(t.id)}
                            onChange={() => toggleId(t.id)}
                          />
                        </td>
                      )}
                      {cols.isVisible("ref") && (
                        <td className="px-4 py-3 text-sm font-mono font-medium whitespace-nowrap">
                          <PhoneticPopover value={t.internal_ref}>
                            <Link
                              to={`/tickets/${t.id}`}
                              onClick={() => onRowOpen(t)}
                              className="text-brand hover:underline"
                            >
                              {t.internal_ref}
                            </Link>
                          </PhoneticPopover>
                        </td>
                      )}
                      {cols.isVisible("title") && (
                        <td className="px-4 py-3 text-sm text-fg w-48">
                          <Link
                            to={`/tickets/${t.id}`}
                            onClick={() => onRowOpen(t)}
                            className="hover:text-brand leading-snug"
                          >
                            {t.title}
                          </Link>
                          {t.has_fix && (
                            <span
                              className="ml-1.5 inline-flex items-center text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                              title="Fix applied — resolution recorded or KB article linked"
                            >
                              fix
                            </span>
                          )}
                        </td>
                      )}
                      {cols.isVisible("priority") && (
                        <td className="px-4 py-3 text-center">
                          <PriorityBadge
                            priority={t.effective_priority}
                            override={t.priority_override}
                            computed={t.computed_priority}
                            showOverrideInfo={false}
                          />
                        </td>
                      )}
                      {cols.isVisible("internal") && (
                        <td className="px-4 py-3">
                          <StatusBadge status={t.internal_status} />
                        </td>
                      )}
                      {showVendorCols && cols.isVisible("external") && (
                        <td className="px-4 py-3 text-sm text-fg-muted whitespace-nowrap">
                          {t.external_status}
                        </td>
                      )}
                      {cols.isVisible("vendor_ref") && (
                        <td className="px-4 py-3 text-xs font-mono text-fg-muted whitespace-nowrap">
                          {t.external_ticket_ref ? (
                            <PhoneticPopover value={t.external_ticket_ref}>
                              <span>{t.external_ticket_ref}</span>
                            </PhoneticPopover>
                          ) : (
                            <span className="text-fg-dim">—</span>
                          )}
                        </td>
                      )}
                      {cols.isVisible("alert_ref") && (
                        <td className="px-4 py-3 text-xs font-mono text-fg-muted whitespace-nowrap">
                          {t.external_ref ? (
                            <PhoneticPopover value={t.external_ref}>
                              <span>{t.external_ref}</span>
                            </PhoneticPopover>
                          ) : (
                            <span className="text-fg-dim">—</span>
                          )}
                        </td>
                      )}
                      {cols.isVisible("blocker") && (
                        <td className="px-4 py-3 text-sm">
                          {t.blocker_type === "mot_input" && (
                            <span className="text-amber-600 dark:text-amber-400 font-medium">
                              Team Input
                            </span>
                          )}
                          {t.blocker_type === "internal" && (
                            <span className="text-red-600 dark:text-red-400 font-medium">
                              {t.blocking_ticket_ref || "Internal"}
                            </span>
                          )}
                        </td>
                      )}
                      {cols.isVisible("flagged") && (
                        <td className="px-4 py-3 text-center">
                          {t.flagged_for_review ? (
                            <span className="text-purple-600 dark:text-purple-400 font-bold">★</span>
                          ) : null}
                        </td>
                      )}
                      {cols.isVisible("updated") && (
                        <td className="px-4 py-3 text-xs text-fg-muted whitespace-nowrap">
                          <DateTimeStack value={t.updated_at} />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Pagination */}
        {total > LIMIT && (
          <div className="flex items-center justify-between text-sm text-fg-muted">
            <span>
              Showing {(page - 1) * LIMIT + 1}–{Math.min(page * LIMIT, total)} of {total}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="btn-secondary btn btn-sm disabled:opacity-50"
              >
                Previous
              </button>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={page * LIMIT >= total}
                className="btn-secondary btn btn-sm disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      <TicketFiltersModal
        open={filtersOpen}
        filters={filters}
        setFilters={setFilters}
        projects={projects}
        statuses={statuses}
        onClose={() => setFiltersOpen(false)}
      />
    </PageShell>
  );
}

function SavedViewsButton({ open, setOpen, views, onLoad, onDelete, saveName, setSaveName, onSave }) {
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-sm bg-surface border border-border text-fg hover:bg-surface-2"
      >
        Saved views
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-3 h-3 text-fg-muted"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-1 w-64 bg-surface border border-border rounded-md shadow-xl z-20 overflow-hidden">
            <div className="p-2 border-b border-border">
              <div className="flex gap-1">
                <input
                  type="text"
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  placeholder="Save current as…"
                  className="flex-1 border border-border-strong rounded px-2 py-1 text-xs"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onSave();
                  }}
                />
                <button
                  onClick={onSave}
                  className="text-xs px-2 py-1 rounded bg-brand text-brand-fg hover:bg-brand-bright"
                >
                  Save
                </button>
              </div>
            </div>
            {views.length === 0 ? (
              <p className="px-3 py-3 text-xs text-fg-dim italic">No saved views yet.</p>
            ) : (
              <ul className="max-h-72 overflow-y-auto">
                {views.map((v) => (
                  <li key={v.id}>
                    <button
                      onClick={() => onLoad(v)}
                      className="w-full text-left px-3 py-1.5 text-sm hover:bg-surface-2 transition-colors flex items-center justify-between gap-2"
                    >
                      <span className="truncate">{v.name}</span>
                      <span
                        onClick={(e) => onDelete(e, v.id)}
                        className="text-fg-dim hover:text-red-500 text-xs"
                        title="Delete view"
                      >
                        ×
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

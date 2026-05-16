import React, { useEffect, useMemo, useState } from "react";
import { api } from "../utils/api";

const STORAGE_KEY = "resolvd.ticketFilters.v1";

const RANGE_OPTIONS = [
  { value: 7, label: "Last 7 days" },
  { value: 30, label: "Last 30 days" },
  { value: 60, label: "Last 60 days" },
  { value: 90, label: "Last 90 days" },
  { value: 180, label: "Last 180 days" },
  { value: 365, label: "Last 365 days" },
  { value: 0, label: "All time" },
];

const PRIORITIES = [
  { value: 1, label: "P1 — Critical" },
  { value: 2, label: "P2 — High" },
  { value: 3, label: "P3 — Medium" },
  { value: 4, label: "P4 — Low" },
  { value: 5, label: "P5 — Trivial" },
];

const SORT_OPTIONS = [
  { value: "priority", label: "Priority (P1 → P5)" },
  { value: "updated_desc", label: "Updated (newest)" },
  { value: "updated_asc", label: "Updated (oldest)" },
  { value: "created_desc", label: "Created (newest)" },
  { value: "created_asc", label: "Created (oldest)" },
];

// Default = active tickets (not Closed), last 60 days, priority sort.
// Matches the new TicketList landing state.
export const DEFAULT_TICKET_FILTERS = {
  days: 60,
  projectIds: [],
  statuses: [],
  priorities: [],
  mine: false,
  flagged: false,
  hasFix: null, // null = ignore, true = with fix, false = without
  excludeClosed: true,
  sort: "priority",
};

function readPersisted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_TICKET_FILTERS;
    const p = JSON.parse(raw);
    return { ...DEFAULT_TICKET_FILTERS, ...p };
  } catch {
    return DEFAULT_TICKET_FILTERS;
  }
}

export function useTicketFilters() {
  const [filters, setFilters] = useState(readPersisted);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
    } catch {
      /* ignore */
    }
  }, [filters]);
  return { filters, setFilters, reset: () => setFilters(DEFAULT_TICKET_FILTERS) };
}

// Translate filter state into the query string the /api/tickets endpoint
// accepts. Includes pagination + search passthrough via extras.
export function buildTicketQs(filters, extras = {}) {
  const parts = [];
  if (filters.days && filters.days > 0) {
    const iso = new Date(Date.now() - filters.days * 86_400_000).toISOString();
    parts.push(`since=${encodeURIComponent(iso)}`);
  }
  if (filters.projectIds?.length) parts.push(`project_id=${filters.projectIds.join(",")}`);
  if (filters.statuses?.length) parts.push(`internal_status=${encodeURIComponent(filters.statuses.join(","))}`);
  if (filters.priorities?.length) parts.push(`effective_priority=${filters.priorities.join(",")}`);
  if (filters.mine) parts.push(`assigned_to=me`);
  if (filters.flagged) parts.push(`flagged_for_review=true`);
  if (filters.hasFix === true) parts.push(`has_fix=1`);
  if (filters.hasFix === false) parts.push(`has_fix=0`);
  if (filters.excludeClosed) parts.push(`exclude_closed=1`);

  // Map UI sort token → backend (sort_by, sort_dir)
  const sortMap = {
    priority: ["effective_priority", "asc"],
    updated_desc: ["updated_at", "desc"],
    updated_asc: ["updated_at", "asc"],
    created_desc: ["created_at", "desc"],
    created_asc: ["created_at", "asc"],
  };
  const [sortBy, sortDir] = sortMap[filters.sort] || sortMap.priority;
  parts.push(`sort_by=${sortBy}`);
  parts.push(`sort_dir=${sortDir}`);

  for (const [k, v] of Object.entries(extras)) {
    if (v == null || v === "") continue;
    parts.push(`${k}=${encodeURIComponent(v)}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

export function summarizeFilters(filters, projects, statuses) {
  // Short human label like "Active · last 60d · 2 projects · P1 · Mine"
  const parts = [];
  if (filters.mine) parts.push("Mine");
  if (filters.excludeClosed) parts.push("Active");
  if (filters.flagged) parts.push("Flagged");
  if (filters.hasFix === true) parts.push("With fix");
  if (filters.hasFix === false) parts.push("Without fix");

  const rangeLabel =
    filters.days && filters.days > 0
      ? `last ${filters.days}d`
      : "all time";
  parts.push(rangeLabel);

  if (filters.projectIds?.length) {
    if (filters.projectIds.length === 1) {
      const p = projects.find((pp) => pp.id === filters.projectIds[0]);
      parts.push(p?.prefix || `project #${filters.projectIds[0]}`);
    } else {
      parts.push(`${filters.projectIds.length} projects`);
    }
  } else {
    parts.push("all projects");
  }

  if (filters.priorities?.length) {
    parts.push(filters.priorities.map((n) => `P${n}`).join("/"));
  }

  if (filters.statuses?.length === 1) {
    parts.push(filters.statuses[0]);
  } else if (filters.statuses?.length > 1) {
    parts.push(`${filters.statuses.length} statuses`);
  }

  return parts.join(" · ");
}

export function useTicketFilterLookups() {
  const [projects, setProjects] = useState([]);
  const [statuses, setStatuses] = useState([]);
  useEffect(() => {
    api.get("/api/projects").then((r) => setProjects(r || [])).catch(() => setProjects([]));
    api
      .get("/api/statuses")
      .then((r) => setStatuses(r?.internal || []))
      .catch(() => setStatuses([]));
  }, []);
  return { projects, statuses };
}

export function TicketFiltersModal({ open, filters, setFilters, projects, statuses, onClose }) {
  const [draft, setDraft] = useState(filters);
  // Reset draft each time the modal opens with the current applied filters.
  useEffect(() => {
    if (open) setDraft(filters);
  }, [open, filters]);

  if (!open) return null;

  function toggleArr(key, value) {
    setDraft((d) => {
      const arr = d[key] || [];
      return {
        ...d,
        [key]: arr.includes(value)
          ? arr.filter((x) => x !== value)
          : [...arr, value],
      };
    });
  }

  function apply() {
    setFilters(draft);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-lg shadow-xl border border-border w-full max-w-2xl max-h-[88vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-base font-semibold text-fg">Ticket filters</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-fg-muted hover:text-fg text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4 space-y-5">
          <section>
            <h3 className="text-xs uppercase tracking-wider text-fg-dim mb-2">Quick toggles</h3>
            <div className="flex flex-wrap gap-1.5">
              <Toggle
                label="Mine (assigned to me)"
                active={draft.mine}
                onClick={() => setDraft((d) => ({ ...d, mine: !d.mine }))}
              />
              <Toggle
                label="Active only (hide Closed)"
                active={draft.excludeClosed}
                onClick={() => setDraft((d) => ({ ...d, excludeClosed: !d.excludeClosed }))}
              />
              <Toggle
                label="Flagged for review"
                active={draft.flagged}
                onClick={() => setDraft((d) => ({ ...d, flagged: !d.flagged }))}
              />
              <Toggle
                label="Has fix applied"
                active={draft.hasFix === true}
                onClick={() => setDraft((d) => ({ ...d, hasFix: d.hasFix === true ? null : true }))}
              />
              <Toggle
                label="No fix yet"
                active={draft.hasFix === false}
                onClick={() => setDraft((d) => ({ ...d, hasFix: d.hasFix === false ? null : false }))}
              />
            </div>
          </section>

          <section>
            <h3 className="text-xs uppercase tracking-wider text-fg-dim mb-2">Date range</h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
              {RANGE_OPTIONS.map((r) => (
                <Toggle
                  key={r.value}
                  label={r.label}
                  active={draft.days === r.value}
                  onClick={() => setDraft((d) => ({ ...d, days: r.value }))}
                />
              ))}
            </div>
          </section>

          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs uppercase tracking-wider text-fg-dim">Projects</h3>
              {draft.projectIds.length > 0 && (
                <button
                  onClick={() => setDraft((d) => ({ ...d, projectIds: [] }))}
                  className="text-xs text-fg-dim hover:text-fg"
                >
                  clear
                </button>
              )}
            </div>
            {projects.length === 0 ? (
              <p className="text-xs text-fg-dim">No projects available.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5 max-h-44 overflow-y-auto">
                {projects.map((p) => (
                  <Toggle
                    key={p.id}
                    label={
                      <>
                        <span className="font-mono mr-1">{p.prefix}</span>
                        <span className="truncate max-w-[140px] align-middle inline-block">{p.name}</span>
                      </>
                    }
                    active={draft.projectIds.includes(p.id)}
                    onClick={() => toggleArr("projectIds", p.id)}
                  />
                ))}
              </div>
            )}
          </section>

          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs uppercase tracking-wider text-fg-dim">Priorities</h3>
              {draft.priorities.length > 0 && (
                <button
                  onClick={() => setDraft((d) => ({ ...d, priorities: [] }))}
                  className="text-xs text-fg-dim hover:text-fg"
                >
                  clear
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {PRIORITIES.map((p) => (
                <Toggle
                  key={p.value}
                  label={p.label}
                  active={draft.priorities.includes(p.value)}
                  onClick={() => toggleArr("priorities", p.value)}
                />
              ))}
            </div>
          </section>

          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs uppercase tracking-wider text-fg-dim">Statuses</h3>
              {draft.statuses.length > 0 && (
                <button
                  onClick={() => setDraft((d) => ({ ...d, statuses: [] }))}
                  className="text-xs text-fg-dim hover:text-fg"
                >
                  clear
                </button>
              )}
            </div>
            {statuses.length === 0 ? (
              <p className="text-xs text-fg-dim">No statuses loaded.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {statuses.map((s) => (
                  <Toggle
                    key={s.id}
                    label={
                      <>
                        <span
                          className="inline-block w-2 h-2 rounded-sm mr-1.5 align-middle"
                          style={{ backgroundColor: s.color || "#94a3b8" }}
                        />
                        {s.name}
                      </>
                    }
                    active={draft.statuses.includes(s.name)}
                    onClick={() => toggleArr("statuses", s.name)}
                  />
                ))}
              </div>
            )}
          </section>

          <section>
            <h3 className="text-xs uppercase tracking-wider text-fg-dim mb-2">Sort</h3>
            <select
              value={draft.sort}
              onChange={(e) => setDraft((d) => ({ ...d, sort: e.target.value }))}
              className="bg-surface-2 border border-border rounded-md px-3 py-1.5 text-sm text-fg"
            >
              {SORT_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </section>
        </div>

        <div className="px-5 py-3 border-t border-border flex items-center justify-between gap-2 bg-surface-2/50">
          <button
            type="button"
            onClick={() => setDraft(DEFAULT_TICKET_FILTERS)}
            className="text-sm text-fg-dim hover:text-fg"
          >
            Reset to defaults
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-md text-sm bg-surface border border-border text-fg hover:bg-surface-2"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={apply}
              className="px-3 py-1.5 rounded-md text-sm font-medium bg-brand text-brand-fg hover:bg-brand-bright"
            >
              Apply
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Toggle({ label, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-xs rounded-full px-2.5 py-1 border transition-colors ${
        active
          ? "bg-brand text-brand-fg border-brand"
          : "bg-surface border-border text-fg hover:bg-surface-2"
      }`}
    >
      {label}
    </button>
  );
}

import React, { useEffect, useMemo, useState } from "react";
import { api } from "../utils/api";

const STORAGE_KEY = "resolvd.dashboardFilters.v1";

const RANGE_OPTIONS = [
  { value: 7, label: "Last 7 days" },
  { value: 30, label: "Last 30 days" },
  { value: 60, label: "Last 60 days" },
  { value: 90, label: "Last 90 days" },
  { value: 180, label: "Last 180 days" },
  { value: 365, label: "Last 365 days" },
  { value: 0, label: "All time" },
];

const DEFAULT_FILTERS = { days: 30, projectIds: [], statuses: [] };

function readPersisted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_FILTERS;
    const parsed = JSON.parse(raw);
    return {
      days: typeof parsed.days === "number" ? parsed.days : DEFAULT_FILTERS.days,
      projectIds: Array.isArray(parsed.projectIds) ? parsed.projectIds : [],
      statuses: Array.isArray(parsed.statuses) ? parsed.statuses : [],
    };
  } catch {
    return DEFAULT_FILTERS;
  }
}

// Single source of truth for dashboard filters. Persisted in localStorage
// so a hard refresh keeps the user's choice; modules consume `filters`
// directly and translate it into query-string params via `buildQs`.
export function useDashboardFilters() {
  const [filters, setFilters] = useState(readPersisted);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
    } catch {
      /* quota / private mode — ignore */
    }
  }, [filters]);

  function reset() {
    setFilters(DEFAULT_FILTERS);
  }

  return { filters, setFilters, reset };
}

// Convert filter state into a query-string fragment matching what the
// backend endpoints accept (?since=ISO&project_id=1,2&status=A,B). days=0
// means "all time" — omit since entirely so we don't truncate history.
export function buildQs(filters, extras = {}) {
  const parts = [];
  if (filters.days && filters.days > 0) {
    const iso = new Date(Date.now() - filters.days * 86_400_000).toISOString();
    parts.push(`since=${encodeURIComponent(iso)}`);
  }
  if (filters.projectIds?.length) {
    parts.push(`project_id=${filters.projectIds.join(",")}`);
  }
  if (filters.statuses?.length) {
    parts.push(`status=${encodeURIComponent(filters.statuses.join(","))}`);
  }
  for (const [k, v] of Object.entries(extras)) {
    if (v == null) continue;
    parts.push(`${k}=${encodeURIComponent(v)}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

function rangeLabel(days) {
  const opt = RANGE_OPTIONS.find((o) => o.value === days);
  return opt ? opt.label : `Last ${days} days`;
}

// Chip-row above the dashboard modules. Shows active filters with
// individual quick-clears, plus an Edit button that opens the modal.
export function DashboardFiltersBar({ filters, setFilters, projects, statuses }) {
  const [open, setOpen] = useState(false);

  function clearProject(id) {
    setFilters((f) => ({ ...f, projectIds: f.projectIds.filter((x) => x !== id) }));
  }
  function clearStatus(name) {
    setFilters((f) => ({ ...f, statuses: f.statuses.filter((x) => x !== name) }));
  }

  const projectMap = useMemo(() => {
    const m = new Map();
    projects.forEach((p) => m.set(p.id, p));
    return m;
  }, [projects]);

  const noFilters =
    filters.days === 30 && !filters.projectIds.length && !filters.statuses.length;

  return (
    <>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm bg-surface border border-border hover:bg-surface-2 transition-colors"
          title="Edit dashboard filters"
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
        </button>

        <span className="text-xs rounded-full bg-brand/10 text-brand px-2 py-0.5 font-medium">
          {rangeLabel(filters.days)}
        </span>

        {filters.projectIds.map((id) => {
          const p = projectMap.get(id);
          return (
            <span
              key={`p-${id}`}
              className="inline-flex items-center gap-1 text-xs rounded-full bg-surface-2 border border-border px-2 py-0.5 text-fg"
            >
              <span className="font-mono text-fg-muted">{p?.prefix || `#${id}`}</span>
              {p?.name && <span className="text-fg-muted">·</span>}
              {p?.name && <span className="truncate max-w-[120px]">{p.name}</span>}
              <button
                type="button"
                onClick={() => clearProject(id)}
                className="text-fg-dim hover:text-fg ml-0.5"
                aria-label="Remove project filter"
              >
                ×
              </button>
            </span>
          );
        })}

        {filters.statuses.map((s) => (
          <span
            key={`s-${s}`}
            className="inline-flex items-center gap-1 text-xs rounded-full bg-surface-2 border border-border px-2 py-0.5 text-fg"
          >
            {s}
            <button
              type="button"
              onClick={() => clearStatus(s)}
              className="text-fg-dim hover:text-fg ml-0.5"
              aria-label="Remove status filter"
            >
              ×
            </button>
          </span>
        ))}

        {!noFilters && (
          <button
            type="button"
            onClick={() => setFilters(DEFAULT_FILTERS)}
            className="text-xs text-fg-dim hover:text-fg ml-1"
          >
            Reset
          </button>
        )}
      </div>

      {open && (
        <FiltersModal
          filters={filters}
          setFilters={setFilters}
          projects={projects}
          statuses={statuses}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function FiltersModal({ filters, setFilters, projects, statuses, onClose }) {
  // Draft state — only commit to parent on Apply so the user can back
  // out of an in-progress edit without losing their previous filter.
  const [draft, setDraft] = useState(filters);

  function toggleProject(id) {
    setDraft((d) => ({
      ...d,
      projectIds: d.projectIds.includes(id)
        ? d.projectIds.filter((x) => x !== id)
        : [...d.projectIds, id],
    }));
  }
  function toggleStatus(name) {
    setDraft((d) => ({
      ...d,
      statuses: d.statuses.includes(name)
        ? d.statuses.filter((x) => x !== name)
        : [...d.statuses, name],
    }));
  }
  function apply() {
    setFilters(draft);
    onClose();
  }
  function reset() {
    setDraft(DEFAULT_FILTERS);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-lg shadow-xl border border-border w-full max-w-lg max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-base font-semibold text-fg">Dashboard filters</h2>
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
            <h3 className="text-xs uppercase tracking-wider text-fg-dim mb-2">
              Date range
            </h3>
            <div className="grid grid-cols-2 gap-1.5">
              {RANGE_OPTIONS.map((r) => (
                <button
                  key={r.value}
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, days: r.value }))}
                  className={`text-sm px-3 py-1.5 rounded-md border transition-colors ${
                    draft.days === r.value
                      ? "bg-brand text-brand-fg border-brand"
                      : "bg-surface border-border text-fg hover:bg-surface-2"
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </section>

          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs uppercase tracking-wider text-fg-dim">
                Projects
              </h3>
              {draft.projectIds.length > 0 && (
                <button
                  type="button"
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
                {projects.map((p) => {
                  const active = draft.projectIds.includes(p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => toggleProject(p.id)}
                      className={`inline-flex items-center gap-1 text-xs rounded-full px-2 py-1 border transition-colors ${
                        active
                          ? "bg-brand text-brand-fg border-brand"
                          : "bg-surface border-border text-fg hover:bg-surface-2"
                      }`}
                      title={p.name}
                    >
                      <span className="font-mono">{p.prefix}</span>
                      <span className="truncate max-w-[140px]">{p.name}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs uppercase tracking-wider text-fg-dim">
                Ticket statuses
              </h3>
              {draft.statuses.length > 0 && (
                <button
                  type="button"
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
                {statuses.map((s) => {
                  const active = draft.statuses.includes(s.name);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => toggleStatus(s.name)}
                      className={`inline-flex items-center gap-1.5 text-xs rounded-full px-2.5 py-1 border transition-colors ${
                        active
                          ? "bg-brand text-brand-fg border-brand"
                          : "bg-surface border-border text-fg hover:bg-surface-2"
                      }`}
                    >
                      <span
                        className="inline-block w-2 h-2 rounded-sm"
                        style={{ backgroundColor: s.color || "#94a3b8" }}
                      />
                      {s.name}
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        <div className="px-5 py-3 border-t border-border flex items-center justify-between gap-2 bg-surface-2/50">
          <button
            type="button"
            onClick={reset}
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

// Loads the project + status lookups the modal needs. Cached at the
// dashboard root so modules don't each re-fetch.
export function useFilterLookups() {
  const [projects, setProjects] = useState([]);
  const [statuses, setStatuses] = useState([]);

  useEffect(() => {
    api.get("/api/projects").then((r) => setProjects(r || [])).catch(() => setProjects([]));
    api.get("/api/statuses").then((r) => setStatuses(r?.internal || [])).catch(() => setStatuses([]));
  }, []);

  return { projects, statuses };
}

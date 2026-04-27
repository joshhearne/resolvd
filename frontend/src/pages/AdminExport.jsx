import React, { useState, useMemo, useEffect } from "react";
import { useStatuses } from "../context/StatusesContext";
import { useAuth } from "../context/AuthContext";
import { api } from "../utils/api";

function toDateInput(d) {
  return d.toISOString().slice(0, 10);
}

function defaultDateRange() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 7);
  return { from: toDateInput(from), to: toDateInput(to) };
}

export default function AdminExport() {
  const { user } = useAuth();
  const { internal } = useStatuses();

  const STATUS_OPTIONS = useMemo(
    () =>
      internal.length
        ? internal.map((s) => ({ value: s.name, label: s.name, terminal: s.is_terminal }))
        : [
            { value: "Open", label: "Open" },
            { value: "In Progress", label: "In Progress" },
            { value: "Awaiting Input", label: "Awaiting Input" },
            { value: "Pending Review", label: "Pending Review" },
            { value: "Reopened", label: "Reopened" },
            { value: "Closed", label: "Closed", terminal: true },
          ],
    [internal],
  );

  const defaultSelection = useMemo(
    () => new Set(STATUS_OPTIONS.filter((s) => !s.terminal).map((s) => s.value)),
    [STATUS_OPTIONS],
  );

  const [selected, setSelected] = useState(defaultSelection);
  useEffect(() => { setSelected(defaultSelection); }, [defaultSelection]);

  const [projects, setProjects] = useState([]);
  const [selectedProjects, setSelectedProjects] = useState(new Set());

  // External status + company options (loaded when project selection changes)
  const [externalStatusOptions, setExternalStatusOptions] = useState([]);
  const [selectedExternal, setSelectedExternal] = useState(new Set());
  const [statusLogic, setStatusLogic] = useState("OR");
  const [companyOptions, setCompanyOptions] = useState([]);
  const [selectedCompanies, setSelectedCompanies] = useState(new Set());

  const [dateRange, setDateRange] = useState(defaultDateRange());
  const [loading, setLoading] = useState(false);
  const [previewCount, setPreviewCount] = useState(null);
  const [counted, setCounted] = useState(false);

  useEffect(() => {
    api.get("/api/projects")
      .then((all) => {
        const active = all.filter((p) => p.status === "active");
        setProjects(active);
        const defaultId = user?.defaultProjectId;
        const hasDefault = defaultId && active.find((p) => p.id === defaultId);
        setSelectedProjects(
          hasDefault ? new Set([defaultId]) : new Set(active.map((p) => p.id)),
        );
      })
      .catch(() => {});
  }, [user?.defaultProjectId]);

  // Load external status + company options whenever project selection changes
  useEffect(() => {
    if (!selectedProjects.size) { setExternalStatusOptions([]); setCompanyOptions([]); return; }
    const ids = [...selectedProjects].join(",");
    api.get(`/api/export/options?project_ids=${ids}`)
      .then(({ external_statuses, companies }) => {
        setExternalStatusOptions(external_statuses || []);
        setCompanyOptions(companies || []);
      })
      .catch(() => {});
  }, [selectedProjects]);

  function resetCount() { setCounted(false); setPreviewCount(null); }

  function toggle(val) { setSelected(prev => { const n = new Set(prev); n.has(val) ? n.delete(val) : n.add(val); return n; }); resetCount(); }
  function selectAll() { setSelected(new Set(STATUS_OPTIONS.map((s) => s.value))); resetCount(); }
  function selectNone() { setSelected(new Set()); resetCount(); }

  function toggleExternal(val) { setSelectedExternal(prev => { const n = new Set(prev); n.has(val) ? n.delete(val) : n.add(val); return n; }); resetCount(); }

  function toggleProject(id) { setSelectedProjects(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; }); resetCount(); }
  function selectAllProjects() { setSelectedProjects(new Set(projects.map((p) => p.id))); resetCount(); }
  function selectNoProjects() { setSelectedProjects(new Set()); resetCount(); }

  function toggleCompany(id) { setSelectedCompanies(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; }); resetCount(); }

  function setDate(field, val) { setDateRange((r) => ({ ...r, [field]: val })); resetCount(); }

  function buildQS() {
    const statuses = [...selected].join(",");
    const extStatuses = [...selectedExternal].join(",");
    const allProjectsSelected = selectedProjects.size === projects.length;
    const projectParam = allProjectsSelected ? "" : `&project_ids=${[...selectedProjects].join(",")}`;
    const dateParam = `&updated_from=${dateRange.from}&updated_to=${dateRange.to}`;
    const extParam = extStatuses ? `&external_statuses=${encodeURIComponent(extStatuses)}&status_logic=${statusLogic}` : "";
    const coParam = selectedCompanies.size ? `&company_ids=${[...selectedCompanies].join(",")}` : "";
    return { statuses, projectParam, dateParam, extParam, coParam };
  }

  async function previewCount_() {
    if (!selectedProjects.size) return;
    if (!selected.size && !selectedExternal.size) return;
    setLoading(true);
    try {
      const { statuses, projectParam, dateParam, extParam, coParam } = buildQS();
      const statusPart = statuses ? `statuses=${encodeURIComponent(statuses)}` : "";
      const res = await fetch(
        `/api/export/tickets?${statusPart}${projectParam}${dateParam}${extParam}${coParam}`,
        { credentials: "include" },
      );
      const data = await res.json();
      setPreviewCount(Array.isArray(data) ? data.length : 0);
      setCounted(true);
    } catch { setPreviewCount(null); }
    finally { setLoading(false); }
  }

  function openExport() {
    const { statuses, projectParam, dateParam, extParam, coParam } = buildQS();
    const statusPart = statuses ? `statuses=${encodeURIComponent(statuses)}` : "";
    window.open(
      `/print-export?${statusPart}${projectParam}${dateParam}${extParam}${coParam}`,
      "_blank",
    );
  }

  const canExport = (selected.size > 0 || selectedExternal.size > 0) && selectedProjects.size > 0;

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-fg">Export Tickets</h1>

      {/* Project filter */}
      {projects.length > 1 && (
        <div className="bg-surface rounded-lg border border-border p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-fg">Projects</h2>
            <div className="flex gap-2 text-xs">
              <button onClick={selectAllProjects} className="text-brand hover:underline">All</button>
              <span className="text-fg-dim">|</span>
              <button onClick={selectNoProjects} className="text-brand hover:underline">None</button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {projects.map((p) => (
              <label key={p.id} className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={selectedProjects.has(p.id)} onChange={() => toggleProject(p.id)}
                  className="h-4 w-4 rounded border-border-strong text-brand focus:ring-brand/40" />
                <span className="text-sm text-fg">
                  <span className="font-mono text-xs text-fg-dim mr-1">{p.prefix}</span>
                  {p.name}
                  {user?.defaultProjectId === p.id && <span className="ml-1 text-amber-500">★</span>}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Date range */}
      <div className="bg-surface rounded-lg border border-border p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-fg">Date range</h2>
          <span className="text-xs text-fg-dim">Filters by last updated date</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <label className="block text-xs font-medium text-fg-muted mb-1">From</label>
            <input type="date" value={dateRange.from} onChange={(e) => setDate("from", e.target.value)}
              className="w-full border border-border-strong rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40" />
          </div>
          <span className="text-fg-dim mt-5">→</span>
          <div className="flex-1">
            <label className="block text-xs font-medium text-fg-muted mb-1">To</label>
            <input type="date" value={dateRange.to} onChange={(e) => setDate("to", e.target.value)}
              className="w-full border border-border-strong rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40" />
          </div>
        </div>
        <div className="flex gap-2 text-xs">
          {[7, 14, 30, 90].map((days) => (
            <button key={days} onClick={() => {
              const to = new Date(); const from = new Date();
              from.setDate(from.getDate() - days);
              setDateRange({ from: toDateInput(from), to: toDateInput(to) }); resetCount();
            }} className="px-2 py-1 rounded border border-border text-fg-muted hover:border-brand/50 hover:text-brand">
              Last {days}d
            </button>
          ))}
        </div>
      </div>

      {/* Internal status filter */}
      <div className="bg-surface rounded-lg border border-border p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-fg">Internal statuses</h2>
          <div className="flex gap-2 text-xs">
            <button onClick={selectAll} className="text-brand hover:underline">All</button>
            <span className="text-fg-dim">|</span>
            <button onClick={selectNone} className="text-brand hover:underline">None</button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {STATUS_OPTIONS.map((opt) => (
            <label key={opt.value} className="flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" checked={selected.has(opt.value)} onChange={() => toggle(opt.value)}
                className="h-4 w-4 rounded border-border-strong text-brand focus:ring-brand/40" />
              <span className="text-sm text-fg">{opt.label}</span>
            </label>
          ))}
        </div>
      </div>

      {/* AND/OR logic toggle — only shown when external statuses exist */}
      {externalStatusOptions.length > 0 && (selected.size > 0 || selectedExternal.size > 0) && (
        <div className="flex items-center gap-3 bg-surface-2 border border-border rounded-lg px-4 py-3">
          <span className="text-xs font-medium text-fg-muted">Status match logic:</span>
          {["OR", "AND"].map((opt) => (
            <label key={opt} className="flex items-center gap-1.5 cursor-pointer text-sm">
              <input type="radio" name="status_logic" value={opt} checked={statusLogic === opt}
                onChange={() => { setStatusLogic(opt); resetCount(); }} />
              <span className={statusLogic === opt ? "text-fg font-medium" : "text-fg-muted"}>
                {opt === "OR" ? "OR — match either status" : "AND — match both statuses"}
              </span>
            </label>
          ))}
        </div>
      )}

      {/* External status filter */}
      {externalStatusOptions.length > 0 && (
        <div className="bg-surface rounded-lg border border-border p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-fg">External statuses</h2>
            <div className="flex gap-2 text-xs">
              <button onClick={() => { setSelectedExternal(new Set(externalStatusOptions)); resetCount(); }} className="text-brand hover:underline">All</button>
              <span className="text-fg-dim">|</span>
              <button onClick={() => { setSelectedExternal(new Set()); resetCount(); }} className="text-brand hover:underline">None</button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {externalStatusOptions.map((s) => (
              <label key={s} className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={selectedExternal.has(s)} onChange={() => toggleExternal(s)}
                  className="h-4 w-4 rounded border-border-strong text-brand focus:ring-brand/40" />
                <span className="text-sm text-fg">{s}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Company filter */}
      {companyOptions.length > 0 && (
        <div className="bg-surface rounded-lg border border-border p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-fg">Filter by company</h2>
            <span className="text-xs text-fg-dim">Only tickets with a contact from these companies</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {companyOptions.map((c) => (
              <label key={c.id} className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={selectedCompanies.has(c.id)} onChange={() => toggleCompany(c.id)}
                  className="h-4 w-4 rounded border-border-strong text-brand focus:ring-brand/40" />
                <span className="text-sm text-fg">{c.name}</span>
              </label>
            ))}
          </div>
          {selectedCompanies.size > 0 && (
            <button onClick={() => { setSelectedCompanies(new Set()); resetCount(); }}
              className="text-xs text-fg-muted hover:text-fg">Clear company filter</button>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="bg-surface rounded-lg border border-border p-6 space-y-3">
        <p className="text-xs text-fg-muted">
          Export order: <strong>Blocked</strong> → <strong>Active</strong> → <strong>Closed</strong>.
          Within each group: priority then ticket number.
        </p>
        <div className="flex items-center gap-3">
          <button onClick={previewCount_} disabled={!canExport || loading} className="btn-secondary btn-sm btn">
            {loading ? "Counting…" : "Preview count"}
          </button>
          {counted && previewCount !== null && (
            <span className="text-sm text-fg-muted">
              <strong>{previewCount}</strong> ticket{previewCount !== 1 ? "s" : ""} will be exported
            </span>
          )}
        </div>
        <button onClick={openExport} disabled={!canExport} className="btn-primary btn w-full justify-center">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
          </svg>
          Generate Export
        </button>
      </div>
    </div>
  );
}

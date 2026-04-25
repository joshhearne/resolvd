import React, { useState, useMemo, useEffect } from 'react';
import { useStatuses } from '../context/StatusesContext';
import { useAuth } from '../context/AuthContext';
import { api } from '../utils/api';

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
    () => internal.length
      ? internal.map(s => ({ value: s.name, label: s.name, terminal: s.is_terminal }))
      : [
          { value: 'Open', label: 'Open' },
          { value: 'In Progress', label: 'In Progress' },
          { value: 'Awaiting Input', label: 'Awaiting Input' },
          { value: 'Pending Review', label: 'Pending Review' },
          { value: 'Reopened', label: 'Reopened' },
          { value: 'Closed', label: 'Closed', terminal: true },
        ],
    [internal]
  );
  const defaultSelection = useMemo(
    () => new Set(STATUS_OPTIONS.filter(s => !s.terminal).map(s => s.value)),
    [STATUS_OPTIONS]
  );
  const [selected, setSelected] = useState(defaultSelection);
  useEffect(() => { setSelected(defaultSelection); }, [defaultSelection]);

  const [projects, setProjects] = useState([]);
  const [selectedProjects, setSelectedProjects] = useState(new Set());

  useEffect(() => {
    api.get('/api/projects')
      .then(all => {
        const active = all.filter(p => p.status === 'active');
        setProjects(active);
        // Pre-select default project if starred, otherwise all
        const defaultId = user?.defaultProjectId;
        const hasDefault = defaultId && active.find(p => p.id === defaultId);
        setSelectedProjects(hasDefault ? new Set([defaultId]) : new Set(active.map(p => p.id)));
      })
      .catch(() => {});
  }, [user?.defaultProjectId]);

  const [dateRange, setDateRange] = useState(defaultDateRange());

  const [loading, setLoading] = useState(false);
  const [previewCount, setPreviewCount] = useState(null);
  const [counted, setCounted] = useState(false);

  function resetCount() { setCounted(false); setPreviewCount(null); }

  function toggle(val) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(val) ? next.delete(val) : next.add(val);
      return next;
    });
    resetCount();
  }

  function selectAll() { setSelected(new Set(STATUS_OPTIONS.map(s => s.value))); resetCount(); }
  function selectNone() { setSelected(new Set()); resetCount(); }

  function toggleProject(id) {
    setSelectedProjects(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
    resetCount();
  }

  function selectAllProjects() { setSelectedProjects(new Set(projects.map(p => p.id))); resetCount(); }
  function selectNoProjects() { setSelectedProjects(new Set()); resetCount(); }

  function setDate(field, val) { setDateRange(r => ({ ...r, [field]: val })); resetCount(); }

  function buildQS() {
    const statuses = [...selected].join(',');
    const allProjectsSelected = selectedProjects.size === projects.length;
    const projectParam = allProjectsSelected ? '' : `&project_ids=${[...selectedProjects].join(',')}`;
    const dateParam = `&updated_from=${dateRange.from}&updated_to=${dateRange.to}`;
    return { statuses, projectParam, dateParam };
  }

  async function previewCount_() {
    if (!selected.size || !selectedProjects.size) return;
    setLoading(true);
    try {
      const { statuses, projectParam, dateParam } = buildQS();
      const res = await fetch(
        `/api/export/tickets?statuses=${encodeURIComponent(statuses)}${projectParam}${dateParam}`,
        { credentials: 'include' }
      );
      const data = await res.json();
      setPreviewCount(Array.isArray(data) ? data.length : 0);
      setCounted(true);
    } catch {
      setPreviewCount(null);
    } finally {
      setLoading(false);
    }
  }

  function openExport() {
    const { statuses, projectParam, dateParam } = buildQS();
    window.open(`/print-export?statuses=${encodeURIComponent(statuses)}${projectParam}${dateParam}`, '_blank');
  }

  const canExport = selected.size > 0 && selectedProjects.size > 0;

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Export Tickets</h1>

      {/* Project filter */}
      {projects.length > 1 && (
        <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-gray-800">Projects</h2>
            <div className="flex gap-2 text-xs">
              <button onClick={selectAllProjects} className="text-blue-600 hover:underline">All</button>
              <span className="text-gray-300">|</span>
              <button onClick={selectNoProjects} className="text-blue-600 hover:underline">None</button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {projects.map(p => (
              <label key={p.id} className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={selectedProjects.has(p.id)}
                  onChange={() => toggleProject(p.id)}
                  className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">
                  <span className="font-mono text-xs text-gray-400 mr-1">{p.prefix}</span>
                  {p.name}
                  {user?.defaultProjectId === p.id && <span className="ml-1 text-amber-500">★</span>}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Date range */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-800">Date range</h2>
          <span className="text-xs text-gray-400">Filters by last updated date</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <label className="block text-xs font-medium text-gray-500 mb-1">From</label>
            <input type="date" value={dateRange.from} onChange={e => setDate('from', e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <span className="text-gray-400 mt-5">→</span>
          <div className="flex-1">
            <label className="block text-xs font-medium text-gray-500 mb-1">To</label>
            <input type="date" value={dateRange.to} onChange={e => setDate('to', e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
        </div>
        <div className="flex gap-2 text-xs">
          {[7, 14, 30, 90].map(days => (
            <button key={days} onClick={() => {
              const to = new Date();
              const from = new Date();
              from.setDate(from.getDate() - days);
              setDateRange({ from: toDateInput(from), to: toDateInput(to) });
              resetCount();
            }} className="px-2 py-1 rounded border border-gray-200 text-gray-600 hover:border-blue-400 hover:text-blue-600">
              Last {days}d
            </button>
          ))}
        </div>
      </div>

      {/* Status filter */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-800">Select statuses to include</h2>
          <div className="flex gap-2 text-xs">
            <button onClick={selectAll} className="text-blue-600 hover:underline">All</button>
            <span className="text-gray-300">|</span>
            <button onClick={selectNone} className="text-blue-600 hover:underline">None</button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {STATUS_OPTIONS.map(opt => (
            <label key={opt.value} className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={selected.has(opt.value)}
                onChange={() => toggle(opt.value)}
                className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm text-gray-700">{opt.label}</span>
            </label>
          ))}
        </div>

        <div className="pt-2 border-t border-gray-100 space-y-3">
          <p className="text-xs text-gray-500">
            Export order: <strong>Blocked</strong> → <strong>Active</strong> → <strong>Closed</strong>.
            Within each group: priority then ticket number.
          </p>

          <div className="flex items-center gap-3">
            <button
              onClick={previewCount_}
              disabled={!canExport || loading}
              className="btn-secondary btn-sm btn"
            >
              {loading ? 'Counting…' : 'Preview count'}
            </button>
            {counted && previewCount !== null && (
              <span className="text-sm text-gray-600">
                <strong>{previewCount}</strong> ticket{previewCount !== 1 ? 's' : ''} will be exported
              </span>
            )}
          </div>

          <button
            onClick={openExport}
            disabled={!canExport}
            className="btn-primary btn w-full justify-center"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
            </svg>
            Generate Export
          </button>
        </div>
      </div>
    </div>
  );
}

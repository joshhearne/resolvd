import React, { useState, useMemo, useEffect } from 'react';
import { useStatuses } from '../context/StatusesContext';

export default function AdminExport() {
  const { internal } = useStatuses();
  const STATUS_OPTIONS = useMemo(
    () => internal.length
      ? internal.map(s => ({ value: s.name, label: s.name, terminal: s.is_terminal }))
      : [
          { value: 'Open', label: 'Open' },
          { value: 'In Progress', label: 'In Progress' },
          { value: 'Awaiting MOT Input', label: 'Awaiting MOT Input' },
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
  const [loading, setLoading] = useState(false);
  const [previewCount, setPreviewCount] = useState(null);
  const [counted, setCounted] = useState(false);

  function toggle(val) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(val) ? next.delete(val) : next.add(val);
      return next;
    });
    setCounted(false);
    setPreviewCount(null);
  }

  function selectAll() {
    setSelected(new Set(STATUS_OPTIONS.map(s => s.value)));
    setCounted(false);
  }

  function selectNone() {
    setSelected(new Set());
    setCounted(false);
  }

  async function previewCount_() {
    if (!selected.size) return;
    setLoading(true);
    try {
      const statuses = [...selected].join(',');
      const res = await fetch(`/api/export/tickets?statuses=${encodeURIComponent(statuses)}`, {
        credentials: 'include',
      });
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
    const statuses = [...selected].join(',');
    window.open(`/print-export?statuses=${encodeURIComponent(statuses)}`, '_blank');
  }

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Export Tickets</h1>

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
            Export order: <strong>Blocked</strong> → <strong>Active</strong> (open/in-progress/reopened/awaiting) → <strong>Closed</strong>.
            Within each group: priority then ticket number. Reopened tickets show a red banner with reviewer notes and inline screenshots.
          </p>

          <div className="flex items-center gap-3">
            <button
              onClick={previewCount_}
              disabled={!selected.size || loading}
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
            disabled={!selected.size}
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

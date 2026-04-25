import React from 'react';
import { statusClass } from '../utils/helpers';
import { useStatuses, statusByName } from '../context/StatusesContext';

// Renders a colored status pill. Looks up the configured color from
// /api/statuses; falls back to the legacy CSS class for unknown/legacy names.
export default function StatusBadge({ status, kind = 'internal' }) {
  const list = useStatuses();
  const def = statusByName(kind === 'external' ? list.external : list.internal, status);

  if (def) {
    return (
      <span
        className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border"
        style={{ borderColor: def.color, color: def.color, backgroundColor: `${def.color}14` }}
      >
        {status}
      </span>
    );
  }
  return <span className={`status-badge ${statusClass(status)}`}>{status}</span>;
}

import React from 'react';
import { priorityLabel, priorityClass } from '../utils/helpers';

export default function PriorityBadge({ priority, override, computed, showOverrideInfo = true }) {
  const effective = override ?? priority;
  const label = priorityLabel(effective);
  const cls = priorityClass(effective);

  if (override !== null && override !== undefined && showOverrideInfo) {
    return (
      <span className="inline-flex items-center gap-1">
        <span className={`priority-badge ${cls}`} title={`Computed: P${computed}`}>
          {label} <span className="opacity-70 text-xs">(Override)</span>
        </span>
      </span>
    );
  }

  return <span className={`priority-badge ${cls}`}>{label}</span>;
}

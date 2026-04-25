import React from 'react';
import { statusClass } from '../utils/helpers';

export default function StatusBadge({ status }) {
  return (
    <span className={`status-badge ${statusClass(status)}`}>{status}</span>
  );
}

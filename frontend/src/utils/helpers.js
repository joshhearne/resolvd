export function priorityLabel(p) {
  return `P${p}`;
}

export function priorityClass(p) {
  return `p${p}`;
}

export function brandingLogoFilter(branding, resolvedTheme) {
  if (!branding) return null;
  const designedFor = branding.logo_designed_for || (branding.logo_on_dark ? 'dark' : 'light');
  if (designedFor === 'light' && resolvedTheme === 'dark') return 'invert(1) hue-rotate(180deg)';
  if (designedFor === 'dark' && resolvedTheme === 'light') return 'invert(1) hue-rotate(180deg)';
  return null;
}

export function priorityRowClass(p) {
  if (p === 1) return 'bg-red-500/[0.06] hover:bg-red-500/[0.12] dark:bg-red-500/10 dark:hover:bg-red-500/[0.18]';
  if (p === 2) return 'bg-orange-500/[0.06] hover:bg-orange-500/[0.12] dark:bg-orange-500/10 dark:hover:bg-orange-500/[0.18]';
  if (p === 3) return 'bg-yellow-500/[0.06] hover:bg-yellow-500/[0.12] dark:bg-yellow-500/[0.08] dark:hover:bg-yellow-500/[0.14]';
  return 'hover:bg-surface-2';
}

export function statusClass(status) {
  const map = {
    'Open': 'status-open',
    'In Progress': 'status-in-progress',
    'Awaiting Input': 'status-awaiting',
    'Pending Review': 'status-pending-review',
    'Closed': 'status-closed',
    'Reopened': 'status-reopened',
  };
  return map[status] || 'status-open';
}

export function formatDateTime(dt) {
  if (!dt) return '—';
  // Times stored as UTC, display in US/Central
  const d = new Date(dt.endsWith('Z') ? dt : dt + 'Z');
  return d.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

export function formatDate(dt) {
  if (!dt) return '—';
  const d = new Date(dt.endsWith('Z') ? dt : dt + 'Z');
  return d.toLocaleDateString('en-US', {
    timeZone: 'America/Chicago',
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

export function computePriority(impact, urgency) {
  return Math.min(Math.max(Number(impact) + Number(urgency) - 1, 1), 5);
}

export const INTERNAL_STATUSES = ['Open', 'In Progress', 'Awaiting Input', 'Pending Review', 'Closed', 'Reopened'];
export const COASTAL_STATUSES = ['Unacknowledged', 'Acknowledged', 'In Progress', 'Resolved', "Won't Fix"];
export const IMPACT_LABELS = { 1: 'High (1)', 2: 'Medium (2)', 3: 'Low (3)' };
export const URGENCY_LABELS = { 1: 'High (1)', 2: 'Medium (2)', 3: 'Low (3)' };

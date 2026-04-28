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

// Configurable date/time rendering. Branding stores `date_style`,
// `time_style`, and `timezone`; helpers below take an optional `locale`
// argument shaped like `{ date_style, time_style, timezone }`. Callers
// without a locale fall back to ISO/UTC, matching the seeded defaults.
const DEFAULT_LOCALE = { date_style: 'iso', time_style: 'iso', timezone: 'UTC' };

// Module-level active locale, updated by BrandingProvider once branding
// loads. Helpers fall back to ISO/UTC when branding isn't ready.
let _activeLocale = DEFAULT_LOCALE;
export function setActiveLocale(loc) {
  _activeLocale = {
    date_style: loc?.date_style || DEFAULT_LOCALE.date_style,
    time_style: loc?.time_style || DEFAULT_LOCALE.time_style,
    timezone: loc?.timezone || DEFAULT_LOCALE.timezone,
  };
}
export function getActiveLocale() { return _activeLocale; }

function ensureUtcDate(dt) {
  if (!dt) return null;
  return new Date(typeof dt === 'string' && !dt.endsWith('Z') ? dt + 'Z' : dt);
}

function buildOptions(locale, includeTime = true) {
  const tz = locale?.timezone || DEFAULT_LOCALE.timezone;
  const dateStyle = locale?.date_style || DEFAULT_LOCALE.date_style;
  const timeStyle = locale?.time_style || DEFAULT_LOCALE.time_style;
  // ISO style → render via raw ISO string formatting (handled in caller).
  if (dateStyle === 'iso') return { kind: 'iso', tz, includeTime, timeStyle };
  const localeTag = dateStyle === 'eu' ? 'en-GB' : 'en-US';
  const opts = {
    timeZone: tz,
    month: 'short', day: 'numeric', year: 'numeric',
  };
  if (includeTime) {
    if (timeStyle === '12h') {
      opts.hour = 'numeric'; opts.minute = '2-digit'; opts.hour12 = true;
    } else {
      opts.hour = '2-digit'; opts.minute = '2-digit'; opts.hour12 = false;
    }
  }
  return { kind: 'intl', localeTag, opts };
}

function isoStringInTz(date, tz, includeTime, timeStyle) {
  // Render ISO-style: YYYY-MM-DD or YYYY-MM-DD HH:MM (tz). Uses
  // Intl.DateTimeFormat in en-CA (which formats date as ISO) for tz
  // conversion, then reformats time per timeStyle.
  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (type) => dateParts.find(p => p.type === type)?.value;
  const datePart = `${get('year')}-${get('month')}-${get('day')}`;
  if (!includeTime) return datePart;
  const tParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit', minute: '2-digit', hour12: timeStyle === '12h',
  }).formatToParts(date);
  const tHour = tParts.find(p => p.type === 'hour')?.value || '00';
  const tMin = tParts.find(p => p.type === 'minute')?.value || '00';
  const dayPeriod = tParts.find(p => p.type === 'dayPeriod')?.value;
  const time = dayPeriod ? `${tHour}:${tMin} ${dayPeriod}` : `${tHour}:${tMin}`;
  return `${datePart} ${time}`;
}

export function formatAbsolute(dt, locale = _activeLocale) {
  const d = ensureUtcDate(dt);
  if (!d || isNaN(d.getTime())) return '—';
  const cfg = buildOptions(locale, true);
  if (cfg.kind === 'iso') return isoStringInTz(d, cfg.tz, cfg.includeTime, cfg.timeStyle);
  return d.toLocaleString(cfg.localeTag, cfg.opts);
}

export function formatAbsoluteDate(dt, locale = _activeLocale) {
  const d = ensureUtcDate(dt);
  if (!d || isNaN(d.getTime())) return '—';
  const cfg = buildOptions(locale, false);
  if (cfg.kind === 'iso') return isoStringInTz(d, cfg.tz, false, cfg.timeStyle);
  return d.toLocaleDateString(cfg.localeTag, cfg.opts);
}

// Hybrid: relative phrase if within ~7 days, absolute otherwise. Used in
// UI surfaces for scannability. Reports / exports must call formatAbsolute
// directly to avoid drift.
const HYBRID_CUTOFF_MS = 7 * 24 * 60 * 60 * 1000;
export function formatHybrid(dt, locale = _activeLocale) {
  const d = ensureUtcDate(dt);
  if (!d || isNaN(d.getTime())) return '—';
  const diff = Date.now() - d.getTime();
  if (diff < 0 || diff > HYBRID_CUTOFF_MS) return formatAbsolute(d, locale);
  if (diff < 60_000) return 'just now';
  if (diff < 60 * 60_000) {
    const m = Math.floor(diff / 60_000);
    return `${m} minute${m === 1 ? '' : 's'} ago`;
  }
  if (diff < 24 * 60 * 60_000) {
    const h = Math.floor(diff / (60 * 60_000));
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(diff / (24 * 60 * 60_000));
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// Backwards-compat shims. Existing callers pass dt only; they receive
// hybrid formatting against the default locale until updated to pass
// branding. Replace progressively where we have access to useBranding().
export function formatDateTime(dt, locale = _activeLocale) {
  return formatHybrid(dt, locale);
}

export function formatDate(dt, locale = _activeLocale) {
  return formatAbsoluteDate(dt, locale);
}

export function computePriority(impact, urgency) {
  return Math.min(Math.max(Number(impact) + Number(urgency) - 1, 1), 5);
}

export const INTERNAL_STATUSES = ['Open', 'In Progress', 'On Hold', 'Awaiting Input', 'Pending Review', 'Resolved', 'Closed', 'Reopened'];
export const EXTERNAL_STATUSES = ['Unacknowledged', 'Acknowledged', 'In Progress', 'Resolved', "Won't Fix"];
export const IMPACT_LABELS = { 1: 'High (1)', 2: 'Medium (2)', 3: 'Low (3)' };
export const URGENCY_LABELS = { 1: 'High (1)', 2: 'Medium (2)', 3: 'Low (3)' };

// External-ref formatting helpers. Alert-sourced tickets often land
// long URL payloads (Zabbix dashboards, PagerDuty incident links) in
// external_ref / external_ticket_ref. The raw value blows out table
// columns and the right-rail field on the ticket page, so we render a
// shortened form (`https://host.tld/segment...`) and keep the full
// value reachable via tooltip + clickable anchor on the detail view.

export function isUrlLike(value) {
  if (!value) return false;
  return /^https?:\/\//i.test(String(value).trim());
}

// Shorten a ref to roughly `max` visible chars. For URLs we keep the
// scheme + host + a leading slice of the path, then append "…" — the
// host stays readable so admins can tell at a glance which integration
// produced the ref. Non-URL refs (IDs like "ZBX-123") get a plain
// middle-truncation since they rarely exceed the budget.
export function truncateRef(value, max = 32) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (v.length <= max) return v;
  if (isUrlLike(v)) {
    try {
      const u = new URL(v);
      const host = u.host;
      const path = u.pathname && u.pathname !== '/' ? u.pathname : '';
      const head = `${u.protocol}//${host}${path}`;
      if (head.length <= max) return `${head}…`;
      return `${head.slice(0, Math.max(1, max - 1))}…`;
    } catch {
      // fall through to plain truncation
    }
  }
  return `${v.slice(0, Math.max(1, max - 1))}…`;
}

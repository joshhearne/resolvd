// Status page timelines: turn monitored-item state history
// (alert_item_state_changes) + maintenance windows into
//   - per-item state segments over a window,
//   - service segments rolled up from their components,
//   - fixed-size buckets ("pips") for an Uptime-Kuma-style bar,
//   - outage episodes (down / partial runs), including the ones that
//     never became an incident or ticket.
// Pure functions, no DB access, so they're unit-testable.

const { rollupServiceState } = require('./monitoredItems');

// Worst-first. A bucket shows the worst state it saw, like a monitor
// heartbeat bar: a short blip still marks the pip.
const SEVERITY = { down: 5, partial: 4, pending: 3, maintenance: 2, up: 1, unknown: 0 };
const worse = (a, b) => ((SEVERITY[a] ?? 0) >= (SEVERITY[b] ?? 0) ? a : b);

const t = (d) => (d instanceof Date ? d.getTime() : new Date(d).getTime());

// Merge adjacent segments with the same state.
function compact(segs) {
  const out = [];
  for (const s of segs) {
    if (s.end <= s.start) continue;
    const last = out[out.length - 1];
    if (last && last.state === s.state && last.end === s.start) last.end = s.end;
    else out.push({ ...s });
  }
  return out;
}

// Segments for one item between start and end (ms).
//   changes:   [{ from_state, to_state, changed_at }] inside the window, any order
//   priorState: to_state of the latest change before the window (or null)
//   currentState: the item's last_state (fallback when there's no history)
//   firstSeenAt: before this the item didn't exist → 'unknown'
//   maintenance: [{ starts_at, ends_at }] windows covering the item
function itemSegments({ changes = [], priorState = null, currentState = null, firstSeenAt = null,
  maintenance = [], start, end }) {
  const sorted = [...changes]
    .map((c) => ({ ...c, at: t(c.changed_at) }))
    .filter((c) => c.at >= start && c.at <= end)
    .sort((a, b) => a.at - b.at);
  let state = priorState || (sorted[0] ? sorted[0].from_state : null) || (sorted.length ? null : currentState) || 'unknown';
  const segs = [];
  let cursor = start;
  for (const c of sorted) {
    segs.push({ start: cursor, end: c.at, state });
    state = c.to_state || 'unknown';
    cursor = c.at;
  }
  segs.push({ start: cursor, end, state });

  let out = segs;
  const born = firstSeenAt ? t(firstSeenAt) : null;
  if (born && born > start) out = overlay(out, [{ start, end: Math.min(born, end) }], 'unknown');
  const mw = maintenance.map((w) => ({ start: t(w.starts_at), end: t(w.ends_at) }));
  if (mw.length) out = overlay(out, mw, 'maintenance');
  return compact(out);
}

// Paint `state` over the given ranges.
function overlay(segs, ranges, state) {
  let out = segs;
  for (const r of ranges) {
    const next = [];
    for (const s of out) {
      if (r.end <= s.start || r.start >= s.end) { next.push(s); continue; }
      if (s.start < r.start) next.push({ start: s.start, end: r.start, state: s.state });
      next.push({ start: Math.max(s.start, r.start), end: Math.min(s.end, r.end), state });
      if (s.end > r.end) next.push({ start: r.end, end: s.end, state: s.state });
    }
    out = next;
  }
  return compact(out);
}

const stateAt = (segs, at) => {
  for (const s of segs) if (at >= s.start && at < s.end) return s.state;
  return 'unknown';
};

// Service segments from components: [{ is_primary, segments }]. Uses
// the same rule as the live status (rollupServiceState).
function rollupSegments(components, start, end) {
  if (!components.length) return [{ start, end, state: 'unknown' }];
  const points = new Set([start, end]);
  for (const c of components) for (const s of c.segments) { points.add(s.start); points.add(s.end); }
  const sorted = [...points].filter((p) => p >= start && p <= end).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const state = rollupServiceState(
      components.map((c) => ({ state: stateAt(c.segments, a), is_primary: c.is_primary })),
      'unknown'
    );
    out.push({ start: a, end: b, state });
  }
  return compact(out);
}

// Fixed-size buckets ending at `end`. Each: { start, end, state (worst
// seen), down_s, partial_s, degraded_s, maint_s, known_s }.
function bucketize(segs, start, end, bucketMs) {
  const n = Math.max(1, Math.ceil((end - start) / bucketMs));
  const buckets = [];
  for (let i = 0; i < n; i += 1) {
    const bEnd = end - (n - 1 - i) * bucketMs;
    const bStart = Math.max(start, bEnd - bucketMs);
    buckets.push({ start: bStart, end: bEnd, state: 'unknown', down_s: 0, partial_s: 0, degraded_s: 0, maint_s: 0, known_s: 0 });
  }
  for (const s of segs) {
    for (const b of buckets) {
      const ov = Math.min(s.end, b.end) - Math.max(s.start, b.start);
      if (ov <= 0) continue;
      const sec = Math.round(ov / 1000);
      if (s.state !== 'unknown') b.known_s += sec;
      if (s.state === 'down') b.down_s += sec;
      else if (s.state === 'partial') b.partial_s += sec;
      else if (s.state === 'pending') b.degraded_s += sec;
      else if (s.state === 'maintenance') b.maint_s += sec;
      b.state = worse(s.state, b.state);
    }
  }
  return buckets;
}

// Availability over the window, excluding maintenance and no-data time.
// Partial outages count as half down (service limping, not dead).
function uptimeRatio(segs) {
  let counted = 0;
  let bad = 0;
  for (const s of segs) {
    const d = s.end - s.start;
    if (s.state === 'unknown' || s.state === 'maintenance') continue;
    counted += d;
    if (s.state === 'down') bad += d;
    else if (s.state === 'partial') bad += d / 2;
  }
  return counted ? 1 - bad / counted : null;
}

// Contiguous down/partial runs → [{ state (worst), start, end|null }].
// end is null when the episode is still ongoing at `windowEnd`.
function episodes(segs, windowEnd) {
  const out = [];
  let cur = null;
  for (const s of segs) {
    const bad = s.state === 'down' || s.state === 'partial';
    if (bad) {
      if (cur && cur.end === s.start) { cur.end = s.end; cur.state = worse(s.state, cur.state); }
      else { cur = { state: s.state, start: s.start, end: s.end }; out.push(cur); }
    } else {
      cur = null;
    }
  }
  return out.map((e) => ({ ...e, end: e.end >= windowEnd ? null : e.end }));
}

module.exports = {
  SEVERITY, itemSegments, overlay, rollupSegments, bucketize, uptimeRatio, episodes, stateAt,
};

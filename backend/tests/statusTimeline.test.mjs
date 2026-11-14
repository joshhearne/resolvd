// Status page timelines: segments from state history, maintenance
// overlay, service rollup from components, pip buckets, outage episodes
// and the notifier's per-batch summary.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const poolPath = require.resolve('../db/pool');
require.cache[poolPath] = {
  id: poolPath, filename: poolPath, loaded: true,
  exports: { pool: { query: async () => ({ rows: [] }) } },
};
const tl = require('../services/statusTimeline');
const { summarizeItem } = require('../services/statusPageNotifier');

const H = 3600000;
const T0 = Date.UTC(2026, 10, 1);
const at = (h) => new Date(T0 + h * H).toISOString();

describe('itemSegments', () => {
  it('builds segments from prior state + changes', () => {
    const segs = tl.itemSegments({
      priorState: 'up',
      changes: [
        { from_state: 'up', to_state: 'down', changed_at: at(2) },
        { from_state: 'down', to_state: 'up', changed_at: at(3) },
      ],
      start: T0, end: T0 + 10 * H,
    });
    expect(segs).toEqual([
      { start: T0, end: T0 + 2 * H, state: 'up' },
      { start: T0 + 2 * H, end: T0 + 3 * H, state: 'down' },
      { start: T0 + 3 * H, end: T0 + 10 * H, state: 'up' },
    ]);
  });
  it('falls back to first change from_state, then current state', () => {
    const a = tl.itemSegments({ changes: [{ from_state: 'down', to_state: 'up', changed_at: at(1) }], start: T0, end: T0 + 2 * H });
    expect(a[0].state).toBe('down');
    const b = tl.itemSegments({ currentState: 'up', start: T0, end: T0 + 2 * H });
    expect(b).toEqual([{ start: T0, end: T0 + 2 * H, state: 'up' }]);
  });
  it('paints maintenance and pre-existence', () => {
    const segs = tl.itemSegments({
      currentState: 'down', firstSeenAt: at(1),
      maintenance: [{ starts_at: at(4), ends_at: at(6) }],
      start: T0, end: T0 + 8 * H,
    });
    expect(segs.map((s) => s.state)).toEqual(['unknown', 'down', 'maintenance', 'down']);
  });
});

describe('rollupSegments', () => {
  it('primary down → service down, supporting down → partial', () => {
    const primary = { is_primary: true, segments: [
      { start: T0, end: T0 + 2 * H, state: 'up' },
      { start: T0 + 2 * H, end: T0 + 3 * H, state: 'down' },
      { start: T0 + 3 * H, end: T0 + 6 * H, state: 'up' },
    ] };
    const support = { is_primary: false, segments: [
      { start: T0, end: T0 + 4 * H, state: 'up' },
      { start: T0 + 4 * H, end: T0 + 5 * H, state: 'down' },
      { start: T0 + 5 * H, end: T0 + 6 * H, state: 'up' },
    ] };
    const segs = tl.rollupSegments([primary, support], T0, T0 + 6 * H);
    expect(segs.map((s) => [s.state, (s.end - s.start) / H])).toEqual([
      ['up', 2], ['down', 1], ['up', 1], ['partial', 1], ['up', 1],
    ]);
  });
});

describe('bucketize + episodes + uptime', () => {
  const segs = [
    { start: T0, end: T0 + 7 * H, state: 'up' },
    { start: T0 + 7 * H, end: T0 + 7 * H + 600000, state: 'down' }, // 10-minute blip
    { start: T0 + 7 * H + 600000, end: T0 + 12 * H, state: 'up' },
  ];
  it('marks the bucket that saw a blip as down with its downtime', () => {
    const b = tl.bucketize(segs, T0, T0 + 12 * H, 6 * H);
    expect(b.map((x) => x.state)).toEqual(['up', 'down']);
    expect(b[1].down_s).toBe(600);
  });
  it('finds the episode and computes uptime', () => {
    expect(tl.episodes(segs, T0 + 12 * H)).toEqual([{ state: 'down', start: T0 + 7 * H, end: T0 + 7 * H + 600000 }]);
    expect(tl.uptimeRatio(segs)).toBeCloseTo(1 - 600 / (12 * 3600), 6);
  });
  it('ongoing episode has end null; down+partial merge to the worst', () => {
    const e = tl.episodes([
      { start: T0, end: T0 + H, state: 'partial' },
      { start: T0 + H, end: T0 + 2 * H, state: 'down' },
    ], T0 + 2 * H);
    expect(e).toEqual([{ state: 'down', start: T0, end: null }]);
  });
});

describe('summarizeItem (notifier)', () => {
  it('down stays down', () => {
    expect(summarizeItem([{ from_state: 'up', to_state: 'down', changed_at: at(1) }])).toEqual({ kind: 'down', at: at(1) });
  });
  it('down then up in one batch = brief outage', () => {
    expect(summarizeItem([
      { from_state: 'up', to_state: 'down', changed_at: at(1) },
      { from_state: 'down', to_state: 'up', changed_at: at(2) },
    ])).toEqual({ kind: 'blip', at: at(1), until: at(2) });
  });
  it('recovery and non-down churn', () => {
    expect(summarizeItem([{ from_state: 'down', to_state: 'up', changed_at: at(1) }]).kind).toBe('up');
    expect(summarizeItem([{ from_state: 'up', to_state: 'pending', changed_at: at(1) }])).toBeNull();
  });
});

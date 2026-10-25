import { describe, it, expect } from 'vitest';
import rules from '../services/timeTrackingRules.js';

const { isEditLocked, overlapDecision, csvCell } = rules;

describe('edit lock', () => {
  const now = new Date('2026-10-25T12:00:00Z');
  const old = { ended_at: '2026-10-10T12:00:00Z' };
  const fresh = { ended_at: '2026-10-24T12:00:00Z' };
  it('locks old entries for techs only', () => {
    const s = { edit_lock_days: 7 };
    expect(isEditLocked({ entry: old, settings: s, role: 'Tech', now })).toBe(true);
    expect(isEditLocked({ entry: fresh, settings: s, role: 'Tech', now })).toBe(false);
    expect(isEditLocked({ entry: old, settings: s, role: 'Manager', now })).toBe(false);
    expect(isEditLocked({ entry: old, settings: s, role: 'Admin', now })).toBe(false);
  });
  it('never locks when set to 0', () => {
    expect(isEditLocked({ entry: old, settings: { edit_lock_days: 0 }, role: 'Tech', now })).toBe(false);
  });
});

describe('overlapDecision', () => {
  const overlaps = [{ id: 1 }];
  it('passes with no overlaps or when allowed', () => {
    expect(overlapDecision({ settings: { overlap_policy: 'block' }, overlaps: [], confirmed: false }).ok).toBe(true);
    expect(overlapDecision({ settings: { overlap_policy: 'allow' }, overlaps, confirmed: false }).ok).toBe(true);
  });
  it('warn asks for confirmation, then passes', () => {
    expect(overlapDecision({ settings: { overlap_policy: 'warn' }, overlaps, confirmed: false }).code).toBe('overlap_confirm');
    expect(overlapDecision({ settings: { overlap_policy: 'warn' }, overlaps, confirmed: true }).ok).toBe(true);
  });
  it('block refuses even when confirmed', () => {
    expect(overlapDecision({ settings: { overlap_policy: 'block' }, overlaps, confirmed: true }).code).toBe('overlap_blocked');
  });
});

describe('csvCell', () => {
  it('quotes, doubles quotes, and neutralises formulas', () => {
    expect(csvCell('plain')).toBe('"plain"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('@cmd')).toBe(`"'@cmd"`);
    expect(csvCell(null)).toBe('');
  });
});

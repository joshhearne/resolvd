import { describe, it, expect } from 'vitest';
import { addBusinessMinutes } from '../services/businessHours.js';

const BH_MF95_CT = {
  enabled: true,
  tz: 'America/Chicago',
  days: [1, 2, 3, 4, 5],
  start_time: '09:00',
  end_time: '17:00',
};

const BH_DISABLED = { ...BH_MF95_CT, enabled: false };

// All inputs use ISO strings interpreted as UTC. Outputs are Date objects.

describe('addBusinessMinutes', () => {
  it('returns wall-clock add when bh is null', () => {
    const start = new Date('2026-06-01T20:00:00Z'); // Monday 3pm CT (DST)
    const out = addBusinessMinutes(start, 60, null);
    expect(out.getTime()).toBe(start.getTime() + 60 * 60_000);
  });

  it('returns wall-clock add when bh is disabled', () => {
    const start = new Date('2026-06-01T20:00:00Z');
    const out = addBusinessMinutes(start, 60, BH_DISABLED);
    expect(out.getTime()).toBe(start.getTime() + 60 * 60_000);
  });

  it('counts time spent inside a business window', () => {
    // Monday 10am CT (UTC-5 in DST) → 15:00Z. Add 60 min business → 11am CT.
    const start = new Date('2026-06-01T15:00:00Z');
    const out = addBusinessMinutes(start, 60, BH_MF95_CT);
    expect(out.toISOString()).toBe('2026-06-01T16:00:00.000Z');
  });

  it('skips weekend — start Friday 4pm + 2h business = Monday 10am', () => {
    // Friday 2026-06-05 4pm CT = 21:00Z. Add 120 min business:
    //  60 min fills out to 5pm Fri (window end). Remaining 60 min picks
    //  up Monday 9am CT = 14:00Z. End at Mon 10am CT = 15:00Z.
    const start = new Date('2026-06-05T21:00:00Z');
    const out = addBusinessMinutes(start, 120, BH_MF95_CT);
    expect(out.toISOString()).toBe('2026-06-08T15:00:00.000Z');
  });

  it('starting outside business window jumps to next start', () => {
    // Saturday 9am CT (2026-06-06). 30 min business → Mon 9:30 CT.
    const start = new Date('2026-06-06T14:00:00Z');
    const out = addBusinessMinutes(start, 30, BH_MF95_CT);
    expect(out.toISOString()).toBe('2026-06-08T14:30:00.000Z');
  });

  it('zero minutes returns start unchanged', () => {
    const start = new Date('2026-06-01T15:00:00Z');
    const out = addBusinessMinutes(start, 0, BH_MF95_CT);
    expect(out.getTime()).toBe(start.getTime());
  });

  it('starting before business window jumps to that day start', () => {
    // Monday 7am CT = 12:00Z. Add 30 → start at 9am CT (14:00Z) + 30 = 9:30.
    const start = new Date('2026-06-01T12:00:00Z');
    const out = addBusinessMinutes(start, 30, BH_MF95_CT);
    expect(out.toISOString()).toBe('2026-06-01T14:30:00.000Z');
  });

  it('large minute span chains across multiple business days', () => {
    // 8 hr/day window. 24 hr business = 3 full business days from start.
    // Start Mon 9am CT = 14:00Z. After 480 min = Mon 5pm CT = 22:00Z (window end).
    // After 480 more = Tue 5pm. After 480 more = Wed 5pm CT = 22:00Z.
    const start = new Date('2026-06-01T14:00:00Z');
    const out = addBusinessMinutes(start, 480 * 3, BH_MF95_CT);
    expect(out.toISOString()).toBe('2026-06-03T22:00:00.000Z');
  });
});

describe('addBusinessMinutes — holidays', () => {
  it('skips a fixed-date holiday like a weekend', () => {
    // Fri 2026-06-05 4pm CT + 2h: Mon 06-08 is a holiday, so the
    // remaining hour lands Tue 10am CT (15:00Z).
    const bh = { ...BH_MF95_CT, holidays: [{ date: '2026-06-08', recurring: false }] };
    const out = addBusinessMinutes(new Date('2026-06-05T21:00:00Z'), 120, bh);
    expect(out.toISOString()).toBe('2026-06-09T15:00:00.000Z');
  });

  it('matches recurring holidays in any year', () => {
    // Christmas Fri 2026-12-25 is closed every year. Thu 12-24 4pm CST
    // (22:00Z) + 2h → Mon 12-28 10am CST (16:00Z).
    const bh = { ...BH_MF95_CT, holidays: [{ date: '2001-12-25', recurring: true }] };
    const out = addBusinessMinutes(new Date('2026-12-24T22:00:00Z'), 120, bh);
    expect(out.toISOString()).toBe('2026-12-28T16:00:00.000Z');
  });

  it('judges the holiday by local date in the policy tz', () => {
    // 2026-06-08 01:00Z is still Sunday 06-07 in Chicago; the Monday
    // holiday must not swallow Sunday — it swallows Monday 06-08 local.
    const bh = { ...BH_MF95_CT, holidays: [{ date: '2026-06-08' }] };
    const out = addBusinessMinutes(new Date('2026-06-08T01:00:00Z'), 60, bh);
    expect(out.toISOString()).toBe('2026-06-09T15:00:00.000Z');
  });

  it('ignores holidays outside the window and malformed entries', () => {
    const bh = { ...BH_MF95_CT, holidays: [{ date: '2026-06-06' }, { date: 'nope' }, null] };
    const out = addBusinessMinutes(new Date('2026-06-05T21:00:00Z'), 120, bh);
    expect(out.toISOString()).toBe('2026-06-08T15:00:00.000Z');
  });
});

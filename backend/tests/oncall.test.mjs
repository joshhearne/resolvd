// Pure-function tests for on-call rotation math.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { onCallAt, upcomingShifts } = require('../services/oncall');

// Weekly rotation, handoff Mon 2026-10-05 14:00Z, members 11 → 12 → 13.
const rot = { enabled: true, member_ids: [11, 12, 13], shift_hours: 168, handoff_at: '2026-10-05T14:00:00Z' };

describe('onCallAt', () => {
  it('walks members one shift each from the handoff', () => {
    expect(onCallAt(rot, [], '2026-10-05T14:00:00Z').user_id).toBe(11);
    expect(onCallAt(rot, [], '2026-10-12T13:59:59Z').user_id).toBe(11);
    expect(onCallAt(rot, [], '2026-10-12T14:00:00Z').user_id).toBe(12);
    expect(onCallAt(rot, [], '2026-10-19T14:00:00Z').user_id).toBe(13);
    expect(onCallAt(rot, [], '2026-10-26T14:00:00Z').user_id).toBe(11);
  });

  it('extends backwards before the handoff', () => {
    expect(onCallAt(rot, [], '2026-10-05T13:59:00Z').user_id).toBe(13);
    expect(onCallAt(rot, [], '2026-09-28T14:00:00Z').user_id).toBe(13);
    expect(onCallAt(rot, [], '2026-09-21T14:00:00Z').user_id).toBe(12);
  });

  it('reports when the shift ends', () => {
    expect(onCallAt(rot, [], '2026-10-13T00:00:00Z')).toEqual({
      user_id: 12, source: 'rotation', until: new Date('2026-10-19T14:00:00Z'),
    });
  });

  it('lets an override win inside its window, newest first on overlap', () => {
    const overrides = [
      { user_id: 99, starts_at: '2026-10-13T00:00:00Z', ends_at: '2026-10-14T00:00:00Z', created_at: '2026-10-01T00:00:00Z' },
      { user_id: 77, starts_at: '2026-10-13T06:00:00Z', ends_at: '2026-10-13T12:00:00Z', created_at: '2026-10-02T00:00:00Z' },
    ];
    expect(onCallAt(rot, overrides, '2026-10-13T03:00:00Z')).toMatchObject({ user_id: 99, source: 'override' });
    expect(onCallAt(rot, overrides, '2026-10-13T08:00:00Z')).toMatchObject({ user_id: 77, source: 'override' });
    expect(onCallAt(rot, overrides, '2026-10-14T00:00:00Z')).toMatchObject({ user_id: 12, source: 'rotation' });
  });

  it('returns null when disabled, empty or misconfigured', () => {
    expect(onCallAt({ ...rot, enabled: false }, [], '2026-10-13T00:00:00Z')).toBeNull();
    expect(onCallAt({ ...rot, member_ids: [] }, [], '2026-10-13T00:00:00Z')).toBeNull();
    expect(onCallAt({ ...rot, shift_hours: 0 }, [], '2026-10-13T00:00:00Z')).toBeNull();
  });

  it('still honours an override on a rotation with no members', () => {
    const o = [{ user_id: 5, starts_at: '2026-10-13T00:00:00Z', ends_at: '2026-10-14T00:00:00Z' }];
    expect(onCallAt({ ...rot, member_ids: [] }, o, '2026-10-13T01:00:00Z').user_id).toBe(5);
  });
});

describe('upcomingShifts', () => {
  it('lists the current shift first, then the next ones', () => {
    const list = upcomingShifts(rot, '2026-10-13T00:00:00Z', 3);
    expect(list.map((s) => [s.user_id, s.starts_at.toISOString()])).toEqual([
      [12, '2026-10-12T14:00:00.000Z'],
      [13, '2026-10-19T14:00:00.000Z'],
      [11, '2026-10-26T14:00:00.000Z'],
    ]);
  });
});

// Pure-function tests for the external-ref auto-advance planner.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planExternalRefAdvance } = require('../services/externalEscalation');

const statuses = [
  { id: 1, kind: 'internal', name: 'Open', sort_order: 10, is_initial: true, is_terminal: false },
  { id: 2, kind: 'internal', name: 'In Progress', sort_order: 20, is_initial: false, is_terminal: false },
  { id: 3, kind: 'internal', name: 'External Escalation', sort_order: 30, is_initial: false, is_terminal: false },
  { id: 4, kind: 'internal', name: 'Closed', sort_order: 50, is_initial: false, is_terminal: true },
  { id: 10, kind: 'external', name: 'Unacknowledged', sort_order: 10, is_initial: true, is_terminal: false },
  { id: 11, kind: 'external', name: 'Acknowledged', sort_order: 20, is_initial: false, is_terminal: false },
  { id: 12, kind: 'external', name: 'In Progress', sort_order: 30, is_initial: false, is_terminal: false },
  { id: 13, kind: 'external', name: 'Rejected', sort_order: 50, is_initial: false, is_terminal: true },
];

const ticket = { external_status: 'Unacknowledged', internal_status: 'Open', followup_at: null };

function plan(overrides = {}) {
  return planExternalRefAdvance({
    oldRef: null,
    newRef: 'VEND-123',
    ticket,
    statuses,
    transitions: [],
    mappings: [],
    ...overrides,
  });
}

describe('planExternalRefAdvance — external side', () => {
  it('falls back to Acknowledged when no transitions are drawn', () => {
    expect(plan()).toEqual({
      fromExternalStatus: 'Unacknowledged', externalStatus: 'Acknowledged', internalStatus: null,
    });
  });

  it('prefers the configured next transition (lowest sort order, non-terminal)', () => {
    const transitions = [
      { from_status_id: 10, to_status_id: 13 },
      { from_status_id: 10, to_status_id: 12 },
    ];
    expect(plan({ transitions }).externalStatus).toBe('In Progress');
  });

  it('only fires on the first write of a ref', () => {
    expect(plan({ oldRef: 'VEND-1' })).toBeNull();
    expect(plan({ oldRef: '   ', newRef: 'VEND-2' })).not.toBeNull();
  });

  it('ignores clearing or blank refs', () => {
    expect(plan({ newRef: '' })).toBeNull();
    expect(plan({ newRef: '  ' })).toBeNull();
    expect(plan({ newRef: null })).toBeNull();
  });

  it('defers to an explicit external status in the same save', () => {
    expect(plan({ explicitExternalStatus: 'Rejected' })).toBeNull();
  });

  it('does nothing once the ticket is past the initial external status', () => {
    expect(plan({ ticket: { ...ticket, external_status: 'In Progress' } })).toBeNull();
  });

  it('does nothing when disabled', () => {
    expect(plan({ enabled: false })).toBeNull();
  });

  it('does nothing when there is no reachable target', () => {
    const noAck = statuses.filter((s) => s.name !== 'Acknowledged');
    expect(plan({ statuses: noAck })).toBeNull();
  });
});

describe('planExternalRefAdvance — internal mirror', () => {
  const mappings = [{ internal_status_id: 3, external_status_id: 11, kind: 'mirror' }];

  it('follows a mirror mapping on the external target', () => {
    expect(plan({ mappings }).internalStatus).toBe('External Escalation');
  });

  it('ignores suggest mappings', () => {
    expect(plan({ mappings: [{ ...mappings[0], kind: 'suggest' }] }).internalStatus).toBeNull();
  });

  it('respects drawn internal transitions', () => {
    const blocked = [{ from_status_id: 1, to_status_id: 2 }];
    expect(plan({ mappings, transitions: blocked }).internalStatus).toBeNull();
    const allowed = [{ from_status_id: 1, to_status_id: 3 }];
    expect(plan({ mappings, transitions: allowed }).internalStatus).toBe('External Escalation');
  });

  it('never moves a terminal ticket, or one with a pending follow-up', () => {
    expect(plan({ mappings, ticket: { ...ticket, internal_status: 'Closed' } }).internalStatus).toBeNull();
    expect(plan({ mappings, ticket: { ...ticket, followup_at: new Date() } }).internalStatus).toBeNull();
  });

  it('defers to an explicit internal status but still advances external', () => {
    const p = plan({ mappings, explicitInternalStatus: 'In Progress' });
    expect(p.externalStatus).toBe('Acknowledged');
    expect(p.internalStatus).toBeNull();
  });

  it('skips a mirror target equal to the current status', () => {
    const t = { ...ticket, internal_status: 'External Escalation' };
    expect(plan({ mappings, ticket: t }).internalStatus).toBeNull();
  });
});

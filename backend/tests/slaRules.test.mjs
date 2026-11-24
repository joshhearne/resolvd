// Org SLA rules (services/sla.js slaDrops): drop the resolve SLA when a
// ticket has a due date; drop the response SLA when an agent creates a
// ticket assigned to themselves (optionally limited to some sources).

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { slaDrops } = require('../services/sla');

const on = { drop_resolve_when_due_date: true, drop_response_self_assigned: true, self_assigned_sources: [] };
const selfAssigned = { created_by: 7, assigned_to: 7, source: 'phone', due_at: null };

describe('slaDrops', () => {
  it('does nothing with the rules off', () => {
    expect(slaDrops({}, { ...selfAssigned, due_at: '2026-12-01' }, 'Tech')).toEqual({ dropResponse: false, dropResolve: false });
  });

  it('drops resolve only when a due date is set', () => {
    expect(slaDrops(on, { ...selfAssigned, created_by: null, due_at: '2026-12-01T17:00:00Z' }, null).dropResolve).toBe(true);
    expect(slaDrops(on, { ...selfAssigned, due_at: null }, 'Tech').dropResolve).toBe(false);
  });

  it('drops response for an agent who assigned the ticket to themselves', () => {
    for (const role of ['Admin', 'Manager', 'Tech']) {
      expect(slaDrops(on, selfAssigned, role).dropResponse).toBe(true);
    }
  });

  it('keeps response for submitters, other assignees, unassigned and system tickets', () => {
    expect(slaDrops(on, selfAssigned, 'Submitter').dropResponse).toBe(false);
    expect(slaDrops(on, { ...selfAssigned, assigned_to: 8 }, 'Tech').dropResponse).toBe(false);
    expect(slaDrops(on, { ...selfAssigned, assigned_to: null }, 'Tech').dropResponse).toBe(false);
    expect(slaDrops(on, { ...selfAssigned, created_by: null }, null).dropResponse).toBe(false);
  });

  it('honours the source list when one is set', () => {
    const phoneOnly = { ...on, self_assigned_sources: ['phone', 'teams'] };
    expect(slaDrops(phoneOnly, selfAssigned, 'Tech').dropResponse).toBe(true);
    expect(slaDrops(phoneOnly, { ...selfAssigned, source: 'web' }, 'Tech').dropResponse).toBe(false);
  });
});

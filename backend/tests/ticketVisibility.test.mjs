// Ticket visibility scope (#101 / #102): Submitters see only their own
// submissions + followed tickets; project elevation (role_override /
// is_agent) grants full-board visibility on that project only. The
// database is a stub keyed off the SQL text.

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let state;
async function handle(sql, params = []) {
  if (/FROM project_members WHERE user_id/.test(sql)) {
    return { rows: state.memberships[params[0]] || [] };
  }
  if (/FROM tickets WHERE id/.test(sql)) {
    const t = state.tickets.find((x) => x.id === params[0]);
    return { rows: t ? [t] : [] };
  }
  if (/FROM ticket_followers WHERE ticket_id/.test(sql)) {
    const hit = state.followers.some(([tid, uid]) => tid === params[0] && uid === params[1]);
    return { rows: hit ? [{ '?column?': 1 }] : [] };
  }
  return { rows: [] };
}
const poolPath = require.resolve('../db/pool');
require.cache[poolPath] = {
  id: poolPath, filename: poolPath, loaded: true,
  exports: { pool: { query: handle } },
};

const vis = require('../services/ticketVisibility');

beforeEach(() => {
  state = {
    memberships: {
      // Submitter, plain member of project 1, elevated to Tech on project 2.
      10: [
        { project_id: 1, role_override: null, is_agent: false },
        { project_id: 2, role_override: 'Tech', is_agent: false },
      ],
      // Tech downgraded to Submitter on project 3, full on project 4.
      20: [
        { project_id: 3, role_override: 'Submitter', is_agent: false },
        { project_id: 4, role_override: null, is_agent: false },
      ],
      // Submitter flagged as agent on project 5.
      30: [{ project_id: 5, role_override: null, is_agent: true }],
    },
    tickets: [
      { id: 100, project_id: 1, submitted_by: 99 }, // someone else, project 1
      { id: 101, project_id: 1, submitted_by: 10 }, // own
      { id: 102, project_id: 1, submitted_by: 99 }, // followed by 10
      { id: 103, project_id: 2, submitted_by: 99 }, // elevated project
      { id: 104, project_id: 9, submitted_by: 99 }, // unrelated project, followed
    ],
    followers: [[102, 10], [104, 10]],
  };
});

describe('fullProjectIdsFromMemberships', () => {
  it('excludes projects where the effective role is Submitter', () => {
    expect(vis.fullProjectIdsFromMemberships('Submitter', state.memberships[10])).toEqual([2]);
    expect(vis.fullProjectIdsFromMemberships('Tech', state.memberships[20])).toEqual([4]);
  });
  it('is_agent grants full visibility regardless of role', () => {
    expect(vis.fullProjectIdsFromMemberships('Submitter', state.memberships[30])).toEqual([5]);
  });
});

describe('getTicketScope', () => {
  it('Admin and Manager are unrestricted', async () => {
    expect(await vis.getTicketScope({ id: 1, role: 'Admin' })).toEqual({ unrestricted: true });
    expect(await vis.getTicketScope({ id: 1, role: 'Manager' })).toEqual({ unrestricted: true });
  });
  it('Submitter only gets elevated projects as full', async () => {
    const s = await vis.getTicketScope({ id: 10, role: 'Submitter' });
    expect(s).toEqual({ unrestricted: false, userId: 10, fullProjectIds: [2] });
  });
});

describe('scopeClause', () => {
  it('is TRUE for unrestricted scopes', () => {
    expect(vis.scopeClause({ unrestricted: true }, 't', 3)).toEqual({ sql: 'TRUE', params: [] });
  });
  it('numbers placeholders from startIndex and covers own + followed', () => {
    const c = vis.scopeClause({ unrestricted: false, userId: 10, fullProjectIds: [2] }, 't', 3);
    expect(c.params).toEqual([[2], 10]);
    expect(c.sql).toContain('t.project_id = ANY($3::int[])');
    expect(c.sql).toContain('t.submitted_by = $4');
    expect(c.sql).toContain('ticket_followers');
  });
});

describe('canViewTicket', () => {
  const sub = { id: 10, role: 'Submitter' };
  it('hides other people\'s tickets in a project the Submitter is a member of', async () => {
    expect(await vis.canViewTicket(sub, 100)).toBe(false);
  });
  it('shows own, followed and elevated-project tickets', async () => {
    expect(await vis.canViewTicket(sub, 101)).toBe(true);
    expect(await vis.canViewTicket(sub, 102)).toBe(true);
    expect(await vis.canViewTicket(sub, 103)).toBe(true);
    expect(await vis.canViewTicket(sub, 104)).toBe(true);
  });
  it('returns false for missing tickets and true for Admin', async () => {
    expect(await vis.canViewTicket(sub, 999)).toBe(false);
    expect(await vis.canViewTicket({ id: 1, role: 'Admin' }, 100)).toBe(true);
  });
});

describe('requireTicketVisible middleware', () => {
  function run(user, id) {
    return new Promise((resolve) => {
      const req = { session: { user }, params: { ticketId: id } };
      const res = {
        status(code) { this.code = code; return this; },
        json(body) { resolve({ code: this.code, body }); },
      };
      vis.requireTicketVisible('ticketId')(req, res, () => resolve({ next: true }));
    });
  }
  it('404s hidden tickets, passes visible + non-numeric + anonymous', async () => {
    const sub = { id: 10, role: 'Submitter' };
    expect(await run(sub, '100')).toEqual({ code: 404, body: { error: 'Ticket not found' } });
    expect(await run(sub, '101')).toEqual({ next: true });
    expect(await run(sub, 'counts')).toEqual({ next: true });
    expect(await run(undefined, '100')).toEqual({ next: true });
  });
});

// Status page visibility: staff-only flag + optional project restriction.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const poolPath = require.resolve('../db/pool');
require.cache[poolPath] = {
  id: poolPath, filename: poolPath, loaded: true,
  exports: { pool: { query: async () => ({ rows: [] }) } },
};
const { canViewPage } = require('../services/statusPageAccess');

const MKT = 7;
const OPS = 8;
const v = (role, memberProjectIds = []) => ({ role, memberProjectIds });

describe('canViewPage', () => {
  it('public, unrestricted: everyone', () => {
    const page = { is_public: true, project_ids: [] };
    for (const r of ['Admin', 'Manager', 'Tech', 'Submitter', 'Viewer']) expect(canViewPage(v(r), page)).toBe(true);
  });
  it('staff-only: Admin / Manager / Tech', () => {
    const page = { is_public: false, project_ids: [] };
    expect(canViewPage(v('Tech'), page)).toBe(true);
    expect(canViewPage(v('Submitter'), page)).toBe(false);
    expect(canViewPage(v('Viewer'), page)).toBe(false);
  });
  it('public + project limit: members only (any role), Admin/Manager always', () => {
    const page = { is_public: true, project_ids: [MKT] };
    expect(canViewPage(v('Submitter', [MKT]), page)).toBe(true);
    expect(canViewPage(v('Submitter', [OPS]), page)).toBe(false);
    expect(canViewPage(v('Tech', []), page)).toBe(false);
    expect(canViewPage(v('Admin'), page)).toBe(true);
    expect(canViewPage(v('Manager'), page)).toBe(true);
  });
  it('any one of several projects is enough', () => {
    expect(canViewPage(v('Viewer', [OPS]), { is_public: true, project_ids: [MKT, OPS] })).toBe(true);
  });
  it('staff-only + project limit: staff who are members', () => {
    const page = { is_public: false, project_ids: [MKT] };
    expect(canViewPage(v('Tech', [MKT]), page)).toBe(true);
    expect(canViewPage(v('Tech', [OPS]), page)).toBe(false);
    expect(canViewPage(v('Submitter', [MKT]), page)).toBe(false);
  });
  it('no viewer → no access', () => {
    expect(canViewPage(null, { is_public: true, project_ids: [] })).toBe(false);
  });
});

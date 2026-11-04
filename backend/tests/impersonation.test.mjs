// Admin masquerade guard: account-sensitive writes are refused while an
// Admin is viewing as another user; reads and normal work pass through.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const poolPath = require.resolve('../db/pool');
require.cache[poolPath] = {
  id: poolPath, filename: poolPath, loaded: true,
  exports: { pool: { query: async () => ({ rows: [] }) } },
};
const { blockWhileImpersonating } = require('../routes/impersonation');

function run({ impersonating, method, url }) {
  const req = { method, originalUrl: url, session: impersonating ? { impersonator: { id: 1 } } : {} };
  let status = null;
  const res = { status(c) { status = c; return this; }, json() { return this; } };
  let passed = false;
  blockWhileImpersonating(req, res, () => { passed = true; });
  return passed ? 'next' : status;
}

describe('blockWhileImpersonating', () => {
  it('blocks account-sensitive writes while masquerading', () => {
    for (const url of ['/auth/mfa/disable', '/auth/password/change', '/api/users/me/prefs',
      '/api/users/me/profile', '/api/users/me/avatar', '/api/push/subscribe', '/api/calendar/me/token']) {
      expect(run({ impersonating: true, method: 'POST', url })).toBe(403);
    }
  });
  it('lets reads and ordinary work through', () => {
    expect(run({ impersonating: true, method: 'GET', url: '/api/users/me/prefs' })).toBe('next');
    expect(run({ impersonating: true, method: 'PATCH', url: '/api/tickets/5' })).toBe('next');
    expect(run({ impersonating: true, method: 'POST', url: '/api/impersonate/release' })).toBe('next');
  });
  it('is a no-op when not masquerading', () => {
    expect(run({ impersonating: false, method: 'POST', url: '/auth/password/change' })).toBe('next');
  });
});

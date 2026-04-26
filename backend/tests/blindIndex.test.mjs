// Blind index helpers. The HMAC key is derived from RESOLVD_MASTER_KEY
// via HKDF-SHA256, so determinism across runs depends on the key staying
// stable inside the test (set in beforeAll to a deterministic value).

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const FIXED_KEY = 'wbBjmsfGT0FzAWOcRhoUu+Hxsy3HQM27SAUS5wcqMnY=';

beforeAll(() => {
  process.env.RESOLVD_MASTER_KEY = FIXED_KEY;
  // Force re-import so the cached HKDF key clears.
  const path = require.resolve('../services/blindIndex');
  delete require.cache[path];
});

describe('services/blindIndex', () => {
  it('tokenises lowercased word boundaries and drops short tokens', () => {
    const { tokenize } = require('../services/blindIndex');
    expect(tokenize('Login bug Fix v2')).toEqual(['login', 'bug', 'fix']);
    expect(tokenize('  Hello,  World!!  ')).toEqual(['hello', 'world']);
  });

  it('hashWhole returns deterministic 24-char hex', () => {
    const { hashWhole } = require('../services/blindIndex');
    const a = hashWhole('Jane.Doe@Vendor.com');
    const b = hashWhole('jane.doe@vendor.com');
    expect(a).toEqual(b);
    expect(a).toMatch(/^[0-9a-f]{24}$/);
    expect(hashWhole('jane.doe@vendor.com')).not.toEqual(hashWhole('other@vendor.com'));
  });

  it('returns null when master key is absent', () => {
    delete process.env.RESOLVD_MASTER_KEY;
    delete require.cache[require.resolve('../services/blindIndex')];
    const { hashWhole, buildIndex } = require('../services/blindIndex');
    expect(hashWhole('jane@example.com')).toBeNull();
    expect(buildIndex('any title here')).toEqual([]);
    process.env.RESOLVD_MASTER_KEY = FIXED_KEY;
    delete require.cache[require.resolve('../services/blindIndex')];
  });

  it('buildIndex de-duplicates repeated tokens', () => {
    const { buildIndex } = require('../services/blindIndex');
    const idx = buildIndex('Login Login bug Bug login crash');
    // Three unique meaningful words: login, bug, crash → three hashes.
    expect(idx).toHaveLength(3);
    const set = new Set(idx);
    expect(set.size).toBe(3);
  });

  it('hashQuery matches buildIndex on shared tokens', () => {
    const { buildIndex, hashQuery } = require('../services/blindIndex');
    const idx = new Set(buildIndex('login crash on submit page'));
    const q = hashQuery('login crash');
    for (const h of q) expect(idx.has(h)).toBe(true);
    const miss = hashQuery('completely unrelated banana xyz');
    for (const h of miss) expect(idx.has(h)).toBe(false);
  });
});

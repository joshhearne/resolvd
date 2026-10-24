// Tests for the pieces that let the backend run on Cloudflare Workers as
// well as Node: blob storage backends, the cron dispatcher, the argon2
// shim, the numeric-id route guard, and the static integration list.
// None of these need a database or the Workers runtime.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

describe('services/storage — disk backend', () => {
  let dir;
  let storage;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolvd-storage-'));
    process.env.UPLOADS_DIR = dir;
    delete require.cache[require.resolve('../services/storage')];
    storage = require('../services/storage');
    storage.useR2(null);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('round-trips bytes, including nested keys, at the same paths as before', async () => {
    await storage.put('avatars/a.png', Buffer.from([1, 2, 3]));
    expect(fs.existsSync(path.join(dir, 'avatars', 'a.png'))).toBe(true);
    expect([...(await storage.get('avatars/a.png'))]).toEqual([1, 2, 3]);
    expect(await storage.exists('avatars/a.png')).toBe(true);
  });

  it('returns null / false for missing objects and removes quietly', async () => {
    expect(await storage.get('nope.bin')).toBeNull();
    expect(await storage.exists('nope.bin')).toBe(false);
    await storage.remove('nope.bin');
    await storage.put('x.bin', Buffer.from('x'));
    await storage.remove('x.bin');
    expect(await storage.exists('x.bin')).toBe(false);
  });

  it('refuses keys that escape the uploads root', async () => {
    await expect(storage.put('../escape.txt', Buffer.from('x'))).rejects.toThrow(/invalid storage key/);
  });
});

describe('services/storage — R2 backend', () => {
  const storage = require('../services/storage');
  const objects = new Map();
  const bucket = {
    put: async (k, v, o) => { objects.set(k, { bytes: Buffer.from(v), httpMetadata: o?.httpMetadata }); },
    get: async (k) => {
      const o = objects.get(k);
      return o ? { size: o.bytes.length, httpMetadata: o.httpMetadata, arrayBuffer: async () => o.bytes } : null;
    },
    head: async (k) => (objects.has(k) ? {} : null),
    delete: async (k) => { objects.delete(k); },
  };
  beforeAll(() => storage.useR2(bucket));
  afterAll(() => storage.useR2(null));

  it('stores under the same keys and keeps the content type', async () => {
    expect(storage.backend()).toBe('r2');
    await storage.put('avatars/b.png', Buffer.from([9]), { contentType: 'image/png' });
    expect(objects.get('avatars/b.png').httpMetadata).toEqual({ contentType: 'image/png' });
    expect([...(await storage.get('avatars/b.png'))]).toEqual([9]);
    expect(await storage.get('missing')).toBeNull();
  });

  it('send() writes the body with content type and length, or reports missing', async () => {
    const headers = {};
    let body = null;
    const res = {
      get: (h) => headers[h.toLowerCase()],
      set: (h, v) => { headers[h.toLowerCase()] = v; },
      type: (t) => { headers['content-type'] = t; },
      end: (b) => { body = b; },
    };
    expect(await storage.send(res, 'avatars/b.png')).toBe(true);
    expect(headers['content-type']).toBe('image/png');
    expect(headers['content-length']).toBe('1');
    expect([...body]).toEqual([9]);
    expect(await storage.send(res, 'missing')).toBe(false);
  });
});

describe('services/schedulers — Workers cron dispatch', () => {
  const { isDue, runCron, JOBS } = require('../services/schedulers');
  const at = (iso) => new Date(iso);
  const dueAt = (iso) => JOBS.filter((j) => isDue(j.every, at(iso))).map((j) => j.name);

  it('runs per-minute jobs every minute and nothing else off the 5-minute mark', () => {
    expect(dueAt('2026-01-01T10:07:00Z')).toEqual(['alertSourcePoll', 'ticketSchedules']);
  });

  it('adds 5-minute, hourly and daily tiers at their marks', () => {
    expect(dueAt('2026-01-01T10:05:00Z')).toEqual(expect.arrayContaining(['mutedDigest', 'notificationOutbox', 'sla']));
    expect(dueAt('2026-01-01T10:05:00Z')).not.toContain('autoClose');
    expect(dueAt('2026-01-01T10:00:00Z')).toEqual(expect.arrayContaining(['inboxMonitor', 'autoClose', 'sessionPrune']));
    expect(dueAt('2026-01-01T10:00:00Z')).not.toContain('troveKbSnapshots');
    expect(dueAt('2026-01-01T03:00:00Z')).toContain('troveKbSnapshots');
  });

  it('keeps running the rest when one job fails', async () => {
    const saved = JOBS.splice(0, JOBS.length,
      { name: 'boom', every: 'minute', run: async () => { throw new Error('x'); } },
      { name: 'fine', every: 'minute', run: async () => {} });
    const errors = console.error;
    console.error = () => {};
    try {
      expect(await runCron(at('2026-01-01T10:07:00Z'))).toEqual([
        { job: 'boom', ok: false },
        { job: 'fine', ok: true },
      ]);
    } finally {
      console.error = errors;
      JOBS.splice(0, JOBS.length, ...saved);
    }
  });
});

describe('worker/shims/argon2 — pure-JS argon2 for Workers', async () => {
  const shim = await import('../worker/shims/argon2.js');
  const native = require('argon2');

  it('verifies hashes written by native argon2 (m,p,t param order)', async () => {
    const h = await native.hash('correct horse', { type: native.argon2id, memoryCost: 4096, timeCost: 2, parallelism: 2 });
    expect(await shim.verify(h, 'correct horse')).toBe(true);
    expect(await shim.verify(h, 'wrong')).toBe(false);
  });

  it('writes hashes native argon2 verifies', async () => {
    const h = await shim.hash('correct horse', { type: shim.argon2id, memoryCost: 4096 });
    expect(h).toMatch(/^\$argon2id\$v=19\$m=4096,t=2,p=1\$/);
    expect(await native.verify(h, 'correct horse')).toBe(true);
    expect(await native.verify(h, 'nope')).toBe(false);
  });

  it('throws on malformed hashes like native does', async () => {
    await expect(shim.verify('not-a-hash', 'x')).rejects.toThrow(TypeError);
  });

  it('flags hashes with other params for rehash', async () => {
    const nativeHash = await native.hash('x', { type: native.argon2id, memoryCost: 4096 });
    expect(shim.needsRehash(nativeHash)).toBe(true);
    expect(shim.needsRehash(await shim.hash('x'))).toBe(false);
  });
});

describe('middleware/params — numericId', () => {
  const { numericId } = require('../middleware/params');
  const run = (id) => { let arg = 'unset'; numericId({ params: { id } }, {}, (a) => { arg = a; }); return arg; };

  it('passes numeric ids and skips the route otherwise', () => {
    expect(run('42')).toBeUndefined();
    expect(run('export.csv')).toBe('route');
    expect(run('12abc')).toBe('route');
    expect(run('')).toBe('route');
  });
});

describe('services/integrations/registry', () => {
  it('requires every adapter file in its directory (the list is static for bundling)', () => {
    require('../services/integrations/registry');
    const dir = path.join(here, '../services/integrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'registry.js');
    for (const f of files) {
      expect(require.cache[require.resolve(path.join(dir, f))], `${f} is not required by registry.js`).toBeDefined();
    }
  });
});

describe('db/pool — Workers request scope', () => {
  const { withScopedPool, trackPending } = require('../db/pool');

  it('holds `settled` open until tracked background work finishes', async () => {
    let backgroundDone = false;
    const start = Date.now();
    const { result, settled } = await withScopedPool('postgres://unused', async () => {
      // Fire-and-forget, like a notification send after res.json().
      trackPending(new Promise((r) => setTimeout(r, 300))).then(() => { backgroundDone = true; });
      return 'response';
    });
    expect(result).toBe('response');
    expect(backgroundDone).toBe(false);
    await settled;
    expect(backgroundDone).toBe(true);
    expect(Date.now() - start).toBeGreaterThanOrEqual(300);
  });

  it('passes promises through untouched outside a scope', async () => {
    const p = Promise.resolve(7);
    expect(trackPending(p)).toBe(p);
  });
});

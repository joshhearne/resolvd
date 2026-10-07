// Trove KB REST client against a mocked fetch. No database: the settings
// loader is fed through a patched pool.query, and the master key is an
// in-memory random one so the stored "key" round-trips.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import nodeCrypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const INTERNAL = '8a12e3b8-ce06-4053-bc1f-2bc114462036';
const PUBLIC = '14920cca-851a-4752-a547-b08478fc2288';
const ART_PUB = '11111111-1111-4111-8111-111111111111';
const ART_HELD = '22222222-2222-4222-8222-222222222222';

let troveKb; let pool; let calls;

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function article(id, collectionId, { internalOnly = false, publicUrl = null, kind = 'article', steps } = {}) {
  return {
    id, external_id: `x:${id.slice(0, 4)}`, title: `Article ${id.slice(0, 4)}`, kind, category: 'Cat', subcategory: null,
    source_url: null, body: `# Article\n\nBody of ${id}`, format: 'markdown', internal_only: internalOnly, public_url: publicUrl,
    attachments: { documents: [], images: [] }, date_created: null, date_modified: null, updated_at: null,
    collection: { id: collectionId, name: collectionId === INTERNAL ? 'MOT IT Internal' : 'MOT IT Public' },
    ...(steps ? { steps } : {}),
  };
}

beforeAll(async () => {
  process.env.RESOLVD_MASTER_KEY = nodeCrypto.randomBytes(32).toString('base64');
  const { encrypt } = require('../services/crypto');
  const keyEnc = await encrypt(Buffer.from('trove_testkey', 'utf8'), 'bothy_settings.api_key');
  pool = require('../db/pool').pool;
  pool.query = vi.fn(async (sql) => {
    if (/FROM trove_kb_settings/.test(sql)) {
      return { rows: [{
        enabled: true, base_url: 'https://trove.test', public_url: 'https://kb.test', api_key_enc: keyEnc,
        internal_collection_ids: [INTERNAL], public_collection_ids: [PUBLIC], collection_names: { [INTERNAL]: 'MOT IT Internal', [PUBLIC]: 'MOT IT Public' },
        suggestions_enabled: true, public_strict: true, local_kb_enabled: false,
      }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  troveKb = require('../services/troveKb');
});

beforeEach(() => {
  troveKb.invalidateCache();
  calls = [];
  globalThis.fetch = vi.fn(async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname + u.search, method: init.method || 'GET', auth: init.headers?.Authorization });
    if (u.pathname === '/api/v1/kb/collections') {
      return jsonResponse(200, { data: [
        { id: INTERNAL, name: 'MOT IT Internal', public: false, writable: true, articles: 9 },
        { id: PUBLIC, name: 'MOT IT Public', public: true, writable: false, articles: 5 },
        { id: '33333333-3333-4333-8333-333333333333', name: 'Unmapped', public: true, writable: false, articles: 1 },
      ] });
    }
    if (u.pathname === '/api/v1/kb/search') {
      const q = u.searchParams.get('q');
      const cid = u.searchParams.get('collection_id');
      if (q !== 'match' && q !== 'lid OR closed') return jsonResponse(200, { data: [] });
      if (q === 'lid OR closed') return jsonResponse(200, { data: [{ id: ART_PUB, title: 'Fallback hit', kind: 'article', collection: { id: PUBLIC, name: 'MOT IT Public' }, matched: { snippet: 'the <mark>lid</mark>', heading: 'H' } }] });
      const hits = [];
      if (!cid || cid === PUBLIC) hits.push({ id: ART_PUB, title: 'Public one', kind: 'article', collection: { id: PUBLIC, name: 'MOT IT Public' }, matched: { chunk: 0, heading: 'Steps', snippet: 'a <mark>match</mark> here' } });
      if (!cid || cid === INTERNAL) hits.push({ id: ART_HELD, title: 'Held back', kind: 'runbook', collection: { id: INTERNAL, name: 'MOT IT Internal' }, matched: { chunk: 1, heading: null, snippet: 'x' } });
      return jsonResponse(200, { data: hits, next_cursor: null });
    }
    if (u.pathname === `/api/v1/kb/articles/${ART_PUB}`) return jsonResponse(200, article(ART_PUB, PUBLIC, { publicUrl: `https://kb.test/pub/kb/articles/${ART_PUB}` }));
    if (u.pathname === `/api/v1/kb/articles/${ART_HELD}`) return jsonResponse(200, article(ART_HELD, INTERNAL, { internalOnly: true, kind: 'runbook', steps: [{ id: 'abc12345', text: 'Do it', canned: 'Fidium VM PIN Reset' }] }));
    if (u.pathname.startsWith('/api/v1/kb/articles/')) return jsonResponse(404, { error: { code: 'not_found', message: 'Article not found' } });
    if (u.pathname.startsWith('/api/v1/kb/collections/') && init.method === 'PUT') {
      if (u.pathname.includes(PUBLIC)) return jsonResponse(403, { error: { code: 'forbidden', message: 'This key needs the "write" scope' } });
      return jsonResponse(201, article(ART_HELD, INTERNAL));
    }
    return jsonResponse(500, { error: { code: 'boom', message: 'nope' } });
  });
});

describe('services/troveKb (REST client)', () => {
  it('sends the bearer key and shapes search hits', async () => {
    const hits = await troveKb.search({ q: 'match', limit: 5, handler: true });
    expect(calls[0].auth).toBe('Bearer trove_testkey');
    // Mapping order leads: internal collections first, then public.
    expect(hits.map((h) => h.article_id)).toEqual([ART_HELD, ART_PUB]);
    const pub = hits.find((h) => h.article_id === ART_PUB);
    const held = hits.find((h) => h.article_id === ART_HELD);
    expect(pub.snippet).toBe('a match here');              // <mark> stripped
    expect(pub.heading).toBe('Steps');
    expect(held.kind).toBe('runbook');
    expect(held.scope).toBe('internal');
    expect(pub.public_url).toBe(`https://kb.test/pub/kb/articles/${ART_PUB}`);
  });

  it('makes one unfiltered call when every readable collection is mapped, else fans out', async () => {
    await troveKb.search({ q: 'match', handler: true });
    // Three readable, two mapped: fan-out, one search call per mapped collection.
    const searches = calls.filter((c) => c.path.startsWith('/api/v1/kb/search'));
    expect(searches).toHaveLength(2);
    expect(searches.map((c) => new URL('http://x' + c.path).searchParams.get('collection_id')).sort()).toEqual([INTERNAL, PUBLIC].sort());
  });

  it('caches reads for the TTL and drops them on invalidateArticle', async () => {
    await troveKb.search({ q: 'match', handler: true });
    const n = calls.length;
    await troveKb.search({ q: 'match', handler: true });
    expect(calls.length).toBe(n);                          // served from cache
    troveKb.invalidateArticle(ART_PUB);
    await troveKb.search({ q: 'match', handler: true });
    expect(calls.length).toBeGreaterThan(n);
  });

  it('non-handlers get only articles Trove KB confirms public', async () => {
    const hits = await troveKb.search({ q: 'match', handler: false });
    expect(hits.map((h) => h.article_id)).toEqual([ART_PUB]);
    expect(hits[0].public).toBe(true);
    await expect(troveKb.getArticle(ART_HELD, { handler: false })).rejects.toMatchObject({ httpStatus: 404 });
    const held = await troveKb.getArticle(ART_HELD, { handler: true });
    expect(held.internal_only).toBe(true);
    expect(held.steps[0]).toMatchObject({ id: 'abc12345', canned: 'Fidium VM PIN Reset' });
  });

  it('retries with OR of key terms when the exact query finds nothing', async () => {
    const none = await troveKb.search({ q: 'nothing', handler: true });
    expect(none).toEqual([]);
    const hits = await troveKb.search({ q: 'the lid closed', handler: true, orFallback: true });
    expect(hits[0]?.title).toBe('Fallback hit');
  });

  it('maps Trove KB errors without leaking the key', async () => {
    await expect(troveKb.getArticle('99999999-9999-4999-8999-999999999999', { handler: true })).rejects.toMatchObject({ httpStatus: 404 });
    const err = await troveKb.upsertArticle({ collectionId: PUBLIC, externalId: 'x', title: 't', body: 'b' }).catch((e) => e);
    expect(err.httpStatus).toBe(502);
    expect(err.message).toMatch(/write/);
    expect(err.message).not.toMatch(/trove_testkey/);
    const ok = await troveKb.upsertArticle({ collectionId: INTERNAL, externalId: 'x', title: 't', body: 'b', internalOnly: true });
    expect(ok.article_id).toBe(ART_HELD);
    expect(calls.at(-1).method).toBe('PUT');
  });

  it('turns an unreachable host into a 502 and a timeout into a 504', async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError('fetch failed'); });
    await expect(troveKb.listCollections()).rejects.toMatchObject({ httpStatus: 502 });
    globalThis.fetch = vi.fn(async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
    await expect(troveKb.listCollections()).rejects.toMatchObject({ httpStatus: 504 });
  });
});

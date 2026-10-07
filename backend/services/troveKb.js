// An article is public when Trove KB gives it a public address: its collection
// is on the public site, the site is on, and the article is not held back
// (`internal_only`). Search hits do not carry that, so a non-handler search
// fetches each hit (cached) and filters. Strict mode refuses anything that
// cannot be confirmed; lenient mode trusts the collection mapping.
function publicEnough(settings, article) {
  if (article && typeof article.public === 'boolean') return article.public;
  if (article && article.public_url) return true;
  if (article && article.internal_only === true) return false;
  return !settings.public_strict;
}

// Trove KB — the company documentation platform (external knowledge base).
//
// Resolvd is a trusted reader of Trove KB: one API key, held here encrypted,
// and Resolvd decides on its own side who sees which collections.
// Handlers (global Admin/Manager/Tech, or project handlers) see the
// "internal" and "public" collections an admin mapped; everyone else
// sees "public" only. Nothing about Resolvd users is sent to Trove KB.
//
// Transport: Trove KB's REST knowledge base routes under {base_url}/api/v1/kb
// (collections, search, articles, upsert/archive by external id).

const { pool } = require('../db/pool');
const { encrypt, decrypt } = require('./crypto');
const kms = require('./kms');
const nodeCrypto = require('crypto');

// Encryption context of the stored key. Kept at the old product name on
// purpose: it is bound into the ciphertext (AAD), so renaming it would make
// every saved key unreadable. Not a table name.
const KEY_CTX = 'bothy_settings.api_key';
const WEBHOOK_CTX = 'trove_kb_settings.webhook_secret';
const SETTINGS_TTL_MS = 30 * 1000;
const RESULT_TTL_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 12 * 1000;

let _settings = null;
let _settingsAt = 0;
const _results = new Map(); // key -> { at, value }
let _features = { at: 0, value: null }; // OpenAPI-derived capabilities, see features()

function httpError(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

function invalidateCache() {
  _settings = null;
  _settingsAt = 0;
  _results.clear();
  _collectionsCache = null;
  _features = { at: 0, value: null };
}

function normalizeUrl(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/\/+$/, '');
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch { throw httpError(400, `Not a URL: ${s}`); }
  if (!['http:', 'https:'].includes(u.protocol)) throw httpError(400, 'URL must be http or https');
  return s;
}

function uuidList(v, label) {
  if (v == null) return undefined;
  if (!Array.isArray(v)) throw httpError(400, `${label} must be an array`);
  const out = [];
  for (const raw of v) {
    const s = String(raw).trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)) {
      throw httpError(400, `${label}: '${raw}' is not a UUID`);
    }
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

// ─── Settings ───────────────────────────────────────────────────────────

async function getSettings({ withKey = false } = {}) {
  const now = Date.now();
  if (!_settings || now - _settingsAt > SETTINGS_TTL_MS) {
    const r = await pool.query(`SELECT * FROM trove_kb_settings WHERE id = 1`);
    const row = r.rows[0] || {};
    let apiKey = null;
    let webhookSecret = null;
    if (kms.isAvailable() && row.api_key_enc) {
      try {
        apiKey = (await decrypt(row.api_key_enc, KEY_CTX)).toString('utf8');
      } catch (err) {
        console.error('troveKb: api key decrypt failed:', err.message);
      }
    }
    if (kms.isAvailable() && row.webhook_secret_enc) {
      try {
        webhookSecret = (await decrypt(row.webhook_secret_enc, WEBHOOK_CTX)).toString('utf8');
      } catch (err) {
        console.error('troveKb: webhook secret decrypt failed:', err.message);
      }
    }
    const internal = row.internal_collection_ids || [];
    const pub = row.public_collection_ids || [];
    _settings = {
      admin_enabled: row.enabled === true,
      // Usable only when switched on, pointed somewhere, and the key can
      // be read. Without RESOLVD_MASTER_KEY the key cannot be decrypted.
      enabled: row.enabled === true && !!row.base_url && !!apiKey,
      base_url: row.base_url || null,
      public_url: row.public_url || null,
      internal_collection_ids: internal,
      public_collection_ids: pub.filter((id) => !internal.includes(id)),
      collection_names: row.collection_names || {},
      suggestions_enabled: row.suggestions_enabled !== false,
      // Non-handlers see an article only when Trove KB says it is on the public
      // site (`public: true` on the hit). Until Trove KB returns that flag, strict
      // mode means non-handlers see nothing; off means whole-collection trust.
      public_strict: row.public_strict !== false,
      // The built-in per-project KB stays until the migration turns it off.
      local_kb_enabled: row.local_kb_enabled !== false,
      last_ok_at: row.last_ok_at || null,
      last_error: row.last_error || null,
      auto_map_public: row.auto_map_public !== false,
      known_collection_ids: row.known_collection_ids || [],
      collections_synced_at: row.collections_synced_at || null,
      has_api_key: !!row.api_key_enc,
      has_webhook_secret: !!row.webhook_secret_enc,
      last_webhook_at: row.last_webhook_at || null,
      last_webhook_event: row.last_webhook_event || null,
      snapshots_refreshed_at: row.snapshots_refreshed_at || null,
      kms_available: kms.isAvailable(),
      updated_at: row.updated_at || null,
      _apiKey: apiKey,
      _webhookSecret: webhookSecret,
    };
    _settingsAt = now;
  }
  return withKey ? { ..._settings } : { ..._settings, _apiKey: null, _webhookSecret: null };
}

async function patchSettings(partial) {
  const updates = {};
  if (partial.enabled !== undefined) updates.enabled = !!partial.enabled;
  if (partial.suggestions_enabled !== undefined) updates.suggestions_enabled = !!partial.suggestions_enabled;
  if (partial.public_strict !== undefined) updates.public_strict = !!partial.public_strict;
  if (partial.local_kb_enabled !== undefined) updates.local_kb_enabled = !!partial.local_kb_enabled;
  if (partial.auto_map_public !== undefined) updates.auto_map_public = !!partial.auto_map_public;
  const known = uuidList(partial.known_collection_ids, 'known_collection_ids');
  if (known !== undefined) updates.known_collection_ids = known;
  if (partial.base_url !== undefined) updates.base_url = normalizeUrl(partial.base_url);
  if (partial.public_url !== undefined) updates.public_url = normalizeUrl(partial.public_url);
  const internal = uuidList(partial.internal_collection_ids, 'internal_collection_ids');
  const pub = uuidList(partial.public_collection_ids, 'public_collection_ids');
  if (internal !== undefined) updates.internal_collection_ids = internal;
  if (pub !== undefined) updates.public_collection_ids = pub;
  if (partial.collection_names !== undefined) {
    const names = partial.collection_names;
    if (!names || typeof names !== 'object' || Array.isArray(names)) throw httpError(400, 'collection_names must be an object');
    const clean = {};
    for (const [k, v] of Object.entries(names)) clean[String(k).toLowerCase()] = String(v).slice(0, 200);
    updates.collection_names = JSON.stringify(clean);
  }
  await pool.query(`INSERT INTO trove_kb_settings (id) VALUES (1) ON CONFLICT DO NOTHING`);
  const cols = Object.keys(updates);
  if (cols.length) {
    const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    await pool.query(`UPDATE trove_kb_settings SET ${sets}, updated_at = NOW() WHERE id = 1`, cols.map((c) => updates[c]));
  }
  invalidateCache();
  return getSettings();
}

async function setApiKey(plaintext) {
  await pool.query(`INSERT INTO trove_kb_settings (id) VALUES (1) ON CONFLICT DO NOTHING`);
  if (plaintext == null || String(plaintext).trim() === '') {
    await pool.query(`UPDATE trove_kb_settings SET api_key_enc = NULL, last_error = NULL, updated_at = NOW() WHERE id = 1`);
    invalidateCache();
    return;
  }
  if (!kms.isAvailable()) {
    throw httpError(400, 'RESOLVD_MASTER_KEY not configured — the Trove KB API key cannot be stored until it is (Admin → Encryption).');
  }
  const enc = await encrypt(Buffer.from(String(plaintext).trim(), 'utf8'), KEY_CTX);
  // A new key is a fresh start; the next test records its own outcome.
  await pool.query(`UPDATE trove_kb_settings SET api_key_enc = $1, last_error = NULL, updated_at = NOW() WHERE id = 1`, [enc]);
  invalidateCache();
}

// The webhook signing secret, generated here or pasted from Trove KB.
async function setWebhookSecret(plaintext) {
  await pool.query(`INSERT INTO trove_kb_settings (id) VALUES (1) ON CONFLICT DO NOTHING`);
  if (plaintext == null || String(plaintext).trim() === '') {
    await pool.query(`UPDATE trove_kb_settings SET webhook_secret_enc = NULL, updated_at = NOW() WHERE id = 1`);
    invalidateCache();
    return;
  }
  if (!kms.isAvailable()) throw httpError(400, 'RESOLVD_MASTER_KEY not configured — the webhook secret cannot be stored until it is.');
  const enc = await encrypt(Buffer.from(String(plaintext).trim(), 'utf8'), WEBHOOK_CTX);
  await pool.query(`UPDATE trove_kb_settings SET webhook_secret_enc = $1, updated_at = NOW() WHERE id = 1`, [enc]);
  invalidateCache();
}

function generateWebhookSecret() {
  return `whsec_${nodeCrypto.randomBytes(32).toString('base64url')}`;
}

// X-Trove-Signature: sha256=<hex hmac-sha256(secret, raw body)>. Constant
// time; any malformed header is a rejection, never a throw.
function verifyWebhookSignature(secret, rawBody, header) {
  if (!secret || !header || typeof header !== 'string') return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) return false;
  const expected = nodeCrypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(m[1].toLowerCase(), 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && nodeCrypto.timingSafeEqual(a, b);
}

// Drop everything cached about one article: its body and every search
// result list (a search page may name it). Cheap; searches re-fill in 60 s anyway.
function invalidateArticle(articleId) {
  const id = String(articleId || '').toLowerCase();
  for (const k of [..._results.keys()]) {
    if (k === `article:key:${id}` || k === `article:public:${id}` || k.startsWith('search:') || k.startsWith('list:')) _results.delete(k);
  }
  _collectionsCache = null;
}

async function recordWebhook(event) {
  await pool.query(`UPDATE trove_kb_settings SET last_webhook_at = NOW(), last_webhook_event = $1 WHERE id = 1`, [String(event || '').slice(0, 80)]);
  _settings = null;
}

async function recordOutcome(error) {
  if (error) {
    await pool.query(`UPDATE trove_kb_settings SET last_error = $1, updated_at = NOW() WHERE id = 1`, [String(error).slice(0, 500)]);
  } else {
    await pool.query(`UPDATE trove_kb_settings SET last_ok_at = NOW(), last_error = NULL, updated_at = NOW() WHERE id = 1`);
  }
  _settings = null;
}

// ─── Transport (REST /api/v1) ────────────────────────────────────────────
//
// Trove KB's REST knowledge base routes. Error shape: { error: { code, message } }.
// Lists come back as { data, next_cursor }. Never includes the key in errors.

async function rest(path, { method = 'GET', body, settings, headers } = {}) {
  const cfg = settings || await getSettings({ withKey: true });
  if (!cfg.base_url || !cfg._apiKey) throw httpError(503, 'Trove KB is not configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${cfg.base_url}/api/v1${path}`, {
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${cfg._apiKey}`,
        'User-Agent': 'Resolvd-TroveKb/2',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(headers || {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw httpError(504, 'Trove KB did not answer in time');
    throw httpError(502, `Could not reach Trove KB: ${err.message}`);
  }
  clearTimeout(timer);
  if (res.status === 204) return null;
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  if (res.status === 401) throw httpError(502, 'Trove KB rejected the API key');
  if (res.status === 403) throw httpError(502, json?.error?.message || 'The Trove KB API key is not allowed to do that');
  if (res.status === 404) throw httpError(404, json?.error?.message || 'Not found in Trove KB');
  if (res.status === 400) throw httpError(400, json?.error?.message || 'Trove KB rejected the request');
  if (!res.ok) throw httpError(502, json?.error?.message || `Trove KB answered HTTP ${res.status}`);
  return json;
}

// Ids of every collection the key can read, cached briefly, so a search
// over "all mapped collections" can be one unfiltered call instead of a
// fan-out when the mapping covers everything the key sees.
let _collectionsCache = null;
async function readableCollectionIds(settings) {
  const now = Date.now();
  if (_collectionsCache && now - _collectionsCache.at < 5 * 60 * 1000) return _collectionsCache.ids;
  const ids = new Set((await listCollections({ settings })).map((c) => c.id));
  _collectionsCache = { at: now, ids };
  return ids;
}

const qs = (params) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const str = u.toString();
  return str ? `?${str}` : '';
};

// Memoize a read for RESULT_TTL_MS. Errors are not cached.
async function cached(key, fn) {
  const hit = _results.get(key);
  const now = Date.now();
  if (hit && now - hit.at < RESULT_TTL_MS) return hit.value;
  const value = await fn();
  _results.set(key, { at: now, value });
  if (_results.size > 500) {
    for (const [k, v] of _results) if (now - v.at > RESULT_TTL_MS) _results.delete(k);
  }
  return value;
}

// ─── Visibility ─────────────────────────────────────────────────────────

// Which Trove KB collection ids a caller may read. `handler` is the
// Resolvd-side decision (global role or project handler). Returns
// { ids: string[] | null, scopeOf(id) } where ids === null means "no
// filter: everything the key can read" (handlers when nothing is mapped).
function visibleCollections(settings, handler) {
  const internal = settings.internal_collection_ids;
  const pub = settings.public_collection_ids;
  const scopeOf = (id) => (internal.includes(id) ? 'internal' : pub.includes(id) ? 'public' : null);
  if (handler) {
    const ids = [...internal, ...pub];
    return { ids: ids.length ? ids : null, scopeOf };
  }
  return { ids: pub, scopeOf };
}

function articleUrls(settings, articleId, collectionId) {
  const scope = collectionId && settings.public_collection_ids.includes(collectionId) ? 'public' : 'internal';
  return {
    scope,
    staff_url: settings.base_url ? `${settings.base_url}/kb/articles/${articleId}` : null,
    public_url: scope === 'public' && settings.public_url ? `${settings.public_url}/pub/kb/articles/${articleId}` : null,
  };
}

// Words worth searching from free text: longer tokens, no stop words.
// Trove KB's search ANDs every word (websearch_to_tsquery), so a whole ticket
// title often matches nothing; "a OR b OR c" of its key terms is the fallback.
const STOP = new Set('the a an and or of to in on for with is are was were be been it this that these those from by at as into about after before when then than so if not no yes you your they their we our i me my he she his her them us can could would should will just also very please thanks thank hi hello user users issue problem ticket help need needs needed'.split(' '));
function keyTerms(text, max = 8) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw) || seen.has(raw)) continue;
    seen.add(raw); out.push(raw);
    if (out.length >= max) break;
  }
  return out;
}

// ─── Reads ──────────────────────────────────────────────────────────────

// Collections the key can read, straight from Trove KB (admin mapping UI,
// test connection). Not filtered by visibility.
async function listCollections({ settings } = {}) {
  const out = await rest('/kb/collections', { settings });
  return (out?.data || []).map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description || null,
    site_url: c.site_url || null,
    articles: c.articles ?? null,
    public: c.public === true,
    writable: !!c.writable,
    created_at: c.created_at || null,
  }));
}

function plainSnippet(text) {
  return String(text || '').replace(/<\/?mark>/g, '').replace(/\s+/g, ' ').trim();
}

function shapeHit(settings, hit) {
  const collectionId = hit.collection?.id || null;
  const id = hit.id || hit.article_id;
  return {
    article_id: id,
    title: hit.title,
    kind: hit.kind || 'article',
    source_type: hit.source_type || null,
    public: typeof hit.public === 'boolean' ? hit.public : null,
    collection_id: collectionId,
    collection_name: hit.collection?.name || settings.collection_names[collectionId] || null,
    category: hit.category || null,
    subcategory: hit.subcategory || null,
    source_url: hit.source_url || null,
    date_modified: hit.date_modified || null,
    snippet: plainSnippet(hit.matched?.snippet),
    heading: hit.matched?.heading || null,
    ...articleUrls(settings, id, collectionId),
  };
}

function shapeArticle(settings, a) {
  const collectionId = a.collection?.id || null;
  const urls = articleUrls(settings, a.id, collectionId);
  return {
    article_id: a.id,
    title: a.title,
    kind: a.kind || 'article',
    source_type: a.source_type || null,
    steps: Array.isArray(a.steps) ? a.steps : [],
    internal_only: a.internal_only === true,
    public: !!a.public_url,
    collection_id: collectionId,
    collection_name: a.collection?.name || settings.collection_names[collectionId] || null,
    category: a.category || null,
    subcategory: a.subcategory || null,
    source_url: a.source_url || null,
    external_id: a.external_id || null,
    date_created: a.date_created || null,
    date_modified: a.date_modified || a.updated_at || null,
    attachments: a.attachments || { documents: [], images: [] },
    body: String(a.body || ''),
    format: a.format || 'markdown',
    scope: urls.scope,
    staff_url: urls.staff_url,
    // Trove KB's own public address wins; fall back to ours for the same site.
    public_url: a.public_url || urls.public_url,
  };
}

// `preferCollectionId` (a project's home collection) is searched first and
// its hits lead the list; the rest follow in mapping order.
// `orFallback`: when the exact query finds nothing and has several words,
// retry with its key terms joined by OR (title-driven suggestions and briefs).
async function search({ q, limit = 10, collectionId = null, kind = null, handler = false, preferCollectionId = null, orFallback = false }) {
  const settings = await getSettings({ withKey: true });
  if (!settings.enabled) throw httpError(503, 'Trove KB is not configured');
  const query = String(q || '').trim();
  if (!query) return [];
  const exact = await searchOnce({ settings, query, limit, collectionId, kind, handler, preferCollectionId });
  if (exact.length || !orFallback) return exact;
  const terms = keyTerms(query);
  if (terms.length < 2) return exact;
  return searchOnce({ settings, query: terms.join(' OR '), limit, collectionId, kind, handler, preferCollectionId });
}

async function searchOnce({ settings, query, limit, collectionId, kind, handler, preferCollectionId }) {
  const lim = Math.max(1, Math.min(50, Number(limit) || 10));
  const vis = visibleCollections(settings, handler);

  let targets;
  if (collectionId) {
    if (vis.ids !== null && !vis.ids.includes(collectionId)) return [];
    targets = [collectionId];
  } else {
    targets = vis.ids; // null => one unfiltered call
  }
  if (Array.isArray(targets) && targets.length === 0) return [];
  const prefer = preferCollectionId && !collectionId
    && (vis.ids === null || vis.ids.includes(preferCollectionId)) ? preferCollectionId : null;
  if (prefer && Array.isArray(targets)) targets = [prefer, ...targets.filter((id) => id !== prefer)];
  // Every readable collection is wanted: one call instead of a fan-out.
  if (Array.isArray(targets) && !collectionId) {
    try {
      const all = await readableCollectionIds(settings);
      if (all.size > 0 && all.size === targets.length && targets.every((id) => all.has(id))) targets = null;
    } catch { /* fan out as before */ }
  }

  // Non-handlers read as the public site would. When Trove KB honors
  // `audience`, the result is already public-only; otherwise each hit is
  // confirmed below.
  const viaAudience = !handler && await audienceSupported(settings);
  const audience = viaAudience ? 'public' : null;
  const run = (cid) => cached(`search:${audience || 'key'}:${cid || '*'}:${kind || ''}:${lim}:${query}`, async () =>
    (await rest(`/kb/search${qs({ q: query, limit: lim, collection_id: cid, kind, audience })}`, { settings }))?.data || []);

  let hits;
  if (targets === null) {
    hits = await run(null);
    if (prefer) {
      try {
        const lead = await run(prefer);
        const leadIds = new Set(lead.map((h) => h.id));
        hits = [...lead, ...hits.filter((h) => !leadIds.has(h.id))];
      } catch { /* keep the unfiltered order */ }
    }
  } else {
    const settled = await Promise.allSettled(targets.map((cid) => run(cid)));
    hits = [];
    let firstErr = null;
    for (const s of settled) {
      if (s.status === 'fulfilled') hits.push(...s.value);
      else if (!firstErr) firstErr = s.reason;
    }
    if (!hits.length && firstErr) throw firstErr;
  }

  const seen = new Set();
  let out = [];
  for (const h of hits) {
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    out.push(shapeHit(settings, h));
  }
  if (!handler && viaAudience) {
    for (const h of out) h.public = true;
  } else if (!handler) {
    // Confirm each hit is really public before a non-handler sees it.
    const checks = await Promise.allSettled(out.map((h) => fetchArticle(settings, h.article_id)));
    out = out.filter((h, i) => checks[i].status === 'fulfilled' && publicEnough(settings, checks[i].value));
    for (const h of out) h.public = true;
  }
  return out.slice(0, lim);
}

async function fetchArticle(settings, id, audience = null) {
  return cached(`article:${audience || 'key'}:${id}`, async () =>
    shapeArticle(settings, await rest(`/kb/articles/${id}${qs({ audience })}`, { settings })));
}

// One article with its whole body. 404 when outside the caller's visible
// collections, or (non-handlers) not confirmed public.
async function getArticle(articleId, { handler = false } = {}) {
  const settings = await getSettings({ withKey: true });
  if (!settings.enabled) throw httpError(503, 'Trove KB is not configured');
  const id = String(articleId || '').toLowerCase();
  if (!/^[0-9a-f-]{36}$/.test(id)) throw httpError(404, 'Article not found');
  const viaAudience = !handler && await audienceSupported(settings);
  let article;
  try { article = await fetchArticle(settings, id, viaAudience ? 'public' : null); }
  catch (err) { if (err.httpStatus === 404) throw httpError(404, 'Article not found'); throw err; }
  const vis = visibleCollections(settings, handler);
  if (vis.ids !== null && !vis.ids.includes(article.collection_id)) throw httpError(404, 'Article not found');
  if (!handler && !viaAudience && !publicEnough(settings, article)) throw httpError(404, 'Article not found');
  if (viaAudience) article.public = true;
  return article;
}

// Articles in one collection, optionally by kind. Pages through Trove KB's
// cursor up to `max` rows. Handler-only (callers decide).
async function listArticles({ collectionId, kind = null, category = null, max = 500 }) {
  const settings = await getSettings({ withKey: true });
  if (!settings.enabled) throw httpError(503, 'Trove KB is not configured');
  const out = [];
  let cursor = null;
  for (let page = 0; page < 20 && out.length < max; page++) {
    const r = await rest(`/kb/articles${qs({ collection_id: collectionId, kind, category, limit: 200, cursor })}`, { settings });
    for (const a of r?.data || []) {
      out.push({
        article_id: a.id, external_id: a.external_id || null, title: a.title, kind: a.kind || 'article',
        category: a.category || null, subcategory: a.subcategory || null, date_modified: a.date_modified || null,
        collection_id: collectionId, collection_name: settings.collection_names[collectionId] || null,
        ...articleUrls(settings, a.id, collectionId),
      });
    }
    cursor = r?.next_cursor || null;
    if (!cursor) break;
  }
  return out.slice(0, max);
}

// Create or replace an article by external id. Needs the key to hold the
// write scope and a write grant on the collection.
async function upsertArticle({ collectionId, externalId, title, body, category, subcategory, kind, sourceUrl, internalOnly }) {
  const settings = await getSettings({ withKey: true });
  if (!settings.enabled) throw httpError(503, 'Trove KB is not configured');
  const payload = { title, body };
  if (category) payload.category = category;
  if (subcategory) payload.subcategory = subcategory;
  if (kind) payload.kind = kind;
  if (sourceUrl) payload.source_url = sourceUrl;
  if (typeof internalOnly === 'boolean') payload.internal_only = internalOnly;
  const r = await rest(`/kb/collections/${collectionId}/articles/${encodeURIComponent(externalId)}`, { method: 'PUT', body: payload, settings });
  _results.clear();
  const a = r?.data || r;
  return a && a.id ? shapeArticle(settings, a) : a;
}

async function archiveArticle({ collectionId, externalId }) {
  const settings = await getSettings({ withKey: true });
  if (!settings.enabled) throw httpError(503, 'Trove KB is not configured');
  await rest(`/kb/collections/${collectionId}/articles/${encodeURIComponent(externalId)}`, { method: 'DELETE', settings });
  _results.clear();
}

// One collection with its categories as a tree, visibility-checked.
async function getCollection(collectionId, { handler = false, kind = null } = {}) {
  const settings = await getSettings({ withKey: true });
  if (!settings.enabled) throw httpError(503, 'Trove KB is not configured');
  const id = String(collectionId || '').toLowerCase();
  const vis = visibleCollections(settings, handler);
  if (vis.ids !== null && !vis.ids.includes(id)) throw httpError(404, 'Collection not found');
  const viaAudience = !handler && await audienceSupported(settings);
  const audience = viaAudience ? 'public' : null;
  const d = await cached(`collection:${audience || 'key'}:${id}:${kind || ''}`, () => rest(`/kb/collections/${id}${qs({ kind, audience })}`, { settings }));
  if (!handler && !viaAudience && d.public !== true && settings.public_strict) throw httpError(404, 'Collection not found');
  // Kind counts: Trove KB will return `kinds`; until then derive the runbook
  // count from a second, kind-filtered read of the categories.
  let kinds = d.kinds && typeof d.kinds === 'object' ? d.kinds : null;
  if (!kinds && !kind) {
    try {
      const rb = await cached(`collection:${audience || 'key'}:${id}:runbook`, () => rest(`/kb/collections/${id}${qs({ kind: 'runbook', audience })}`, { settings }));
      const runbooks = (rb.categories || []).reduce((n, r) => n + (r.articles || 0), 0);
      kinds = { article: Math.max(0, (d.articles || 0) - runbooks), runbook: runbooks };
    } catch { kinds = null; }
  }
  const tree = new Map();
  for (const row of d.categories || []) {
    const cat = row.category || '';
    if (!tree.has(cat)) tree.set(cat, { category: cat, articles: 0, subcategories: [] });
    const node = tree.get(cat);
    node.articles += row.articles || 0;
    if (row.subcategory) node.subcategories.push({ subcategory: row.subcategory, articles: row.articles || 0 });
  }
  const categories = [...tree.values()].sort((a, b) => (a.category || '~').localeCompare(b.category || '~'));
  for (const c of categories) c.subcategories.sort((a, b) => a.subcategory.localeCompare(b.subcategory));
  return {
    id: d.id, name: d.name, description: d.description || null, site_url: d.site_url || null,
    public: d.public === true, articles: d.articles ?? null,
    scope: vis.scopeOf(id) || (vis.ids === null ? 'internal' : null),
    kinds,
    source_types: Array.isArray(d.source_types) ? d.source_types : null,
    categories,
  };
}

// One page of a collection's articles. Non-handlers only get articles
// confirmed public (one cached article read per row, page capped).
async function listArticlesPage({ collectionId, category = null, subcategory = null, kind = null, sourceType = null, sort = 'name', dir = 'asc', limit = 50, cursor = null, handler = false }) {
  const settings = await getSettings({ withKey: true });
  if (!settings.enabled) throw httpError(503, 'Trove KB is not configured');
  const id = String(collectionId || '').toLowerCase();
  const vis = visibleCollections(settings, handler);
  if (vis.ids !== null && !vis.ids.includes(id)) throw httpError(404, 'Collection not found');
  const lim = Math.max(1, Math.min(handler ? 200 : 50, Number(limit) || 50));
  const s = ['name', 'modified'].includes(sort) ? sort : 'name';
  const d = ['asc', 'desc'].includes(dir) ? dir : 'asc';
  const viaAudience = !handler && await audienceSupported(settings);
  const audience = viaAudience ? 'public' : null;
  const key = `list:${audience || 'key'}:${id}:${category || ''}:${subcategory || ''}:${kind || ''}:${sourceType || ''}:${s}:${d}:${lim}:${cursor || ''}`;
  const r = await cached(key, () => rest(`/kb/articles${qs({ collection_id: id, category, subcategory, kind, source_type: sourceType, audience, sort: s, dir: d, limit: lim, cursor })}`, { settings }));
  let rows = (r?.data || []).map((a) => ({
    article_id: a.id, external_id: a.external_id || null, title: a.title, kind: a.kind || 'article',
    source_type: a.source_type || null,
    category: a.category || null, subcategory: a.subcategory || null, date_modified: a.date_modified || null,
    collection_id: id, collection_name: settings.collection_names[id] || null,
    ...articleUrls(settings, a.id, id),
  }));
  if (!handler && viaAudience) {
    rows = rows.map((row) => ({ ...row, public: true }));
  } else if (!handler) {
    const checks = await Promise.allSettled(rows.map((row) => fetchArticle(settings, row.article_id)));
    rows = rows.filter((row, i) => checks[i].status === 'fulfilled' && publicEnough(settings, checks[i].value))
      .map((row, i) => ({ ...row, public: true, public_url: checks[i]?.value?.public_url || row.public_url }));
  }
  return { articles: rows, next_cursor: r?.next_cursor || null };
}

// Pick up collections Trove KB has gained since we last looked. A new
// public collection is mapped Public when auto_map_public is on; any other
// new one is left unmapped (Hidden) for an admin. Returns what changed.
async function syncCollections() {
  const settings = await getSettings({ withKey: true });
  if (!settings.enabled) return { skipped: 'disabled' };
  const live = await listCollections({ settings });
  const known = new Set(settings.known_collection_ids);
  const names = { ...settings.collection_names };
  const pub = [...settings.public_collection_ids];
  const added = [];
  const seen = [];
  for (const c of live) {
    names[c.id] = c.name;
    if (known.has(c.id)) continue;
    seen.push({ id: c.id, name: c.name, public: c.public });
    if (settings.auto_map_public && c.public && !settings.internal_collection_ids.includes(c.id) && !pub.includes(c.id)) {
      pub.push(c.id);
      added.push({ id: c.id, name: c.name });
    }
  }
  const nextKnown = [...new Set([...settings.known_collection_ids, ...live.map((c) => c.id)])];
  await pool.query(
    `UPDATE trove_kb_settings SET collection_names = $1, public_collection_ids = $2, known_collection_ids = $3, collections_synced_at = NOW(), updated_at = NOW() WHERE id = 1`,
    [JSON.stringify(names), pub, nextKnown]
  );
  invalidateCache();
  return { live: live.length, new_collections: seen, auto_mapped: added };
}

// ─── Reactions (favorites, helpful votes), shared with kb.gomotx.com ───────
//
// Trove KB keys a reader by a hash of their email; the API names the reader
// with X-Trove-Reader. Until Trove KB ships these routes, every call reports
// `available: false` (probed once per five minutes) and the UI stays hidden.

// What this Trove KB offers, read from its OpenAPI once per five minutes:
// the reactions routes, and `audience` on reads (Trove KB applies its own
// public-site rules, so non-handler reads need no per-hit confirmation).
async function features(settings) {
  const now = Date.now();
  if (_features.value && now - _features.at < 5 * 60 * 1000) return _features.value;
  let value = { reactions: false, audience: false };
  try {
    const spec = await cached('openapi', () => rest('/openapi.json', { settings }));
    const paths = spec?.paths || {};
    const hasParam = (p, name) => (paths[p]?.get?.parameters || []).some((x) => x.name === name);
    value = {
      reactions: !!paths['/kb/articles/{id}/reactions'],
      audience: hasParam('/kb/search', 'audience') && hasParam('/kb/articles', 'audience') && hasParam('/kb/articles/{id}', 'audience'),
    };
  } catch { /* keep false */ }
  _features = { at: now, value };
  return value;
}
async function reactionsAvailable(settings) { return (await features(settings)).reactions; }
async function audienceSupported(settings) { return (await features(settings)).audience; }

function readerHeaders(email) {
  if (!email) throw httpError(400, 'A reader email is required');
  return { 'X-Trove-Reader': String(email).trim().toLowerCase() };
}

async function restAs(email, path, opts = {}) {
  const settings = opts.settings || await getSettings({ withKey: true });
  // rest() builds its own headers; add the reader header by wrapping fetch args.
  return rest(path, { ...opts, settings, headers: readerHeaders(email) });
}

async function getReactions(articleId, { email, handler = false }) {
  const settings = await getSettings({ withKey: true });
  if (!settings.enabled) throw httpError(503, 'Trove KB is not configured');
  if (!(await reactionsAvailable(settings))) return { available: false };
  await getArticle(articleId, { handler }); // visibility, 404 when out of reach
  const r = await restAs(email, `/kb/articles/${articleId}/reactions`, { settings });
  return { available: true, favorites: r.favorites ?? 0, helpful_up: r.helpful_up ?? 0, helpful_down: r.helpful_down ?? 0,
           helpfulness: r.helpfulness ?? null, mine: { favorite: !!r.mine?.favorite, vote: r.mine?.vote || null } };
}

async function setFavorite(articleId, { email, handler = false, on }) {
  const settings = await getSettings({ withKey: true });
  if (!(await reactionsAvailable(settings))) throw httpError(503, 'Reactions are not available in Trove KB yet');
  await getArticle(articleId, { handler });
  await restAs(email, `/kb/articles/${articleId}/favorite`, { method: on ? 'PUT' : 'DELETE', settings });
  for (const k of [..._results.keys()]) if (k.startsWith('favorites:')) _results.delete(k);
}

async function setVote(articleId, { email, handler = false, helpful }) {
  const settings = await getSettings({ withKey: true });
  if (!(await reactionsAvailable(settings))) throw httpError(503, 'Reactions are not available in Trove KB yet');
  await getArticle(articleId, { handler });
  if (helpful === null) await restAs(email, `/kb/articles/${articleId}/vote`, { method: 'DELETE', settings });
  else await restAs(email, `/kb/articles/${articleId}/vote`, { method: 'PUT', body: { helpful: !!helpful }, settings });
}

async function listFavorites({ email, handler = false, limit = 50 }) {
  const settings = await getSettings({ withKey: true });
  if (!settings.enabled) return { available: false, articles: [] };
  if (!(await reactionsAvailable(settings))) return { available: false, articles: [] };
  const r = await cached(`favorites:${String(email).toLowerCase()}:${limit}`, () => restAs(email, `/kb/favorites${qs({ limit })}`, { settings }));
  const vis = visibleCollections(settings, handler);
  const rows = (r?.data || []).map((a) => ({
    article_id: a.id, title: a.title, kind: a.kind || 'article', source_type: a.source_type || null,
    category: a.category || null, subcategory: a.subcategory || null, favorited_at: a.favorited_at || null,
    collection_id: a.collection?.id || null, collection_name: a.collection?.name || settings.collection_names[a.collection?.id] || null,
    ...articleUrls(settings, a.id, a.collection?.id || null),
  })).filter((a) => vis.ids === null || vis.ids.includes(a.collection_id));
  return { available: true, articles: rows };
}

// Admin "Test connection": lists collections, records the outcome, and
// refreshes the name snapshot so the mapping UI and link pills have
// names even when Trove KB is down later.
async function testConnection() {
  const settings = await getSettings({ withKey: true });
  if (!settings.base_url) throw httpError(400, 'Set the Trove KB URL first');
  if (!settings._apiKey) throw httpError(400, settings.kms_available ? 'Save a Trove KB API key first' : 'RESOLVD_MASTER_KEY not configured');
  try {
    const collections = await listCollections({ settings });
    await recordOutcome(null);
    const sync = await syncCollections();
    return { ok: true, collections, auto_mapped: sync.auto_mapped || [], new_collections: sync.new_collections || [] };
  } catch (err) {
    await recordOutcome(err.message);
    throw err;
  }
}

module.exports = {
  getSettings,
  patchSettings,
  setApiKey,
  setWebhookSecret,
  generateWebhookSecret,
  verifyWebhookSignature,
  invalidateArticle,
  recordWebhook,
  testConnection,
  listCollections,
  visibleCollections,
  articleUrls,
  search,
  getArticle,
  listArticles,
  listArticlesPage,
  getCollection,
  getReactions,
  setFavorite,
  setVote,
  listFavorites,
  reactionsAvailable,
  audienceSupported,
  features,
  syncCollections,
  upsertArticle,
  archiveArticle,
  rest,
  keyTerms,
  invalidateCache,
};

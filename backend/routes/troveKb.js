// User-facing Trove KB knowledge base routes. Resolvd holds the Trove KB key;
// these endpoints decide what the caller may see (handler => internal +
// public collections, else public only) and never expose the key.
//
//   GET    /api/trove-kb/status                       — enabled? urls? (any user)
//   GET    /api/trove-kb/collections                  — visible collections
//   GET    /api/trove-kb/search?q=&collection_id=&limit=
//   GET    /api/trove-kb/articles/:id                 — full article (markdown body)
//   GET    /api/trove-kb/tickets/:id/links
//   POST   /api/trove-kb/tickets/:id/links            { article_id, kind? }
//   DELETE /api/trove-kb/tickets/:id/links/:articleId
//   GET    /api/trove-kb/tickets/:id/suggestions?limit=

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { isProjectHandler, GLOBAL_HANDLER_ROLES } = require('../services/ticketHelpers');
const troveKb = require('../services/troveKb');
const troveKbResolution = require('../services/troveKbResolution');
const troveKbAssist = require('../services/troveKbAssist');

const router = express.Router();
router.use(requireAuth);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(res, err, label) {
  if (err.status) return res.status(err.status).json({ error: err.error });
  if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
  console.error(`troveKb ${label}:`, err);
  return res.status(500).json({ error: 'Database error' });
}

// Global handler: sees internal collections everywhere. Project
// handler status is checked per ticket where a ticket is in play.
function isGlobalHandler(user) {
  return GLOBAL_HANDLER_ROLES.has(user?.role);
}

// Only Resolvd Admins are shown links into Trove KB itself (staff URL).
// Everyone else reads articles inside Resolvd and, for public ones, may
// follow the public-site link.
function isTroveKbAdmin(user) {
  return user?.role === 'Admin';
}
function scrubStaffUrl(user, rows) {
  if (isTroveKbAdmin(user)) return rows;
  const strip = (r) => (r && typeof r === 'object' ? { ...r, staff_url: null } : r);
  return Array.isArray(rows) ? rows.map(strip) : strip(rows);
}

async function userCanReadProject(user, projectId) {
  if (user.role === 'Admin') return true;
  const r = await pool.query(
    'SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2 LIMIT 1',
    [projectId, user.id]
  );
  return r.rowCount > 0;
}

async function loadTicket(user, ticketId) {
  if (!Number.isInteger(ticketId) || ticketId <= 0) throw { status: 400, error: 'bad ticket id' };
  const t = await pool.query(`SELECT id, project_id, title, title_enc FROM tickets WHERE id = $1`, [ticketId]);
  if (!t.rows[0]) throw { status: 404, error: 'ticket not found' };
  if (!(await userCanReadProject(user, t.rows[0].project_id))) throw { status: 403, error: 'forbidden (ticket)' };
  const handler = await isProjectHandler(pool, { userId: user.id, role: user.role, projectId: t.rows[0].project_id });
  return { ticket: t.rows[0], handler };
}

router.get('/status', async (req, res) => {
  try {
    const s = await troveKb.getSettings();
    const handler = isGlobalHandler(req.session.user);
    const vis = troveKb.visibleCollections(s, handler);
    let ai = { available: false };
    if (s.enabled && handler) {
      const a = await troveKbResolution.aiAvailability(req.session.user.id);
      ai = a.available ? { available: true } : { available: false, reason: a.reason, note: troveKbResolution.REASON_NOTE[a.reason] || null };
    }
    res.json({
      enabled: s.enabled,
      base_url: isTroveKbAdmin(req.session.user) ? s.base_url : null,
      public_url: s.public_url,
      suggestions_enabled: s.suggestions_enabled,
      local_kb_enabled: s.local_kb_enabled,
      // false when a non-handler has nothing mapped public: hide the UI.
      has_visible: s.enabled && (vis.ids === null || vis.ids.length > 0),
      ai,
    });
  } catch (err) { fail(res, err, 'status'); }
});

router.get('/collections', async (req, res) => {
  try {
    const s = await troveKb.getSettings();
    if (!s.enabled) return res.json([]);
    const handler = isGlobalHandler(req.session.user);
    const vis = troveKb.visibleCollections(s, handler);
    // Live details (description, counts, public flag) when Trove KB answers;
    // the name snapshot otherwise, so the page still renders.
    let live = new Map();
    try { live = new Map((await troveKb.listCollections()).map((c) => [c.id, c])); } catch { /* snapshot only */ }
    const ids = vis.ids === null ? [...live.keys()] : vis.ids;
    const rows = ids.map((id) => {
      const c = live.get(id);
      return { id, name: c?.name || s.collection_names[id] || id, description: c?.description || null, site_url: c?.site_url || null,
               articles: c?.articles ?? null, public: c?.public ?? null, scope: vis.scopeOf(id) || 'internal', live: !!c };
    }).filter((row) => handler || !s.public_strict || row.public !== false);
    res.json(rows);
  } catch (err) { fail(res, err, 'collections'); }
});

// GET /api/trove-kb/collections/:id — one collection with its category tree.
router.get('/collections/:id', async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Collection not found' });
    const s = await troveKb.getSettings();
    if (!s.enabled) return res.status(503).json({ error: 'Trove KB is not configured' });
    const kind = ['article', 'runbook'].includes(req.query.kind) ? req.query.kind : null;
    res.json(await troveKb.getCollection(req.params.id, { handler: isGlobalHandler(req.session.user), kind }));
  } catch (err) { fail(res, err, 'collection'); }
});

// GET /api/trove-kb/articles?collection_id=&category=&subcategory=&kind=&sort=&dir=&limit=&cursor=
router.get('/articles', async (req, res) => {
  try {
    const cid = String(req.query.collection_id || '');
    if (!UUID_RE.test(cid)) return res.status(400).json({ error: 'collection_id (uuid) required' });
    const s = await troveKb.getSettings();
    if (!s.enabled) return res.status(503).json({ error: 'Trove KB is not configured' });
    const str = (v) => (v == null || v === '' ? null : String(v).slice(0, 200));
    const page = await troveKb.listArticlesPage({
      collectionId: cid, category: str(req.query.category), subcategory: str(req.query.subcategory),
      kind: ['article', 'runbook'].includes(req.query.kind) ? req.query.kind : null,
      sourceType: /^[a-z0-9]{1,16}$/i.test(String(req.query.source_type || '')) ? String(req.query.source_type).toLowerCase() : null,
      sort: req.query.sort, dir: req.query.dir, limit: req.query.limit, cursor: str(req.query.cursor),
      handler: isGlobalHandler(req.session.user),
    });
    res.json({ ...page, articles: scrubStaffUrl(req.session.user, page.articles) });
  } catch (err) { fail(res, err, 'articles'); }
});

router.get('/search', async (req, res) => {
  try {
    const s = await troveKb.getSettings();
    if (!s.enabled) return res.json([]);
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const collectionId = req.query.collection_id && UUID_RE.test(req.query.collection_id)
      ? String(req.query.collection_id).toLowerCase() : null;
    const hits = await troveKb.search({
      q, collectionId,
      limit: Number(req.query.limit) || 10,
      handler: isGlobalHandler(req.session.user),
    });
    res.json(scrubStaffUrl(req.session.user, hits));
  } catch (err) { fail(res, err, 'search'); }
});

router.get('/articles/:id', async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Article not found' });
    const s = await troveKb.getSettings();
    if (!s.enabled) return res.status(503).json({ error: 'Trove KB is not configured' });
    // A ticket context lets a project handler (not a global one) read
    // internal articles linked from a ticket they handle.
    let handler = isGlobalHandler(req.session.user);
    const ticketId = Number(req.query.ticket_id);
    if (!handler && Number.isInteger(ticketId) && ticketId > 0) {
      try { handler = (await loadTicket(req.session.user, ticketId)).handler; } catch { /* no ticket context */ }
    }
    res.json(scrubStaffUrl(req.session.user, await troveKb.getArticle(req.params.id, { handler })));
  } catch (err) { fail(res, err, 'article'); }
});

// ─── Reactions: favorites and helpful votes, shared with the public site ──

function readerOf(req) { return req.session.user?.email || req.session.user?.upn || null; }

router.get('/favorites', async (req, res) => {
  try {
    const email = readerOf(req);
    if (!email) return res.json({ available: false, articles: [] });
    const out = await troveKb.listFavorites({ email, handler: isGlobalHandler(req.session.user), limit: Math.min(100, Number(req.query.limit) || 50) });
    res.json({ ...out, articles: scrubStaffUrl(req.session.user, out.articles) });
  } catch (err) { fail(res, err, 'favorites'); }
});

router.get('/articles/:id/reactions', async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Article not found' });
    const email = readerOf(req);
    if (!email) return res.json({ available: false });
    res.json(await troveKb.getReactions(req.params.id, { email, handler: isGlobalHandler(req.session.user) }));
  } catch (err) { fail(res, err, 'reactions'); }
});

router.put('/articles/:id/favorite', async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Article not found' });
    await troveKb.setFavorite(req.params.id, { email: readerOf(req), handler: isGlobalHandler(req.session.user), on: true });
    res.status(204).end();
  } catch (err) { fail(res, err, 'favorite'); }
});
router.delete('/articles/:id/favorite', async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Article not found' });
    await troveKb.setFavorite(req.params.id, { email: readerOf(req), handler: isGlobalHandler(req.session.user), on: false });
    res.status(204).end();
  } catch (err) { fail(res, err, 'unfavorite'); }
});
router.put('/articles/:id/vote', async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Article not found' });
    if (typeof req.body?.helpful !== 'boolean') return res.status(400).json({ error: 'helpful (boolean) required' });
    await troveKb.setVote(req.params.id, { email: readerOf(req), handler: isGlobalHandler(req.session.user), helpful: req.body.helpful });
    res.status(204).end();
  } catch (err) { fail(res, err, 'vote'); }
});
router.delete('/articles/:id/vote', async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Article not found' });
    await troveKb.setVote(req.params.id, { email: readerOf(req), handler: isGlobalHandler(req.session.user), helpful: null });
    res.status(204).end();
  } catch (err) { fail(res, err, 'unvote'); }
});

// ─── Ticket links ────────────────────────────────────────────────────────

router.get('/tickets/:id/links', async (req, res) => {
  try {
    const { ticket, handler } = await loadTicket(req.session.user, Number(req.params.id));
    const s = await troveKb.getSettings();
    const r = await pool.query(
      `SELECT l.article_id, l.title, l.collection_id, l.collection_name, l.kind, l.created_at,
              u.display_name AS created_by_name
         FROM ticket_trove_kb_links l
         LEFT JOIN users u ON u.id = l.created_by
        WHERE l.ticket_id = $1
        ORDER BY l.created_at ASC`,
      [ticket.id]
    );
    // Non-handlers only see links into public collections, and only to
    // articles Trove KB confirms public (held-back ones drop out).
    let rows = r.rows
      .map((row) => ({ ...row, ...troveKb.articleUrls(s, row.article_id, row.collection_id) }))
      .filter((row) => handler || row.scope === 'public');
    if (!handler && rows.length) {
      const checks = await Promise.allSettled(rows.map((row) => troveKb.getArticle(row.article_id, { handler: false })));
      rows = rows.filter((_, i) => checks[i].status === 'fulfilled');
    }
    res.json(scrubStaffUrl(req.session.user, rows));
  } catch (err) { fail(res, err, 'links list'); }
});

router.post('/tickets/:id/links', async (req, res) => {
  try {
    const articleId = String(req.body?.article_id || '').toLowerCase();
    if (!UUID_RE.test(articleId)) return res.status(400).json({ error: 'article_id (uuid) required' });
    const kind = ['manual', 'suggested_accepted', 'system'].includes(req.body?.kind) ? req.body.kind : 'manual';
    const { ticket, handler } = await loadTicket(req.session.user, Number(req.params.id));
    if (!handler) return res.status(403).json({ error: 'Only project handlers can link articles' });
    // Resolve through Trove KB so the snapshot is real and the caller may read it.
    const article = await troveKb.getArticle(articleId, { handler: true });
    const r = await pool.query(
      `INSERT INTO ticket_trove_kb_links (ticket_id, article_id, title, collection_id, collection_name, kind, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (ticket_id, article_id) DO UPDATE
         SET title = EXCLUDED.title, collection_name = EXCLUDED.collection_name
       RETURNING article_id, title, collection_id, collection_name, kind, created_at`,
      [ticket.id, article.article_id, article.title, article.collection_id, article.collection_name, kind, req.session.user.id]
    );
    const s = await troveKb.getSettings();
    res.status(201).json(scrubStaffUrl(req.session.user, { ...r.rows[0], ...troveKb.articleUrls(s, article.article_id, article.collection_id) }));
  } catch (err) { fail(res, err, 'link create'); }
});

router.delete('/tickets/:id/links/:articleId', async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.articleId)) return res.status(400).json({ error: 'bad article id' });
    const { ticket, handler } = await loadTicket(req.session.user, Number(req.params.id));
    if (!handler) return res.status(403).json({ error: 'Only project handlers can unlink articles' });
    await pool.query(`DELETE FROM ticket_trove_kb_links WHERE ticket_id = $1 AND article_id = $2`, [ticket.id, req.params.articleId.toLowerCase()]);
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'link delete'); }
});

// Suggestions: Trove KB full-text search over the ticket title, minus
// already-linked articles. Handlers only (the panel is theirs). Empty
// on any Trove KB error so the ticket page never blocks on it.
router.get('/tickets/:id/suggestions', async (req, res) => {
  try {
    const { ticket, handler } = await loadTicket(req.session.user, Number(req.params.id));
    if (!handler) return res.json([]);
    const s = await troveKb.getSettings();
    if (!s.enabled || !s.suggestions_enabled) return res.json([]);
    const limit = Math.max(1, Math.min(10, Number(req.query.limit) || 5));
    const { decryptRows } = require('../services/fields');
    await decryptRows('tickets', [ticket]);
    const title = String(ticket.title || '').trim();
    if (!title) return res.json([]);
    const linked = await pool.query(`SELECT article_id FROM ticket_trove_kb_links WHERE ticket_id = $1`, [ticket.id]);
    const exclude = new Set(linked.rows.map((r) => r.article_id));
    const proj = await pool.query(`SELECT trove_kb_collection_id FROM projects WHERE id = $1`, [ticket.project_id]);
    let hits = [];
    try {
      hits = await troveKb.search({
        q: title, limit: limit + exclude.size, handler: true, orFallback: true,
        preferCollectionId: proj.rows[0]?.trove_kb_collection_id || null,
      });
    } catch (err) {
      console.warn('troveKb suggestions:', err.message);
      return res.json([]);
    }
    res.json(scrubStaffUrl(req.session.user, hits.filter((h) => !exclude.has(h.article_id)).slice(0, limit)));
  } catch (err) { fail(res, err, 'suggestions'); }
});

// POST /api/trove-kb/tickets/:id/resolution-draft { article_ids?: uuid[], ai?: bool }
// Builds a resolution write-up from Trove KB articles: an extractive digest
// always, plus an AI summary when asked for and available to this user.
router.post('/tickets/:id/resolution-draft', async (req, res) => {
  try {
    const { ticket, handler } = await loadTicket(req.session.user, Number(req.params.id));
    if (!handler) return res.status(403).json({ error: 'Only project handlers can draft a resolution' });
    const full = await pool.query(`SELECT id, project_id, title, title_enc, description, description_enc FROM tickets WHERE id = $1`, [ticket.id]);
    const { decryptRows } = require('../services/fields');
    await decryptRows('tickets', full.rows);
    const ids = Array.isArray(req.body?.article_ids) ? req.body.article_ids.filter((v) => UUID_RE.test(String(v))) : [];
    const out = await troveKbResolution.draft({
      userId: req.session.user.id,
      ticket: full.rows[0],
      articleIds: ids,
      wantAi: req.body?.ai === true,
    });
    res.json(out);
  } catch (err) { fail(res, err, 'resolution-draft'); }
});

// ─── Knowledge briefs (scope a response before rewriting it) ────────────

async function loadFullTicket(user, ticketId) {
  const { ticket, handler } = await loadTicket(user, ticketId);
  if (!handler) throw { status: 403, error: 'Only project handlers can use knowledge briefs' };
  const full = await pool.query(
    `SELECT t.id, t.project_id, t.title, t.title_enc, t.description, t.description_enc,
            sub.display_name AS submitted_by_name
       FROM tickets t LEFT JOIN users sub ON sub.id = t.submitted_by WHERE t.id = $1`,
    [ticket.id]
  );
  const { decryptRows } = require('../services/fields');
  await decryptRows('tickets', full.rows);
  return full.rows[0];
}

// POST /api/trove-kb/tickets/:id/assist/brief { draft } — no AI. Gathers the
// trusted inputs and matching articles for the tech to review.
router.post('/tickets/:id/assist/brief', async (req, res) => {
  try {
    const ticket = await loadFullTicket(req.session.user, Number(req.params.id));
    res.json(await troveKbAssist.buildBrief({ ticket, draft: String(req.body?.draft || '') }));
  } catch (err) { fail(res, err, 'assist brief'); }
});

// POST /api/trove-kb/tickets/:id/assist/compose { brief, ai } — saves the
// brief for audit and returns { reply_md, resolution_md, ai }.
router.post('/tickets/:id/assist/compose', async (req, res) => {
  try {
    const ticket = await loadFullTicket(req.session.user, Number(req.params.id));
    const out = await troveKbAssist.compose({
      userId: req.session.user.id,
      ticket,
      rawBrief: req.body?.brief,
      wantAi: req.body?.ai === true,
    });
    res.json(out);
  } catch (err) { fail(res, err, 'assist compose'); }
});

// GET /api/trove-kb/tickets/:id/assist/briefs — audit list.
router.get('/tickets/:id/assist/briefs', async (req, res) => {
  try {
    const ticket = await loadFullTicket(req.session.user, Number(req.params.id));
    res.json(await troveKbAssist.listBriefs(ticket.id));
  } catch (err) { fail(res, err, 'assist briefs'); }
});

router.get('/tickets/:id/assist/briefs/:briefId', async (req, res) => {
  try {
    const ticket = await loadFullTicket(req.session.user, Number(req.params.id));
    const b = await troveKbAssist.getBrief(ticket.id, Number(req.params.briefId));
    if (!b) return res.status(404).json({ error: 'Brief not found' });
    res.json(b);
  } catch (err) { fail(res, err, 'assist brief get'); }
});

// ─── Runbooks from Trove KB ────────────────────────────────────────────────
//
// A runbook is a Trove KB article with kind='runbook' and `steps`. Per-ticket
// progress lives here in ticket_runbook_runs (trove_kb_article_id, step_states
// keyed by Trove KB step id). Nothing about progress goes to Trove KB.

// GET /api/trove-kb/runbooks?project_id= — runbooks the caller may use, the
// project's collection first.
router.get('/runbooks', async (req, res) => {
  try {
    const s = await troveKb.getSettings();
    if (!s.enabled) return res.json([]);
    const handler = isGlobalHandler(req.session.user);
    const projectId = Number(req.query.project_id) || null;
    let home = null;
    if (projectId) {
      const p = await pool.query(`SELECT trove_kb_collection_id FROM projects WHERE id = $1`, [projectId]);
      home = p.rows[0]?.trove_kb_collection_id || null;
    }
    const vis = troveKb.visibleCollections(s, handler);
    let ids = vis.ids === null ? (await troveKb.listCollections()).map((c) => c.id) : vis.ids;
    if (home && ids.includes(home)) ids = [home, ...ids.filter((id) => id !== home)];
    const lists = await Promise.allSettled(ids.map((cid) => troveKb.listArticles({ collectionId: cid, kind: 'runbook', max: 200 })));
    const rows = [];
    for (const l of lists) if (l.status === 'fulfilled') rows.push(...l.value.map((a) => ({ ...a, home: a.collection_id === home })));
    res.json(scrubStaffUrl(req.session.user, rows));
  } catch (err) { fail(res, err, 'runbooks'); }
});

router.get('/tickets/:id/runbook-runs', async (req, res) => {
  try {
    const { ticket, handler } = await loadTicket(req.session.user, Number(req.params.id));
    if (!handler) return res.json([]);
    const r = await pool.query(
      `SELECT rr.id, rr.ticket_id, rr.trove_kb_article_id, rr.trove_kb_title, rr.step_states, rr.started_at, rr.completed_at,
              u.display_name AS started_by_name
         FROM ticket_runbook_runs rr LEFT JOIN users u ON u.id = rr.started_by
        WHERE rr.ticket_id = $1 AND rr.trove_kb_article_id IS NOT NULL
        ORDER BY rr.started_at ASC`,
      [ticket.id]
    );
    // Steps come live from Trove KB; a run whose runbook is gone still shows its snapshot.
    const rows = await Promise.all(r.rows.map(async (run) => {
      try {
        const a = await troveKb.getArticle(run.trove_kb_article_id, { handler: true });
        return { ...run, title: a.title, steps: a.steps, category: a.category, collection_name: a.collection_name, kind: a.kind, staff_url: a.staff_url, public_url: a.public_url };
      } catch {
        return { ...run, title: run.trove_kb_title || 'Runbook (unavailable)', steps: [], unavailable: true };
      }
    }));
    res.json(scrubStaffUrl(req.session.user, rows));
  } catch (err) { fail(res, err, 'runbook runs list'); }
});

router.post('/tickets/:id/runbook-runs', async (req, res) => {
  try {
    const articleId = String(req.body?.article_id || '').toLowerCase();
    if (!UUID_RE.test(articleId)) return res.status(400).json({ error: 'article_id (uuid) required' });
    const { ticket, handler } = await loadTicket(req.session.user, Number(req.params.id));
    if (!handler) return res.status(403).json({ error: 'Only project handlers can start a runbook' });
    const a = await troveKb.getArticle(articleId, { handler: true });
    if (a.kind !== 'runbook') return res.status(400).json({ error: 'That article is not a runbook' });
    const r = await pool.query(
      `INSERT INTO ticket_runbook_runs (ticket_id, trove_kb_article_id, trove_kb_title, started_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (ticket_id, trove_kb_article_id) WHERE trove_kb_article_id IS NOT NULL DO UPDATE
         SET started_by = COALESCE(ticket_runbook_runs.started_by, EXCLUDED.started_by), trove_kb_title = EXCLUDED.trove_kb_title
       RETURNING id, ticket_id, trove_kb_article_id, trove_kb_title, step_states, started_at, completed_at`,
      [ticket.id, a.article_id, a.title, req.session.user.id]
    );
    res.status(201).json({ ...r.rows[0], title: a.title, steps: a.steps });
  } catch (err) { fail(res, err, 'runbook run start'); }
});

router.patch('/tickets/:id/runbook-runs/:articleId', async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.articleId)) return res.status(400).json({ error: 'bad article id' });
    const { ticket, handler } = await loadTicket(req.session.user, Number(req.params.id));
    if (!handler) return res.status(403).json({ error: 'Only project handlers can update runbook progress' });
    const body = req.body || {};
    const sets = []; const values = []; let p = 1;
    if (body.step_states && typeof body.step_states === 'object' && !Array.isArray(body.step_states)) {
      // jsonb merge so two handlers ticking different boxes don't clobber each other.
      sets.push(`step_states = COALESCE(step_states, '{}'::jsonb) || $${p++}::jsonb`);
      values.push(JSON.stringify(body.step_states));
    }
    if (typeof body.completed === 'boolean') sets.push(`completed_at = ${body.completed ? 'NOW()' : 'NULL'}`);
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    values.push(ticket.id, req.params.articleId.toLowerCase());
    const r = await pool.query(
      `UPDATE ticket_runbook_runs SET ${sets.join(', ')} WHERE ticket_id = $${p++} AND trove_kb_article_id = $${p}
       RETURNING id, ticket_id, trove_kb_article_id, step_states, started_at, completed_at`,
      values
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Runbook run not found — start it first' });
    res.json(r.rows[0]);
  } catch (err) { fail(res, err, 'runbook run patch'); }
});

router.delete('/tickets/:id/runbook-runs/:articleId', async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.articleId)) return res.status(400).json({ error: 'bad article id' });
    const { ticket, handler } = await loadTicket(req.session.user, Number(req.params.id));
    if (!handler) return res.status(403).json({ error: 'Only project handlers can reset a runbook' });
    await pool.query(`DELETE FROM ticket_runbook_runs WHERE ticket_id = $1 AND trove_kb_article_id = $2`, [ticket.id, req.params.articleId.toLowerCase()]);
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'runbook run delete'); }
});

// ─── Promote a ticket to a Trove KB article ────────────────────────────────
// POST /api/trove-kb/tickets/:id/promote — writes a draft article (Symptom /
// Resolution) into the project's collection, internal-only, and links it.
// Needs the key to hold the write scope + a write grant on that collection.
router.post('/tickets/:id/promote', async (req, res) => {
  try {
    const user = req.session.user;
    if (!['Admin', 'Manager'].includes(user.role)) return res.status(403).json({ error: 'Forbidden' });
    const { ticket } = await loadTicket(user, Number(req.params.id));
    const full = await pool.query(
      `SELECT t.id, t.project_id, t.internal_ref, t.title, t.title_enc, t.description, t.description_enc,
              t.resolution_summary, t.resolution_summary_enc, p.name AS project_name, p.trove_kb_collection_id
         FROM tickets t JOIN projects p ON p.id = t.project_id WHERE t.id = $1`,
      [ticket.id]
    );
    const { decryptRows } = require('../services/fields');
    await decryptRows('tickets', full.rows);
    const t = full.rows[0];
    const s = await troveKb.getSettings();
    const collectionId = t.trove_kb_collection_id || s.internal_collection_ids[0] || null;
    if (!collectionId) return res.status(400).json({ error: 'No Trove KB collection mapped for this project (Admin → AI Assist → Project contexts)' });
    const title = (t.title || `Untitled (${t.internal_ref})`).slice(0, 200);
    const body = [
      `# ${title}`, '',
      '## Symptom', '', t.description || `Originally reported on ticket ${t.internal_ref}.`, '',
      '## Resolution', '', t.resolution_summary || '_Record the resolution here._', '',
      `_Promoted from ticket ${t.internal_ref}._`,
    ].join('\n');
    const article = await troveKb.upsertArticle({
      collectionId,
      externalId: `resolvd:ticket:${t.id}`,
      title, body,
      category: t.project_name,
      subcategory: 'Drafts',
      kind: 'article',
      internalOnly: true,
    });
    if (article?.article_id) {
      await pool.query(
        `INSERT INTO ticket_trove_kb_links (ticket_id, article_id, title, collection_id, collection_name, kind, created_by)
         VALUES ($1, $2, $3, $4, $5, 'system', $6) ON CONFLICT DO NOTHING`,
        [t.id, article.article_id, article.title, collectionId, s.collection_names[collectionId] || null, user.id]
      );
    }
    res.status(201).json(scrubStaffUrl(user, article));
  } catch (err) { fail(res, err, 'promote'); }
});

module.exports = router;

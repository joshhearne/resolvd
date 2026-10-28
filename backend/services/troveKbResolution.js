// Resolution drafts from Trove KB knowledge.
//
// Two tiers, both from the same inputs (the ticket + a few articles):
//   1. Extractive digest — no AI, always available. Each article's title,
//      link, and the passage Trove KB's search matched for the ticket title
//      (or the opening of the article when nothing matched). Runbook
//      steps are included when Trove KB returns them (`steps` is part of the
//      runbook feature Trove KB is growing; absent today, handled when present).
//   2. AI summary — only when the caller may use AI Assist (org key or
//      their own). Synthesizes the ticket and the articles into a short
//      resolution write-up. Logged in ai_rewrite_logs like a rewrite.

const { pool } = require('../db/pool');
const troveKb = require('./troveKb');
const aiSettings = require('./aiSettings');
const aiRewrite = require('./aiRewrite');
const { getAdapter } = require('./aiProviders');

const MAX_ARTICLES = 5;
const EXCERPT_CHARS = 700;
const AI_ARTICLE_CHARS = 6000; // per article, body fed to the model
const SURFACE = 'kb_resolution_summary';

function httpError(status, message) { const e = new Error(message); e.httpStatus = status; return e; }

function firstParagraphs(md, max) {
  const text = String(md || '')
    .replace(/^#\s.*$/m, '')           // drop the H1 (title repeats it)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf('. '));
  return (at > max * 0.5 ? cut.slice(0, at + 1) : cut).trim() + ' …';
}

function quote(text) {
  return String(text || '').trim().split('\n').map((l) => `> ${l}`).join('\n');
}

// Whether this user can run an AI summary right now, and why not.
async function aiAvailability(userId) {
  try {
    const orgSettings = await aiSettings.getSettings({ withKey: true });
    const userCfg = await aiRewrite.loadUserAssistConfig(userId);
    if (!userCfg) return { available: false, reason: 'user_not_found' };
    if (!userCfg.enabled) return { available: false, reason: 'user_disabled' };
    const eff = aiSettings.resolveEffectiveConfig({ orgSettings, userCfg });
    if (!eff.allowed) return { available: false, reason: eff.reason };
    const adapter = getAdapter(eff.provider);
    if (adapter.needsApiKey !== false && !eff.api_key) return { available: false, reason: 'no_api_key' };
    return { available: true, eff, adapter, projectContextEnabled: orgSettings.project_context_enabled, userCfg };
  } catch (err) {
    console.warn('troveKbResolution aiAvailability:', err.message);
    return { available: false, reason: 'error' };
  }
}

const REASON_NOTE = {
  kms_unavailable: 'AI summaries are off: the server has no RESOLVD_MASTER_KEY, so no AI key can be stored.',
  org_disabled: 'AI Assist is disabled by an administrator. The write-up below is extracted from the articles, not summarized.',
  org_locked_unconfigured: 'AI Assist is locked to the organization key, but none is configured. Ask an administrator.',
  byok_disabled: 'AI summaries need an organization AI key. Ask an administrator to add one under Admin → AI Assist.',
  unconfigured: 'AI summaries need an AI API token: an organization key (Admin → AI Assist) or your own under Account → Preferences.',
  no_api_key: 'AI summaries need an AI API token: an organization key (Admin → AI Assist) or your own under Account → Preferences.',
  user_disabled: 'AI Assist is turned off in your preferences. The write-up below is extracted from the articles, not summarized.',
  user_not_found: 'AI summary unavailable.',
  error: 'AI summary unavailable right now. The write-up below is extracted from the articles.',
};

// Pick articles: explicit ids, else the ticket's Trove KB links, else the
// best suggestions (project collection first). Returns full articles.
async function pickArticles({ ticket, articleIds, projectCollectionId }) {
  let ids = (articleIds || []).map((s) => String(s).toLowerCase()).filter(Boolean);
  if (!ids.length) {
    const linked = await pool.query(`SELECT article_id FROM ticket_trove_kb_links WHERE ticket_id = $1 ORDER BY created_at`, [ticket.id]);
    ids = linked.rows.map((r) => r.article_id);
  }
  let viaSearch = [];
  if (!ids.length) {
    viaSearch = await troveKb.search({ q: ticket.title, limit: 3, handler: true, preferCollectionId: projectCollectionId, orFallback: true });
    ids = viaSearch.map((h) => h.article_id);
  }
  ids = [...new Set(ids)].slice(0, MAX_ARTICLES);
  const settled = await Promise.allSettled(ids.map((id) => troveKb.getArticle(id, { handler: true })));
  const articles = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  return { articles, hits: viaSearch };
}

// The passage Trove KB matched for this ticket in each article, when any.
async function matchedPassages({ ticket, articles, hits }) {
  const byId = new Map(hits.map((h) => [h.article_id, h]));
  const missing = articles.filter((a) => !byId.has(a.article_id));
  // One search per collection that still needs a passage.
  const collections = [...new Set(missing.map((a) => a.collection_id).filter(Boolean))];
  await Promise.allSettled(collections.map(async (cid) => {
    const r = await troveKb.search({ q: ticket.title, limit: 20, handler: true, collectionId: cid, orFallback: true });
    for (const h of r) if (!byId.has(h.article_id)) byId.set(h.article_id, h);
  }));
  return byId;
}

function buildDigest({ articles, passages }) {
  if (!articles.length) return '';
  const lines = ['**Related knowledge**', ''];
  for (const a of articles) {
    // Public site when the article is there, else the in-app reader. Never a
    // link into Trove KB itself: that is for Trove KB admins only.
    const url = a.public_url || `/kb/article/${a.article_id}`;
    const where = [a.collection_name, a.category].filter(Boolean).join(' · ');
    lines.push(`- ${url ? `[${a.title}](${url})` : `**${a.title}**`}${where ? ` — ${where}` : ''}`);
    const hit = passages.get(a.article_id);
    if (Array.isArray(a.steps) && a.steps.length) {
      lines.push('');
      a.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s.text}`));
    } else if (hit?.snippet) {
      lines.push('');
      if (hit.heading) lines.push(`  _${hit.heading}_`);
      lines.push(quote(hit.snippet).replace(/^/gm, '  '));
    } else {
      const excerpt = firstParagraphs(a.body, EXCERPT_CHARS);
      if (excerpt) { lines.push(''); lines.push(quote(excerpt).replace(/^/gm, '  ')); }
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

function aiPrompt({ ticket, articles, projectContext }) {
  const system = [
    'You write resolution summaries for IT helpdesk tickets, for the technician who will record the fix.',
    'Use ONLY the knowledge base articles provided. Do not invent steps, settings, or commands that are not in them.',
    'If the articles do not actually cover the ticket, say so in one sentence and stop.',
    'Output Markdown: a two-to-four sentence summary of what to do, then a short numbered list of the concrete steps, each step naming the article it came from in parentheses.',
    'Never include credentials, even if an article contains them. Be concise and plain.',
    projectContext ? `\nProject context from the administrator:\n${projectContext}` : '',
  ].filter(Boolean).join('\n');

  const parts = [
    `Ticket title: ${ticket.title || '(none)'}`,
    ticket.description ? `Ticket description:\n${String(ticket.description).slice(0, 4000)}` : '',
    '',
    'Knowledge base articles:',
  ];
  articles.forEach((a, i) => {
    parts.push(`\n--- Article ${i + 1}: ${a.title}${a.category ? ` (${a.category})` : ''} ---`);
    if (Array.isArray(a.steps) && a.steps.length) {
      parts.push(a.steps.map((s, j) => `${j + 1}. ${s.text}${s.note ? `\n   ${s.note}` : ''}`).join('\n'));
    } else {
      parts.push(String(a.body || '').slice(0, AI_ARTICLE_CHARS));
    }
  });
  return { system, user: parts.join('\n') };
}

async function aiSummary({ userId, ticket, articles, projectId, avail }) {
  const projectContext = await aiRewrite.resolveProjectContext({
    projectId,
    userPrefs: avail.userCfg,
    branding: { ai_project_context_enabled: avail.projectContextEnabled },
  });
  const { system, user } = aiPrompt({ ticket, articles, projectContext });
  const result = await avail.adapter.complete({
    endpoint: avail.eff.endpoint || avail.adapter.defaultEndpoint,
    apiKey: avail.eff.api_key,
    model: avail.eff.model,
    system,
    user,
  });
  try {
    await pool.query(
      `INSERT INTO ai_rewrite_logs
         (user_id, provider, model, surface, project_id, input_tokens, output_tokens,
          tone, verbosity, eli5, project_context_used, config_source, applied_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'neutral', 'functional', FALSE, $8, $9, NOW())`,
      [userId, avail.eff.provider, avail.eff.model, SURFACE, projectId || null,
       result.usage?.input_tokens ?? null, result.usage?.output_tokens ?? null,
       !!projectContext, avail.eff.source]
    );
  } catch (err) {
    console.error('troveKbResolution log insert failed:', err.message);
  }
  return {
    summary_md: String(result.text || '').trim(),
    provider: avail.eff.provider,
    model: avail.eff.model,
    config_source: avail.eff.source,
    usage: result.usage || null,
  };
}

// Main entry. `ticket` must carry decrypted title/description and project_id.
async function draft({ userId, ticket, articleIds, wantAi }) {
  const settings = await troveKb.getSettings();
  if (!settings.enabled) throw httpError(503, 'Trove KB is not configured');

  const proj = await pool.query(`SELECT trove_kb_collection_id FROM projects WHERE id = $1`, [ticket.project_id]);
  const projectCollectionId = proj.rows[0]?.trove_kb_collection_id || null;

  const { articles, hits } = await pickArticles({ ticket, articleIds, projectCollectionId });
  if (!articles.length) {
    return { digest_md: '', articles: [], ai: { available: false, reason: 'no_articles', note: 'No Trove KB articles are linked to this ticket and nothing matched its title.' } };
  }
  const passages = await matchedPassages({ ticket, articles, hits });
  const digest_md = buildDigest({ articles, passages });

  const shaped = articles.map((a) => ({
    article_id: a.article_id, title: a.title, collection_id: a.collection_id, collection_name: a.collection_name,
    category: a.category, scope: a.scope, staff_url: a.staff_url, public_url: a.public_url,
  }));

  const avail = await aiAvailability(userId);
  let ai;
  if (!avail.available) {
    ai = { available: false, reason: avail.reason, note: REASON_NOTE[avail.reason] || REASON_NOTE.error };
  } else if (!wantAi) {
    ai = { available: true, requested: false };
  } else {
    try {
      ai = { available: true, requested: true, ...(await aiSummary({ userId, ticket, articles, projectId: ticket.project_id, avail })) };
    } catch (err) {
      ai = { available: true, requested: true, failed: true, note: err.friendly || err.message || 'AI summary failed. The extracted write-up is below.' };
    }
  }
  return { digest_md, articles: shaped, ai };
}

module.exports = { draft, aiAvailability, REASON_NOTE, buildDigest, matchedPassages, firstParagraphs, quote };

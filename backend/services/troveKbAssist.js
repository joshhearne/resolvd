// Knowledge briefs: scope a tech's response with what is actually known
// before anything rewrites it.
//
// A brief is assembled WITHOUT AI from four trusted inputs:
//   reported    what the user said (ticket title, description, their comments)
//   team        what handlers have already said on the ticket
//   draft       the tech's response as written
//   corrections what the tech adds that the user left out ("only after the
//               lid is closed") — the tribal knowledge that fixes the scope
// plus the project context an admin wrote and the Trove KB articles that match.
// The tech reviews it in a form, includes/excludes articles, writes
// corrections, then composes:
//   extractive  (default, no AI) reply = the draft, plus public article links;
//               resolution = reported + corrections + draft + article digest.
//   ai          the whole curated brief goes to the configured provider with
//               the rule that reported/draft/corrections are TRUE and the
//               articles are the only source of procedure.
// Every brief is stored (ticket_assist_briefs) so inputs can be audited and
// corrections carried into the next brief on the same ticket.

const { pool } = require('../db/pool');
const troveKb = require('./troveKb');
const resolution = require('./troveKbResolution');
const aiRewrite = require('./aiRewrite');
const { isProjectHandler } = require('./ticketHelpers');

const SURFACE = 'comment_assisted';
const MAX_ARTICLES = 6;
const INCLUDED_BY_DEFAULT = 4;

function httpError(status, message) { const e = new Error(message); e.httpStatus = status; return e; }

function trimTo(text, max) {
  const t = String(text || '').trim();
  return t.length > max ? `${t.slice(0, max)} …` : t;
}

// Words worth searching from a free-text draft: longer tokens, no stop words.
const STOP = new Set('the a an and or of to in on for with is are was were be been it this that these those from by at as into about after before when then than so if not no yes you your they their we our i me my he she his her them us can could would should will just also very please thanks thank hi hello user users issue problem ticket help'.split(' '));
function keyTerms(text, max = 8) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9][^a-z0-9]*/)) {
    const w = raw.trim();
    if (w.length < 4 || STOP.has(w) || seen.has(w)) continue;
    seen.add(w); out.push(w);
    if (out.length >= max) break;
  }
  return out.join(' ');
}

// Comments that carry no knowledge about the problem never reach a brief:
// the admin-managed noise rules (SLA notices, moves, auto-replies, named
// accounts) in services/troveKbNoise.js decide.
const noise = require('./troveKbNoise');

async function ticketComments(ticket) {
  const r = await pool.query(
    `SELECT c.id, c.user_id, c.body, c.body_enc, c.is_internal, c.is_system, c.is_muted, c.created_at,
            c.vendor_contact_id, u.display_name AS user_name, u.role AS user_role
       FROM comments c LEFT JOIN users u ON u.id = c.user_id
      WHERE c.ticket_id = $1 AND c.is_system = FALSE AND COALESCE(c.is_muted, FALSE) = FALSE
      ORDER BY c.created_at ASC`,
    [ticket.id]
  );
  const { decryptRows } = require('./fields');
  await decryptRows('comments', r.rows);
  const handlerCache = new Map();
  const reported = [];
  const team = [];
  for (const c of r.rows) {
    if (await noise.isNoise({ body: c.body, user_id: c.user_id })) continue;
    let handler = false;
    if (c.user_id) {
      if (!handlerCache.has(c.user_id)) {
        handlerCache.set(c.user_id, await isProjectHandler(pool, { userId: c.user_id, role: c.user_role, projectId: ticket.project_id }));
      }
      handler = handlerCache.get(c.user_id);
    }
    const entry = {
      comment_id: c.id,
      who: c.vendor_contact_id ? 'vendor' : handler ? 'team' : 'user',
      name: c.user_name || (c.vendor_contact_id ? 'Vendor' : 'User'),
      at: c.created_at,
      text: trimTo(c.body, 2000),
    };
    (entry.who === 'team' ? team : reported).push(entry);
  }
  return { reported, team };
}

async function projectInfo(projectId) {
  const r = await pool.query(
    `SELECT id, name, trove_kb_collection_id, ai_context_md, COALESCE(ai_context_enabled, TRUE) AS ai_context_enabled FROM projects WHERE id = $1`,
    [projectId]
  );
  return r.rows[0] || {};
}

async function lastCorrections(ticketId) {
  const r = await pool.query(
    `SELECT inputs->>'corrections' AS corrections FROM ticket_assist_briefs
      WHERE ticket_id = $1 AND COALESCE(inputs->>'corrections', '') <> ''
      ORDER BY created_at DESC LIMIT 1`,
    [ticketId]
  );
  return r.rows[0]?.corrections || '';
}

// Candidate articles: the ticket title (project collection first), then
// the draft's key terms. Passages come from the title search.
async function findArticles({ ticket, draft, collectionId }) {
  const byId = new Map();
  const add = (hits) => { for (const h of hits) if (!byId.has(h.article_id)) byId.set(h.article_id, h); };
  try { add(await troveKb.search({ q: ticket.title, limit: MAX_ARTICLES, handler: true, preferCollectionId: collectionId, orFallback: true })); } catch (err) { console.warn('assist title search:', err.message); }
  const terms = keyTerms(draft);
  if (terms) {
    try { add(await troveKb.search({ q: terms.split(' ').join(' OR '), limit: MAX_ARTICLES, handler: true, preferCollectionId: collectionId })); } catch (err) { console.warn('assist draft search:', err.message); }
  }
  return [...byId.values()].slice(0, MAX_ARTICLES).map((h, i) => ({
    article_id: h.article_id,
    title: h.title,
    kind: h.kind || 'article',
    collection_id: h.collection_id,
    collection_name: h.collection_name,
    category: h.category,
    scope: h.scope,
    staff_url: h.staff_url,
    public_url: h.public_url,
    heading: h.heading,
    snippet: h.snippet,
    included: i < INCLUDED_BY_DEFAULT,
  }));
}

// ─── Brief ──────────────────────────────────────────────────────────────

async function buildBrief({ ticket, draft }) {
  const settings = await troveKb.getSettings();
  const project = await projectInfo(ticket.project_id);
  const { reported, team } = await ticketComments(ticket);
  const articles = settings.enabled ? await findArticles({ ticket, draft, collectionId: project.trove_kb_collection_id }) : [];
  return {
    ticket: { id: ticket.id, title: ticket.title, description: trimTo(ticket.description, 4000), submitted_by_name: ticket.submitted_by_name || null },
    reported: { trusted: true, items: reported },
    team: { items: team },
    draft: { text: String(draft || ''), trusted: true },
    corrections: await lastCorrections(ticket.id),
    project: {
      id: project.id, name: project.name,
      collection_id: project.trove_kb_collection_id || null,
      collection_name: project.trove_kb_collection_id ? settings.collection_names[project.trove_kb_collection_id] || null : null,
      context_md: project.ai_context_enabled ? (project.ai_context_md || '') : '',
      context_enabled: project.ai_context_enabled !== false,
    },
    articles,
    troveKb_enabled: settings.enabled,
  };
}

// Validate and trim what the client sends back as the edited brief.
function normalizeBrief(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const list = (v) => (Array.isArray(v) ? v : []);
  return {
    reported: {
      trusted: b.reported?.trusted !== false,
      items: list(b.reported?.items).map((i) => ({ who: ['user', 'vendor'].includes(i.who) ? i.who : 'user', name: trimTo(i.name, 120), text: trimTo(i.text, 2000), comment_id: i.comment_id ?? null })).filter((i) => i.text),
      summary: trimTo(b.reported?.summary, 2000),
    },
    team: { items: list(b.team?.items).map((i) => ({ name: trimTo(i.name, 120), text: trimTo(i.text, 2000), comment_id: i.comment_id ?? null })).filter((i) => i.text) },
    draft: { text: trimTo(b.draft?.text, 8000), trusted: true },
    corrections: trimTo(b.corrections, 4000),
    project: {
      id: b.project?.id ?? null,
      collection_id: b.project?.collection_id || null,
      context_md: b.project?.context_enabled === false ? '' : trimTo(b.project?.context_md, 8000),
      context_enabled: b.project?.context_enabled !== false,
    },
    articles: list(b.articles).slice(0, 12).map((a) => ({
      article_id: String(a.article_id || '').toLowerCase(),
      title: trimTo(a.title, 300),
      kind: a.kind === 'runbook' ? 'runbook' : 'article',
      collection_id: a.collection_id || null,
      collection_name: trimTo(a.collection_name, 200) || null,
      category: trimTo(a.category, 200) || null,
      scope: a.scope === 'public' ? 'public' : 'internal',
      staff_url: a.staff_url || null,
      public_url: a.public_url || null,
      heading: trimTo(a.heading, 300) || null,
      snippet: trimTo(a.snippet, 1500) || null,
      included: a.included !== false,
      note: trimTo(a.note, 1000),
    })).filter((a) => /^[0-9a-f-]{36}$/.test(a.article_id)),
  };
}

// ─── Compose ────────────────────────────────────────────────────────────

function reportedText(brief) {
  const parts = [];
  if (brief.ticket?.title) parts.push(`Title: ${brief.ticket.title}`);
  if (brief.ticket?.description) parts.push(`Description: ${brief.ticket.description}`);
  if (brief.reported.summary) parts.push(`Tech's summary of the report: ${brief.reported.summary}`);
  for (const i of brief.reported.items) parts.push(`${i.name} (${i.who}): ${i.text}`);
  return parts.join('\n');
}

function extractiveCompose({ brief, fullArticles }) {
  const included = brief.articles.filter((a) => a.included);
  const publicOnes = included.filter((a) => a.public_url);
  let reply = brief.draft.text.trim();
  if (publicOnes.length) {
    reply += `\n\nHelpful documentation:\n${publicOnes.map((a) => `- [${a.title}](${a.public_url})`).join('\n')}`;
  }
  const res = [];
  const reported = brief.reported.summary || brief.ticket?.title || '';
  if (reported) res.push(`**Reported:** ${reported}`);
  if (brief.corrections) res.push(`**Clarifications:** ${brief.corrections}`);
  if (brief.draft.text.trim()) res.push(`**Response given:**\n\n${brief.draft.text.trim()}`);
  const passages = new Map(included.map((a) => [a.article_id, { snippet: a.snippet, heading: a.heading }]));
  const digest = resolution.buildDigest({ articles: fullArticles.filter((a) => passages.has(a.article_id)), passages });
  if (digest) res.push(digest);
  return { reply_md: reply, resolution_md: res.join('\n\n') };
}

function aiPrompt({ brief, fullArticles }) {
  const included = brief.articles.filter((a) => a.included);
  const system = [
    'You help an IT helpdesk technician finish a reply to a user and record how the ticket was resolved.',
    'Facts you must treat as TRUE and never contradict: what the user reported, what the technician wrote, and the technician\'s corrections. Corrections override the user\'s wording wherever they conflict (users often leave out the real trigger).',
    'Procedure and settings come ONLY from the knowledge base articles provided. Do not invent steps, menu paths, commands, or values that are not in them. If an article does not cover the point, keep the technician\'s wording.',
    'Articles marked INTERNAL must never be named, linked, or quoted in the Reply; they may inform the Resolution. Articles marked PUBLIC may be linked in the Reply by their URL.',
    'Never include credentials, even if present in an article.',
    'Write for the recipient: the Reply addresses the user in plain language; the Resolution is a concise internal record for the next technician.',
    'Output exactly two Markdown sections and nothing else:',
    '## Reply',
    '(the technician\'s response, improved with the articles; keep their meaning and commitments; 1–3 short paragraphs or a short list)',
    '## Resolution',
    '(what was wrong including the real trigger from the corrections, what fixed or will fix it, and the numbered steps, each naming its article in parentheses)',
    brief.project.context_md ? `\nProject context from the administrator (how our systems fit together):\n${brief.project.context_md}` : '',
  ].filter(Boolean).join('\n');

  const user = [
    `WHAT THE USER REPORTED (true):\n${reportedText(brief) || '(nothing beyond the title)'}`,
    brief.team.items.length ? `\nWHAT THE TEAM HAS SAID SO FAR:\n${brief.team.items.map((i) => `${i.name}: ${i.text}`).join('\n')}` : '',
    `\nTECHNICIAN'S DRAFT RESPONSE (true):\n${brief.draft.text || '(empty)'}`,
    `\nTECHNICIAN'S CORRECTIONS / WHAT THE USER LEFT OUT (true, overriding):\n${brief.corrections || '(none)'}`,
    '\nKNOWLEDGE BASE ARTICLES:',
    ...included.map((a, i) => {
      const full = fullArticles.find((f) => f.article_id === a.article_id);
      const body = full?.steps?.length
        ? full.steps.map((s, j) => `${j + 1}. ${s.text}${s.note ? `\n   ${s.note}` : ''}`).join('\n')
        : String(full?.body || a.snippet || '').slice(0, 6000);
      return `\n--- Article ${i + 1} [${a.scope.toUpperCase()}]: ${a.title}${a.category ? ` (${a.category})` : ''}${a.public_url ? `\nURL: ${a.public_url}` : ''}${a.note ? `\nTechnician's note on this article: ${a.note}` : ''} ---\n${body}`;
    }),
    included.length ? '' : '(no articles included)',
  ].filter(Boolean).join('\n');
  return { system, user };
}

function splitSections(text) {
  const t = String(text || '');
  const reply = t.match(/##\s*Reply\s*\n([\s\S]*?)(?=\n##\s*Resolution|$)/i);
  const res = t.match(/##\s*Resolution\s*\n([\s\S]*)$/i);
  return {
    reply_md: (reply ? reply[1] : t).trim(),
    resolution_md: (res ? res[1] : '').trim(),
  };
}

async function compose({ userId, ticket, rawBrief, wantAi }) {
  const brief = normalizeBrief(rawBrief);
  brief.ticket = { id: ticket.id, title: ticket.title, description: trimTo(ticket.description, 4000) };
  if (!brief.draft.text && !wantAi) throw httpError(400, 'Write a response first');

  const includedIds = brief.articles.filter((a) => a.included).map((a) => a.article_id);
  const settled = await Promise.allSettled(includedIds.map((id) => troveKb.getArticle(id, { handler: true })));
  const fullArticles = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);

  let mode = 'extractive';
  let output;
  let aiInfo;
  let logId = null;

  if (wantAi) {
    const avail = await resolution.aiAvailability(userId);
    if (!avail.available) {
      aiInfo = { available: false, reason: avail.reason, note: resolution.REASON_NOTE[avail.reason] || resolution.REASON_NOTE.error };
      output = extractiveCompose({ brief, fullArticles });
    } else {
      const { system, user } = aiPrompt({ brief, fullArticles });
      try {
        const result = await avail.adapter.complete({
          endpoint: avail.eff.endpoint || avail.adapter.defaultEndpoint,
          apiKey: avail.eff.api_key,
          model: avail.eff.model,
          system, user,
        });
        mode = 'ai';
        output = splitSections(result.text);
        if (!output.resolution_md) output.resolution_md = extractiveCompose({ brief, fullArticles }).resolution_md;
        try {
          const log = await pool.query(
            `INSERT INTO ai_rewrite_logs
               (user_id, provider, model, surface, project_id, input_tokens, output_tokens,
                tone, verbosity, eli5, project_context_used, config_source)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'neutral', 'functional', FALSE, $8, $9) RETURNING id`,
            [userId, avail.eff.provider, avail.eff.model, SURFACE, ticket.project_id,
             result.usage?.input_tokens ?? null, result.usage?.output_tokens ?? null,
             !!brief.project.context_md, avail.eff.source]
          );
          logId = log.rows[0].id;
        } catch (err) { console.error('assist log insert failed:', err.message); }
        aiInfo = { available: true, used: true, provider: avail.eff.provider, model: avail.eff.model, config_source: avail.eff.source, usage: result.usage || null, log_id: logId };
      } catch (err) {
        output = extractiveCompose({ brief, fullArticles });
        aiInfo = { available: true, used: false, failed: true, note: err.friendly || err.message || 'AI rewrite failed; the extractive result is shown instead.' };
      }
    }
  } else {
    output = extractiveCompose({ brief, fullArticles });
    const avail = await resolution.aiAvailability(userId);
    aiInfo = avail.available ? { available: true, used: false } : { available: false, reason: avail.reason, note: resolution.REASON_NOTE[avail.reason] || null };
  }

  const saved = await pool.query(
    `INSERT INTO ticket_assist_briefs (ticket_id, user_id, inputs, output, mode, ai_log_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
    [ticket.id, userId, JSON.stringify(brief), JSON.stringify({ ...output, ai: aiInfo }), mode, logId]
  );

  return { brief_id: saved.rows[0].id, mode, ...output, ai: aiInfo, articles_used: fullArticles.map((a) => ({ article_id: a.article_id, title: a.title, scope: a.scope })) };
}

async function listBriefs(ticketId) {
  const r = await pool.query(
    `SELECT b.id, b.mode, b.created_at, u.display_name AS user_name,
            b.inputs->>'corrections' AS corrections,
            jsonb_array_length(COALESCE(b.inputs->'articles', '[]'::jsonb)) AS article_count,
            b.output
       FROM ticket_assist_briefs b LEFT JOIN users u ON u.id = b.user_id
      WHERE b.ticket_id = $1 ORDER BY b.created_at DESC LIMIT 50`,
    [ticketId]
  );
  return r.rows;
}

async function getBrief(ticketId, id) {
  const r = await pool.query(`SELECT * FROM ticket_assist_briefs WHERE ticket_id = $1 AND id = $2`, [ticketId, id]);
  return r.rows[0] || null;
}

module.exports = { buildBrief, compose, listBriefs, getBrief, keyTerms, splitSections };

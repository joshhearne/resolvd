// AI link targeting: turn plain KB links in a reply ("see the printer
// manual") into links that land on the exact page / phrase, optionally
// splitting the reply into steps with one targeted link per step.
//
// Safety model — the AI never writes URLs:
//   * The reply is shown to the model with each selected KB link replaced by
//     a document token `kb:D1`. The model answers with tokens of the form
//     [text](kb:D1 page=110 search="Scan to Network").
//   * The server resolves every token itself: the page must exist, the phrase
//     must occur in the document text (on that page when pages are known —
//     a wrong page is corrected to where the phrase actually is), and the
//     URL is rebuilt from the original base with kbLinks.buildKbUrl.
//   * Any KB URL in the output that wasn't in the input is unlinked.
// Document text comes from the real document: PDFs are fetched and split per
// page (pdf.js); HTML articles use their body text.

const { pool } = require('../db/pool');
const kbLinks = require('./kbLinks');
const pdfText = require('./pdfText');
const kbPdf = require('./kbPdf');
const troveKb = require('./troveKb');
const resolution = require('./troveKbResolution');

const SURFACE = 'kb_link_targeting';
const MAX_DOCS = 6;
const MAX_PDF_BYTES = 80 * 1024 * 1024;
const PAGE_EXCERPT = 1800;
const DOC_BUDGET = 26000;
const BODY_BUDGET = 9000;

function httpError(status, message) { const e = new Error(message); e.httpStatus = status; return e; }

const STOP = new Set('the a an and or of to in on for with is are was were be been it this that these those from by at as into about after before when then than so if not no yes you your they their we our i me my he she his her them us can could would should will just also very please thanks thank hi hello click open select see page'.split(' '));
function terms(text) {
  const out = new Set();
  for (const w of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length >= 3 && !STOP.has(w)) out.add(w);
  }
  return out;
}

async function fetchPdf(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(25000), redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const len = Number(r.headers.get('content-length') || 0);
  if (len > MAX_PDF_BYTES) throw new Error('PDF too large');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_PDF_BYTES) throw new Error('PDF too large');
  if (!kbPdf.isPdf(buf)) throw new Error('not a PDF');
  return buf;
}

// Load the text of one linked document. Returns
// { title, pages: [{page,text}] | null, body: string, note? }.
async function loadDocument(link, { user, loadLocalArticle }) {
  if (link.source === 'trove') {
    const art = await troveKb.getArticle(link.id, { handler: true });
    if (link.pdf) {
      const pdfUrl = art.pdf_url || link.base;
      try {
        const pages = await pdfText.cachedPages(`trove:${art.article_id}:${art.date_modified || ''}`, () => fetchPdf(pdfUrl));
        return { title: art.title, pages, body: '' };
      } catch (err) {
        // Fall back to Trove's extracted body: phrases still verifiable,
        // page numbers not.
        return { title: art.title, pages: null, body: art.body, note: `Couldn't read the PDF (${err.message}); page numbers were not verified.` };
      }
    }
    const body = art.steps?.length ? art.steps.map((s) => `${s.text}${s.note ? ` ${s.note}` : ''}`).join('\n') : art.body;
    return { title: art.title, pages: null, body };
  }
  // local
  let art;
  if (link.pdf) art = await loadLocalArticle(user, link.id);
  else {
    const r = await pool.query('SELECT id FROM kb_articles WHERE project_id = $1 AND slug = $2', [link.projectId, link.slug]);
    art = r.rows[0] ? await loadLocalArticle(user, r.rows[0].id) : null;
  }
  if (!art) throw httpError(404, 'Linked article not found');
  if (link.pdf) {
    const pages = await pdfText.cachedPages(`local:${art.id}:${art.pdf_uploaded_at ? new Date(art.pdf_uploaded_at).getTime() : ''}`, async () => {
      const buf = await kbPdf.readPdf(art);
      if (!buf) throw httpError(404, 'PDF missing');
      return buf;
    });
    return { title: art.title, pages, body: '' };
  }
  return { title: art.title, pages: null, body: art.content_text || '' };
}

// Pick the pages worth showing the model: those sharing the most terms with
// the reply line around the link + the tech's note.
function excerpt(doc, focus) {
  if (!doc.pages) return String(doc.body || '').slice(0, BODY_BUDGET);
  const want = terms(focus);
  const scored = doc.pages.map((p) => {
    const have = terms(p.text);
    let score = 0;
    for (const w of want) if (have.has(w)) score++;
    return { ...p, score };
  });
  const chosen = doc.pages.length <= 12
    ? scored
    : scored.filter((p) => p.text).sort((a, b) => b.score - a.score || a.page - b.page).slice(0, 14).sort((a, b) => a.page - b.page);
  let used = 0;
  const parts = [];
  for (const p of chosen) {
    const t = p.text.slice(0, PAGE_EXCERPT);
    if (used + t.length > DOC_BUDGET) break;
    used += t.length;
    parts.push(`[Page ${p.page}]\n${t}`);
  }
  return parts.join('\n\n');
}

const TOKEN_RE = /\]\(kb:(D\d+)((?:\s+(?:page=\d+|search="[^"]*"))*)\s*\)/g;

// Resolve one token against its document. Returns { url, page, search, notes[] }.
function resolveToken(doc, attrs) {
  const notes = [];
  let page = kbLinks.cleanPage((attrs.match(/page=(\d+)/) || [])[1]);
  let search = kbLinks.cleanTerm((attrs.match(/search="([^"]*)"/) || [])[1]);
  if (doc.link.pdf && doc.pages) {
    if (page && !doc.pages.some((p) => p.page === page)) { notes.push(`page ${page} doesn't exist`); page = null; }
    if (search) {
      const onPage = page && kbLinks.phraseInText(search, doc.pages.find((p) => p.page === page)?.text);
      if (!onPage) {
        const found = doc.pages.find((p) => kbLinks.phraseInText(search, p.text));
        if (found) { if (page) notes.push(`moved to page ${found.page}, where the phrase is`); page = found.page; }
        else { notes.push(`phrase "${search}" isn't in the document`); search = null; }
      }
    }
  } else {
    if (page && !doc.link.pdf) page = null;
    if (page && doc.link.pdf) { notes.push('page not verified (PDF text unavailable), dropped'); page = null; }
    if (search && !kbLinks.phraseInText(search, doc.body)) { notes.push(`phrase "${search}" isn't in the document`); search = null; }
  }
  return { url: kbLinks.buildKbUrl(doc.link.base, { pdf: doc.link.pdf, page, search }), page, search, notes };
}

function buildPrompt({ text, docs, stepped, instructions }) {
  const system = [
    'You refine documentation links in an IT helpdesk reply so each link lands on the exact place in the document that supports the sentence or step it belongs to.',
    'Links to refine appear as markdown links whose target is a document token, e.g. [Printer manual](kb:D1). Write each refined link as:',
    '  [link text](kb:D1 page=110 search="Scan to Network")',
    'Rules:',
    '- page= is only for documents that show [Page N] markers; use the page where your phrase appears.',
    '- search= is a short phrase (2–8 words) copied EXACTLY from the document text, distinctive enough to find the right spot. No quotes inside it.',
    '- Use only the tokens given (D1, D2, …). Never write a URL. Never link a document that is not listed.',
    '- Keep the technician\'s wording, meaning and any other links exactly as written.',
    stepped
      ? '- When the reply describes a procedure, you may rewrite it as numbered steps (taken from the reply and the document text — never invent steps) and put a refined link at the end of each step it supports. A document may be linked several times with different page/search values.'
      : '- Do not restructure the reply; only refine the existing links in place.',
    '- Output only the rewritten reply in Markdown. No preamble, no explanation.',
  ].join('\n');
  const user = [
    instructions ? `TECHNICIAN'S INSTRUCTIONS:\n${instructions}\n` : '',
    `REPLY:\n${text}`,
    '\nDOCUMENTS:',
    ...docs.map((d) => [
      `\n--- ${d.token}: ${d.title} (${d.link.pdf ? (d.pages ? `PDF, ${d.pages.length} pages` : 'PDF, page numbers unavailable') : 'web article'}) ---`,
      d.notes.length ? `Technician's context for this link: ${d.notes.join(' | ')}` : '',
      d.excerpt || '(no text available)',
    ].filter(Boolean).join('\n')),
  ].filter(Boolean).join('\n');
  return { system, user };
}

// targets: optional [{ url, note }] — which links to refine (default: all KB
// links) and per-link context ("this one is about duplex").
async function targetLinks({ user, ticket, text, targets, stepped = true, instructions = '', loadLocalArticle }) {
  const src = String(text || '');
  if (!src.trim()) throw httpError(400, 'Nothing to refine');
  if (src.length > 20000) throw httpError(400, 'Reply is too long to refine');
  let found = kbLinks.findKbLinks(src);
  if (Array.isArray(targets) && targets.length) {
    const want = new Set(targets.map((t) => kbLinks.stripFragment(String(t.url || ''))));
    found = found.filter((f) => want.has(f.base));
  }
  if (!found.length) throw httpError(400, 'No KB links to refine in this text');

  const avail = await resolution.aiAvailability(user.id);
  if (!avail.available) {
    throw httpError(400, resolution.REASON_NOTE[avail.reason] || 'AI is not available for your account');
  }

  // One document per distinct base URL.
  const docs = [];
  const byBase = new Map();
  for (const f of found) {
    if (byBase.has(f.base)) continue;
    if (docs.length >= MAX_DOCS) break;
    const token = `D${docs.length + 1}`;
    const d = { token, link: f, notes: [], title: f.title || '' };
    byBase.set(f.base, d);
    docs.push(d);
  }
  for (const t of Array.isArray(targets) ? targets : []) {
    const d = byBase.get(kbLinks.stripFragment(String(t.url || '')));
    const note = String(t.note || '').trim().slice(0, 500);
    if (d && note) d.notes.push(note);
  }
  const warnings = [];
  await Promise.all(docs.map(async (d) => {
    try {
      const doc = await loadDocument(d.link, { user, loadLocalArticle });
      Object.assign(d, { title: doc.title || d.title, pages: doc.pages, body: doc.body });
      if (doc.note) warnings.push(`${d.title}: ${doc.note}`);
    } catch (err) {
      d.failed = true;
      warnings.push(`${d.title || d.link.base}: couldn't load the document (${err.message}); left unchanged.`);
    }
  }));
  const usable = docs.filter((d) => !d.failed);
  if (!usable.length) throw httpError(400, warnings.join(' ') || 'Could not load any linked document');
  for (const d of usable) {
    const lines = found.filter((f) => f.base === d.link.base).map((f) => f.line).join(' ');
    d.excerpt = excerpt(d, `${lines} ${d.notes.join(' ')}`);
  }

  // Swap selected links for tokens (only usable documents).
  let masked = '';
  let last = 0;
  for (const f of found) {
    const d = byBase.get(f.base);
    if (!d || d.failed) continue;
    masked += src.slice(last, f.index);
    masked += `[${f.title || d.title}](kb:${d.token})`;
    last = f.index + f.match.length;
  }
  masked += src.slice(last);

  const { system, user: userMsg } = buildPrompt({ text: masked, docs: usable, stepped, instructions: String(instructions || '').slice(0, 1000) });
  const result = await avail.adapter.complete({
    endpoint: avail.eff.endpoint || avail.adapter.defaultEndpoint,
    apiKey: avail.eff.api_key,
    model: avail.eff.model,
    system,
    user: userMsg,
  });
  let out = String(result.text || '').trim().replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i, '$1').trim();
  if (!out) throw httpError(502, 'The AI returned nothing');

  // Resolve tokens → verified URLs.
  const tokenDocs = new Map(usable.map((d) => [d.token, d]));
  const changes = [];
  out = out.replace(TOKEN_RE, (m, token, attrs) => {
    const d = tokenDocs.get(token);
    if (!d) return `](${''})`; // unknown token: becomes an empty link, cleaned below
    const r = resolveToken(d, attrs || '');
    changes.push({ document: d.title, page: r.page, search: r.search, url: r.url, notes: r.notes });
    return `](${r.url})`;
  });
  // Any kb: token the regex didn't match (malformed) → plain base URL.
  out = out.replace(/\]\(kb:(D\d+)[^)]*\)/g, (m, token) => {
    const d = tokenDocs.get(token);
    return d ? `](${d.link.base})` : ']()';
  });
  out = out.replace(/\[([^\]]*)\]\(\)/g, '$1');
  // Unlink KB URLs that weren't in the input.
  const allowed = new Set(found.map((f) => f.base));
  for (const f of kbLinks.findKbLinks(out)) {
    if (!allowed.has(f.base)) {
      out = out.replace(f.match, f.title || '');
      warnings.push(`Removed a link the AI added that wasn't in your reply (${f.base}).`);
    }
  }

  let logId = null;
  try {
    const log = await pool.query(
      `INSERT INTO ai_rewrite_logs
         (user_id, provider, model, surface, project_id, input_tokens, output_tokens,
          tone, verbosity, eli5, project_context_used, config_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'neutral', 'functional', FALSE, FALSE, $8) RETURNING id`,
      [user.id, avail.eff.provider, avail.eff.model, SURFACE, ticket?.project_id || null,
       result.usage?.input_tokens ?? null, result.usage?.output_tokens ?? null, avail.eff.source]
    );
    logId = log.rows[0].id;
  } catch (err) { console.error('kb link targeting log insert failed:', err.message); }

  return {
    text: out,
    changes,
    warnings,
    documents: usable.map((d) => ({ token: d.token, title: d.title, pdf: d.link.pdf, pages: d.pages ? d.pages.length : null })),
    ai: { provider: avail.eff.provider, model: avail.eff.model, usage: result.usage || null, log_id: logId },
  };
}

module.exports = { targetLinks, resolveToken, excerpt, buildPrompt, TOKEN_RE };

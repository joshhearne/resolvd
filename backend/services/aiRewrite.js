// BYO-AI text rewrite service.
//
// Resolves the caller's AI Assist preferences (provider, endpoint, model,
// API key), builds a system + user prompt from tone/verbosity/eli5
// selections, dispatches to the right provider adapter, and returns the
// rewritten text plus usage stats.
//
// Privacy: the only thing leaving the server is the user's chosen text
// payload + tone/verbosity instructions, sent to the user's chosen
// provider with their own API key. Resolvd never sees provider replies
// past this function — they go straight back to the requesting client.

const { pool } = require('../db/pool');
const { getAdapter, listProviders } = require('./aiProviders');
const { encrypt, decrypt } = require('./crypto');
const { getBranding } = require('./branding');

const TONES = ['neutral', 'formal', 'friendly', 'polite', 'apologetic', 'terse', 'funny'];
const VERBOSITIES = ['short', 'functional', 'verbose'];
const SURFACES = ['comment_internal', 'comment_vendor', 'ticket_description', 'ticket_subject'];
const ELIGIBLE_ROLES = new Set(['Admin', 'Manager']); // ELI5 mode gated to these

function isToneAllowed(t) { return TONES.includes(t); }
function isVerbosityAllowed(v) { return VERBOSITIES.includes(v); }
function isSurfaceAllowed(s) { return SURFACES.includes(s); }

function defaultsForUser(prefsBlob) {
  const a = (prefsBlob && prefsBlob.ai_assist) || {};
  return {
    provider: a.provider || null,
    endpoint: a.endpoint || null,
    model: a.model || null,
    enabled: !!a.enabled,
    default_tone: a.default_tone || 'neutral',
    default_verbosity: a.default_verbosity || 'functional',
  };
}

// Returns the org-level enabled flag (admin can disable BYO-AI for the
// whole org regardless of user prefs).
async function isOrgEnabled() {
  try {
    const b = await getBranding();
    return b?.ai_assist_enabled !== false;
  } catch {
    return true;
  }
}

// Build the user's effective configuration including the decrypted API
// key. Does NOT return the api_key in normal API responses — only when
// invoking the adapter.
async function loadUserAssistConfig(userId) {
  const r = await pool.query(
    `SELECT id, role, preferences, ai_api_key_enc FROM users WHERE id = $1 AND status = 'active'`,
    [userId]
  );
  const row = r.rows[0];
  if (!row) return null;
  const cfg = defaultsForUser(row.preferences);
  let apiKey = null;
  if (row.ai_api_key_enc) {
    try {
      apiKey = (await decrypt(row.ai_api_key_enc, 'users.ai_api_key')).toString('utf8');
    } catch (e) {
      console.error(`ai api key decrypt failed for user ${userId}:`, e.message);
    }
  }
  return { ...cfg, role: row.role, api_key: apiKey };
}

async function saveUserApiKey(userId, plaintext) {
  if (plaintext == null || plaintext === '') {
    await pool.query(`UPDATE users SET ai_api_key_enc = NULL WHERE id = $1`, [userId]);
    return;
  }
  const enc = await encrypt(Buffer.from(String(plaintext), 'utf8'), 'users.ai_api_key');
  await pool.query(`UPDATE users SET ai_api_key_enc = $1 WHERE id = $2`, [enc, userId]);
}

function buildPrompt({ surface, tone, verbosity, eli5, text }) {
  const verbosityHint = {
    short: 'Be concise — minimum words to convey the point. Not slangy or elliptical, just trim.',
    functional: 'Be clear and complete without unnecessary elaboration.',
    verbose: 'Walk through the reasoning. Add context that helps a reader who lacks the full background.',
  }[verbosity] || 'Be clear and complete.';

  const toneHint = {
    neutral: 'Use a neutral, professional tone.',
    formal: 'Use a formal, business-appropriate tone.',
    friendly: 'Use a warm, friendly tone — approachable, still professional.',
    polite: 'Use an extra-polite tone — soften requests, acknowledge effort.',
    apologetic: 'Open with a brief acknowledgement / apology before the substance.',
    terse: 'Be terse and direct — fragments OK, drop pleasantries.',
    funny: 'Add a light, playful tone — one tasteful joke or witty turn allowed, do not overdo it.',
  }[tone] || 'Use a neutral, professional tone.';

  const surfaceHint = {
    comment_internal: 'This is an internal comment on a support ticket, written between coworkers / techs.',
    comment_vendor:   'This is an outbound message to an external vendor or service desk. Stay professional. The vendor is technical — do not over-simplify.',
    ticket_description: 'This is the description field on a support ticket. State the problem clearly so an assignee can act on it without follow-up questions.',
    ticket_subject: 'This is a subject line for an outbound email. ONE LINE ONLY — no markdown, no period at the end. Aim for under 80 characters.',
  }[surface] || '';

  const eli5Hint = eli5
    ? 'IMPORTANT: rewrite for a non-technical reader. Replace jargon with plain language, expand acronyms on first use, and explain technical concepts in everyday terms without being condescending.'
    : '';

  // If the input contains template placeholders like {ticket.ref} or
  // {vendor.name}, those are server-rendered substitutions — do NOT
  // expand or alter them. Detect any and add a preservation directive.
  const hasTemplateTags = /\{[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*\}/i.test(text || '');
  const templateHint = hasTemplateTags
    ? 'IMPORTANT: this text contains placeholder tokens like {ticket.ref}, {vendor.name}, {site.url}. Preserve every {…} token character-for-character — do not rename, expand, replace with examples, or remove them. Reword only the surrounding prose.'
    : '';

  const system = [
    'You are a writing assistant that rewrites the user\'s draft text in-place.',
    'Output ONLY the rewritten text — no preamble, no quotes around the result, no commentary, no explanation of what you changed.',
    'Preserve the user\'s factual content exactly. Do not invent new facts, names, or details.',
    'Preserve markdown formatting where present (headings, lists, code fences, links).',
    surfaceHint,
    toneHint,
    verbosityHint,
    templateHint,
    eli5Hint,
  ].filter(Boolean).join(' ');

  return { system, user: text };
}

async function rewrite({ userId, surface, tone, verbosity, eli5, text }) {
  if (!isSurfaceAllowed(surface)) throw httpError(400, `invalid surface: ${surface}`);
  if (!isToneAllowed(tone)) throw httpError(400, `invalid tone: ${tone}`);
  if (!isVerbosityAllowed(verbosity)) throw httpError(400, `invalid verbosity: ${verbosity}`);
  if (typeof text !== 'string' || !text.trim()) throw httpError(400, 'text required');
  if (text.length > 8000) throw httpError(400, 'text too long (8000 char limit)');

  if (!(await isOrgEnabled())) throw httpError(403, 'AI Assist disabled by org admin');

  const cfg = await loadUserAssistConfig(userId);
  if (!cfg) throw httpError(404, 'user not found');
  if (!cfg.enabled) throw httpError(403, 'AI Assist not enabled for your account');
  if (!cfg.provider || !cfg.model) throw httpError(400, 'AI provider not configured');

  if (eli5 && !ELIGIBLE_ROLES.has(cfg.role)) {
    throw httpError(403, 'ELI5 mode is restricted to Admin / Manager roles');
  }

  const adapter = getAdapter(cfg.provider);
  if (adapter.needsApiKey !== false && !cfg.api_key) {
    throw httpError(400, 'API key not set for this provider');
  }
  const { system, user } = buildPrompt({ surface, tone, verbosity, eli5, text });
  const result = await adapter.complete({
    endpoint: cfg.endpoint || adapter.defaultEndpoint,
    apiKey: cfg.api_key,
    model: cfg.model,
    system,
    user,
  });
  return {
    rewritten: result.text,
    usage: result.usage || null,
    provider: cfg.provider,
    model: cfg.model,
  };
}

// Light-weight test call used by the "Test connection" button in prefs.
// Returns { ok: true, model, latency_ms } or throws httpError.
async function testConnection({ userId }) {
  const cfg = await loadUserAssistConfig(userId);
  if (!cfg) throw httpError(404, 'user not found');
  if (!cfg.provider || !cfg.model) throw httpError(400, 'AI provider not configured');
  const adapter = getAdapter(cfg.provider);
  if (adapter.needsApiKey !== false && !cfg.api_key) {
    throw httpError(400, 'API key not set');
  }
  const start = Date.now();
  await adapter.complete({
    endpoint: cfg.endpoint || adapter.defaultEndpoint,
    apiKey: cfg.api_key,
    model: cfg.model,
    system: 'Reply with the single word: OK',
    user: 'ping',
    timeoutMs: 15000,
  });
  return { ok: true, model: cfg.model, latency_ms: Date.now() - start };
}

function httpError(status, msg) {
  const e = new Error(msg);
  e.httpStatus = status;
  return e;
}

module.exports = {
  TONES, VERBOSITIES, SURFACES, ELIGIBLE_ROLES,
  rewrite,
  testConnection,
  saveUserApiKey,
  loadUserAssistConfig,
  listProviders,
  isOrgEnabled,
  defaultsForUser,
};

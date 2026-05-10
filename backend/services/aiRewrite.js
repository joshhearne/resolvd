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
    // Per-user opt-out for project AI context. Default ON since context
    // generally improves output; users on a tight token budget can flip
    // it off.
    use_project_context: a.use_project_context !== false,
    // When ON, AI usage on this user's comments + tickets becomes
    // visible to all internal users regardless of org-wide audience
    // (vendors still never see). Default OFF — explicit consent required.
    publish_usage: !!a.publish_usage,
  };
}

// Resolve project AI context — admin-authored markdown blob that gets
// prepended to the rewrite prompt so the model speaks the project's
// lingo (sites, integrations, glossary). Returns null when:
//   - org admin disabled the feature globally
//   - project hasn't authored any context (or set ai_context_enabled=false)
//   - user opted out via use_project_context=false
//   - no projectId provided (rewrite isn't ticket-scoped)
async function resolveProjectContext({ projectId, userPrefs, branding }) {
  if (!projectId) return null;
  if (branding && branding.ai_project_context_enabled === false) return null;
  if (userPrefs && userPrefs.use_project_context === false) return null;
  try {
    const r = await pool.query(
      `SELECT ai_context_md, ai_context_enabled FROM projects WHERE id = $1`,
      [projectId]
    );
    const row = r.rows[0];
    if (!row) return null;
    if (row.ai_context_enabled === false) return null;
    const md = (row.ai_context_md || '').trim();
    if (!md) return null;
    return md;
  } catch (err) {
    console.error(`resolveProjectContext failed for project ${projectId}:`, err.message);
    return null;
  }
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

function buildPrompt({ surface, tone, verbosity, eli5, text, projectContext }) {
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

  // Project context (admin-authored markdown). Wrap in a delimited block
  // so the model can distinguish it from instructions. Explicitly tell
  // the model to USE the names verbatim but NOT to invent claims based
  // on the context — it's a lexicon, not source material.
  const contextBlock = projectContext
    ? `Project context (use these names, sites, and definitions verbatim when they appear in the user's text; DO NOT invent claims based on this context — it is a glossary, not source material):\n<project_context>\n${projectContext}\n</project_context>`
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
    contextBlock,
  ].filter(Boolean).join('\n\n');

  return { system, user: text };
}

async function rewrite({ userId, surface, tone, verbosity, eli5, text, projectId }) {
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

  // Project context — adds tokens; gated by org + per-project + per-user toggles.
  const branding = await getBranding().catch(() => null);
  const projectContext = await resolveProjectContext({ projectId, userPrefs: cfg, branding });

  const { system, user } = buildPrompt({ surface, tone, verbosity, eli5, text, projectContext });
  const result = await adapter.complete({
    endpoint: cfg.endpoint || adapter.defaultEndpoint,
    apiKey: cfg.api_key,
    model: cfg.model,
    system,
    user,
  });
  // Log the rewrite — the modal's Apply button passes log_id back when
  // the user accepts. Stays unapplied (applied_at NULL) until then; the
  // consuming endpoint marks it applied + copies metadata onto the row.
  let logId = null;
  try {
    const logRow = await pool.query(
      `INSERT INTO ai_rewrite_logs
         (user_id, provider, model, surface, project_id,
          input_tokens, output_tokens, tone, verbosity, eli5,
          project_context_used)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        userId, cfg.provider, cfg.model, surface, projectId || null,
        result.usage?.input_tokens ?? null,
        result.usage?.output_tokens ?? null,
        tone, verbosity, !!eli5,
        !!projectContext,
      ]
    );
    logId = logRow.rows[0].id;
  } catch (err) {
    console.error('ai_rewrite_logs insert failed:', err.message);
  }

  return {
    log_id: logId,
    rewritten: result.text,
    usage: result.usage || null,
    provider: cfg.provider,
    model: cfg.model,
    project_context_used: !!projectContext,
  };
}

// One-shot consumer for an ai_rewrite_logs row. Validates the log
// belongs to userId and isn't already applied, marks it applied to
// (table, id), returns the metadata payload to copy onto the row.
// Snapshot the author's publish_usage pref at apply time so future
// pref changes don't retroactively widen visibility.
async function applyRewriteLog({ logId, userId, table, rowId, client = null }) {
  if (!logId) return null;
  const db = client || pool;
  const r = await db.query(
    `UPDATE ai_rewrite_logs
        SET applied_at = NOW(),
            applied_to_table = $3,
            applied_to_id = $4
      WHERE id = $1
        AND user_id = $2
        AND applied_at IS NULL
      RETURNING provider, model, input_tokens, output_tokens, tone, verbosity, eli5, project_context_used`,
    [logId, userId, table, rowId]
  );
  if (!r.rows[0]) return null;

  const u = await db.query(`SELECT preferences FROM users WHERE id = $1`, [userId]);
  const publish = !!(u.rows[0]?.preferences?.ai_assist?.publish_usage);
  return { ...r.rows[0], publish_consent: publish };
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
  applyRewriteLog,
  listProviders,
  isOrgEnabled,
  defaultsForUser,
};

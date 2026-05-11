// Admin-only AI Settings endpoints. The user-side rewrite endpoints
// (/api/ai-assist/*) stay where they are — this module manages the
// org-level configuration that those calls fall back to.
//
// Layered admin UI maps to three slices of this:
//   GET    /api/ai-settings              — full singleton row (no key plaintext)
//   PATCH  /api/ai-settings              — update non-secret fields
//   POST   /api/ai-settings/api-key      — set/clear org API key
//   POST   /api/ai-settings/test         — fire a tiny ping at the org config
//   GET    /api/ai-settings/projects     — list projects + ai_context_md status (master-detail support)
//   PATCH  /api/ai-settings/projects/:id — edit a project's AI context inline

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const aiSettings = require('../services/aiSettings');
const aiRewrite = require('../services/aiRewrite');
const kms = require('../services/kms');
const { listProviders } = require('../services/aiProviders');

const router = express.Router();

// All routes Admin-only. Manager could read for visibility but mutating
// the org config is squarely admin territory.
router.use(requireAuth, requireRole('Admin'));

router.get('/', async (req, res) => {
  try {
    const cur = await aiSettings.getSettings();
    res.json({
      enabled: cur.enabled,
      admin_enabled: cur.admin_enabled,
      org_provider: cur.org_provider,
      org_endpoint: cur.org_endpoint,
      org_model: cur.org_model,
      org_locked: cur.org_locked,
      allow_user_byok: cur.allow_user_byok,
      project_context_enabled: cur.project_context_enabled,
      disclosure_audience: cur.disclosure_audience,
      has_org_key: cur.has_org_key,
      kms_available: cur.kms_available,
      providers: listProviders(),
      tones: aiRewrite.TONES,
      verbosities: aiRewrite.VERBOSITIES,
    });
  } catch (err) {
    console.error('ai-settings get:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.patch('/', async (req, res) => {
  try {
    const cur = await aiSettings.patchSettings(req.body || {});
    res.json({
      enabled: cur.enabled,
      admin_enabled: cur.admin_enabled,
      org_provider: cur.org_provider,
      org_endpoint: cur.org_endpoint,
      org_model: cur.org_model,
      org_locked: cur.org_locked,
      allow_user_byok: cur.allow_user_byok,
      project_context_enabled: cur.project_context_enabled,
      disclosure_audience: cur.disclosure_audience,
      has_org_key: cur.has_org_key,
      kms_available: cur.kms_available,
    });
  } catch (err) {
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
    console.error('ai-settings patch:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/ai-settings/generate-master-key — One-shot generator. Returns
// a freshly-minted base64 RESOLVD_MASTER_KEY for the admin to paste into
// .env and restart the backend. Server NEVER persists this — the operator
// is responsible for storing it (and a backup) outside the database.
router.post('/generate-master-key', async (req, res) => {
  try {
    const key = kms.generateMasterKeyBase64();
    res.json({
      key,
      already_configured: kms.isAvailable(),
      env_var: 'RESOLVD_MASTER_KEY',
      instructions: [
        'Copy the key and add to your .env: RESOLVD_MASTER_KEY=<key>',
        'Back up the key in a password manager / KMS / sealed envelope — losing it after encryption is enabled permanently destroys access.',
        'Restart the backend (e.g. `docker compose up -d --force-recreate backend`).',
        'Return to this page; the banner clears once the key is detected.',
      ],
    });
  } catch (err) {
    console.error('ai-settings generate-master-key:', err);
    res.status(500).json({ error: 'Failed to generate key' });
  }
});

// GET /api/ai-settings/models?live=true — same shape as the user-side
// /api/ai/models endpoint, but uses the org config (provider, endpoint,
// API key) for the live fetch instead of the caller's personal config.
// Always returns curated list for the configured org provider.
router.get('/models', async (req, res) => {
  try {
    const cur = await aiSettings.getSettings({ withKey: true });
    if (!cur.org_provider) return res.status(400).json({ error: 'Org provider not configured' });
    const adapter = require('../services/aiProviders').getAdapter(cur.org_provider);
    const curated = (adapter.recommendedModels || []).map(m => ({ ...m, source: 'curated' }));
    let live = [];
    let liveError = null;
    if (String(req.query.live || '').toLowerCase() === 'true' && typeof adapter.listLiveModels === 'function') {
      const needsKey = adapter.needsApiKey !== false;
      if (needsKey && !cur._orgApiKey) {
        liveError = 'Org API key not set — save one before fetching live model list';
      } else {
        try {
          const models = await adapter.listLiveModels({
            endpoint: cur.org_endpoint || adapter.defaultEndpoint,
            apiKey: cur._orgApiKey,
          });
          live = models.map(m => ({ ...m, source: 'live' }));
        } catch (err) {
          liveError = err.friendly || err.message || 'Live fetch failed';
        }
      }
    }
    const seen = new Set(curated.map(m => m.id));
    const merged = [...curated];
    for (const m of live) if (!seen.has(m.id)) merged.push(m);
    res.json({ provider: cur.org_provider, models: merged, live_count: live.length, live_error: liveError });
  } catch (err) {
    if (err.name === 'ProviderError') {
      return res.status(err.httpStatus || 502).json({ error: err.friendly, error_kind: err.kind });
    }
    console.error('ai-settings models:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api-key', async (req, res) => {
  try {
    const v = req.body?.api_key;
    if (v != null && typeof v !== 'string') return res.status(400).json({ error: 'api_key must be string or null' });
    if (typeof v === 'string' && v.length > 4000) return res.status(400).json({ error: 'api_key too long' });
    await aiSettings.setOrgApiKey(v);
    res.json({ ok: true, has_org_key: !!(typeof v === 'string' && v.trim()) });
  } catch (err) {
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
    console.error('ai-settings api-key:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/test', async (req, res) => {
  try {
    const r = await aiRewrite.testConnection({ userId: req.session.user.id, mode: 'org' });
    res.json(r);
  } catch (err) {
    if (err.name === 'ProviderError') {
      return res.status(err.httpStatus || 502).json({
        error: err.friendly,
        error_kind: err.kind,
        provider: err.provider,
        provider_message: err.providerMessage,
      });
    }
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
    console.error('ai-settings test:', err);
    res.status(502).json({ error: err.message || 'connection failed' });
  }
});

// List projects + AI context status. Source for the master-detail
// project context picker in the admin AI page.
router.get('/projects', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, name, prefix, status,
             COALESCE(ai_context_enabled, TRUE) AS ai_context_enabled,
             (ai_context_md IS NOT NULL AND length(trim(ai_context_md)) > 0) AS has_context,
             COALESCE(length(ai_context_md), 0) AS context_length
        FROM projects
       WHERE status = 'active'
       ORDER BY name ASC
    `);
    res.json(r.rows);
  } catch (err) {
    console.error('ai-settings projects:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.get('/projects/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, prefix, ai_context_md, ai_context_enabled
         FROM projects WHERE id = $1`,
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Project not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('ai-settings project get:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.patch('/projects/:id', async (req, res) => {
  try {
    const { ai_context_md, ai_context_enabled } = req.body || {};
    const updates = {};
    if (ai_context_md !== undefined) {
      const md = (ai_context_md ?? '').toString();
      if (md.length > 8000) return res.status(400).json({ error: 'ai_context_md too long (8000 char limit)' });
      updates.ai_context_md = md.trim() || null;
    }
    if (ai_context_enabled !== undefined) {
      updates.ai_context_enabled = ai_context_enabled !== false && ai_context_enabled !== 'false';
    }
    if (Object.keys(updates).length === 0) {
      const r = await pool.query(
        `SELECT id, name, prefix, ai_context_md, ai_context_enabled FROM projects WHERE id = $1`,
        [req.params.id]
      );
      return res.json(r.rows[0] || {});
    }
    const cols = Object.keys(updates);
    const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    const r = await pool.query(
      `UPDATE projects SET ${sets}, updated_at = NOW() WHERE id = $${cols.length + 1}
        RETURNING id, name, prefix, ai_context_md, ai_context_enabled`,
      [...cols.map(c => updates[c]), req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Project not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('ai-settings project patch:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

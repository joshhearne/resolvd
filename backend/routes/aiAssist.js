// BYO-AI rewrite endpoints. All require auth. Admin org toggle is
// enforced inside aiRewrite.rewrite() — endpoints surface the 403 from
// there. The user's API key never returns from any GET — only a boolean
// hasKey flag — and is set via a dedicated POST that takes plaintext
// once and encrypts immediately.

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const aiRewrite = require('../services/aiRewrite');

const router = express.Router();

// GET /api/ai/providers — list adapters the server knows about. Useful
// for populating the provider dropdown in AccountPreferences. Public to
// any authenticated user (no secrets exposed).
router.get('/providers', requireAuth, async (req, res) => {
  res.json({
    providers: aiRewrite.listProviders(),
    tones: aiRewrite.TONES,
    verbosities: aiRewrite.VERBOSITIES,
    surfaces: aiRewrite.SURFACES,
    eligible_for_eli5: aiRewrite.ELIGIBLE_ROLES.has(req.session.user?.role),
  });
});

// GET /api/ai/config — returns the caller's effective AI Assist config
// (provider, endpoint, model, defaults, enabled), plus org-level enabled
// flag and a hasKey boolean. NEVER returns the api_key plaintext.
router.get('/config', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT preferences, ai_api_key_enc IS NOT NULL AS has_key
         FROM users WHERE id = $1`,
      [req.session.user.id]
    );
    const row = r.rows[0];
    const cfg = aiRewrite.defaultsForUser(row?.preferences);
    const orgEnabled = await aiRewrite.isOrgEnabled();
    res.json({
      ...cfg,
      has_key: !!row?.has_key,
      org_enabled: orgEnabled,
    });
  } catch (err) {
    console.error('ai config get:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/ai/config — partial update of the non-secret config bag.
// Stored under users.preferences.ai_assist as a JSONB sub-object.
router.patch('/config', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const sanitized = {};

    if (body.provider !== undefined) {
      if (body.provider === null || body.provider === '') {
        sanitized.provider = null;
      } else {
        // Validate against known providers
        try { aiRewrite.listProviders().find(p => p.id === body.provider) || (() => { throw new Error('x'); })(); }
        catch { return res.status(400).json({ error: 'unknown provider' }); }
        sanitized.provider = String(body.provider);
      }
    }
    if (body.endpoint !== undefined) {
      if (body.endpoint && typeof body.endpoint !== 'string') return res.status(400).json({ error: 'endpoint must be string' });
      sanitized.endpoint = body.endpoint ? String(body.endpoint).trim() : null;
    }
    if (body.model !== undefined) {
      if (body.model && typeof body.model !== 'string') return res.status(400).json({ error: 'model must be string' });
      sanitized.model = body.model ? String(body.model).trim() : null;
    }
    if (body.default_tone !== undefined) {
      if (!aiRewrite.TONES.includes(body.default_tone)) return res.status(400).json({ error: 'invalid default_tone' });
      sanitized.default_tone = body.default_tone;
    }
    if (body.default_verbosity !== undefined) {
      if (!aiRewrite.VERBOSITIES.includes(body.default_verbosity)) return res.status(400).json({ error: 'invalid default_verbosity' });
      sanitized.default_verbosity = body.default_verbosity;
    }
    if (body.enabled !== undefined) sanitized.enabled = !!body.enabled;

    // Merge into existing ai_assist sub-object then back into preferences.
    const current = await pool.query(`SELECT preferences FROM users WHERE id = $1`, [userId]);
    const prefs = current.rows[0]?.preferences || {};
    const existingAi = prefs.ai_assist || {};
    const newAi = { ...existingAi, ...sanitized };
    await pool.query(
      `UPDATE users SET preferences = preferences || $1::jsonb WHERE id = $2`,
      [JSON.stringify({ ai_assist: newAi }), userId]
    );
    res.json({ ok: true, ai_assist: newAi });
  } catch (err) {
    console.error('ai config patch:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/ai/api-key — set or clear the per-user API key. Body:
// { api_key: "sk-..." } to set, { api_key: null } or empty to clear.
router.post('/api-key', requireAuth, async (req, res) => {
  try {
    const v = req.body?.api_key;
    if (v != null && typeof v !== 'string') return res.status(400).json({ error: 'api_key must be string or null' });
    if (typeof v === 'string' && v.length > 4000) return res.status(400).json({ error: 'api_key too long' });
    await aiRewrite.saveUserApiKey(req.session.user.id, v);
    res.json({ ok: true, has_key: !!(typeof v === 'string' && v.trim()) });
  } catch (err) {
    console.error('ai api-key set:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/ai/test — issue a tiny call against the configured provider
// to confirm endpoint + key + model work. Returns latency + model echo,
// or a useful error message.
router.post('/test', requireAuth, async (req, res) => {
  try {
    const r = await aiRewrite.testConnection({ userId: req.session.user.id });
    res.json(r);
  } catch (err) {
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
    console.error('ai test:', err);
    res.status(502).json({ error: err.message || 'connection failed' });
  }
});

// POST /api/ai/rewrite — the main entry point. Body:
// { text, surface, tone, verbosity, eli5? }. Returns { rewritten, usage }.
router.post('/rewrite', requireAuth, async (req, res) => {
  try {
    const { text, surface, tone, verbosity, eli5 } = req.body || {};
    const r = await aiRewrite.rewrite({
      userId: req.session.user.id,
      surface, tone, verbosity,
      eli5: !!eli5,
      text,
    });
    res.json(r);
  } catch (err) {
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
    console.error('ai rewrite:', err);
    res.status(502).json({ error: err.message || 'rewrite failed' });
  }
});

module.exports = router;

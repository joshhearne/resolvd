// Admin-only Trove KB integration settings.
//   GET    /api/trove-kb-settings              — singleton (no key plaintext)
//   PATCH  /api/trove-kb-settings              — urls, toggles, collection mapping
//   POST   /api/trove-kb-settings/api-key      — set/clear the Trove KB API key
//   POST   /api/trove-kb-settings/test         — list collections through the key, record outcome
//   GET    /api/trove-kb-settings/collections  — live collection list (mapping UI)

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const troveKb = require('../services/troveKb');
const migration = require('../services/troveKbMigration');

const router = express.Router();
router.use(requireAuth, requireRole('Admin'));

function present(s) {
  return {
    enabled: s.enabled,
    admin_enabled: s.admin_enabled,
    base_url: s.base_url,
    public_url: s.public_url,
    internal_collection_ids: s.internal_collection_ids,
    public_collection_ids: s.public_collection_ids,
    collection_names: s.collection_names,
    suggestions_enabled: s.suggestions_enabled,
    public_strict: s.public_strict,
    local_kb_enabled: s.local_kb_enabled,
    auto_map_public: s.auto_map_public,
    known_collection_ids: s.known_collection_ids,
    collections_synced_at: s.collections_synced_at,
    last_ok_at: s.last_ok_at,
    last_error: s.last_error,
    has_api_key: s.has_api_key,
    has_webhook_secret: s.has_webhook_secret,
    last_webhook_at: s.last_webhook_at,
    last_webhook_event: s.last_webhook_event,
    snapshots_refreshed_at: s.snapshots_refreshed_at,
    webhook_url: `${(process.env.FRONTEND_URL || '').replace(/\/+$/, '')}/api/trove-kb/webhook`,
    kms_available: s.kms_available,
    updated_at: s.updated_at,
  };
}

function fail(res, err, label) {
  if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
  console.error(`troveKb-settings ${label}:`, err);
  return res.status(500).json({ error: 'Database error' });
}

router.get('/', async (req, res) => {
  try { res.json(present(await troveKb.getSettings())); }
  catch (err) { fail(res, err, 'get'); }
});

router.patch('/', async (req, res) => {
  try { res.json(present(await troveKb.patchSettings(req.body || {}))); }
  catch (err) { fail(res, err, 'patch'); }
});

router.post('/api-key', async (req, res) => {
  try {
    await troveKb.setApiKey(req.body?.api_key);
    const s = await troveKb.getSettings();
    res.json({ has_api_key: s.has_api_key, enabled: s.enabled });
  } catch (err) { fail(res, err, 'api-key'); }
});

// POST /api/trove-kb-settings/webhook-secret { secret } | { generate: true } | { secret: "" }
// A generated secret is returned exactly once so it can be pasted into
// Trove KB (Admin → Webhooks). Never readable again afterwards.
router.post('/webhook-secret', async (req, res) => {
  try {
    let secret = req.body?.secret;
    let generated = false;
    if (req.body?.generate === true) { secret = troveKb.generateWebhookSecret(); generated = true; }
    if (secret != null && typeof secret !== 'string') return res.status(400).json({ error: 'secret must be a string' });
    if (typeof secret === 'string' && secret.length > 500) return res.status(400).json({ error: 'secret too long' });
    await troveKb.setWebhookSecret(secret);
    const s = await troveKb.getSettings();
    res.json({ has_webhook_secret: s.has_webhook_secret, ...(generated ? { secret } : {}) });
  } catch (err) { fail(res, err, 'webhook-secret'); }
});

// POST /api/trove-kb-settings/refresh-snapshots — run the nightly refresh now.
router.post('/refresh-snapshots', async (req, res) => {
  try { res.json(await require('../services/troveKbSnapshotScheduler').refreshSnapshots()); }
  catch (err) { fail(res, err, 'refresh-snapshots'); }
});

// POST /api/trove-kb-settings/sync-collections — pick up new collections now.
router.post('/sync-collections', async (req, res) => {
  try { res.json(await troveKb.syncCollections()); }
  catch (err) { fail(res, err, 'sync-collections'); }
});

router.post('/test', async (req, res) => {
  try { res.json(await troveKb.testConnection()); }
  catch (err) { fail(res, err, 'test'); }
});

router.get('/collections', async (req, res) => {
  try { res.json(await troveKb.listCollections()); }
  catch (err) { fail(res, err, 'collections'); }
});

// Replace the local knowledge base with Trove KB. Plan is a dry run; apply
// moves ticket links and runbook runs, archives local articles, and turns
// the local KB off. Nothing is deleted.
router.get('/migration/plan', async (req, res) => {
  try { res.json(await migration.plan()); }
  catch (err) { fail(res, err, 'migration plan'); }
});
router.post('/migration/apply', async (req, res) => {
  try { res.json(await migration.apply({ userId: req.session.user.id })); }
  catch (err) { fail(res, err, 'migration apply'); }
});

module.exports = router;

// Inbound webhooks from Trove KB. Mounted BEFORE express.json and before
// session auth, with express.raw, because the signature covers the raw
// body byte for byte.
//
//   POST /api/trove-kb/webhook
//     X-Trove-Event:     kb.article.upserted | kb.article.archived
//     X-Trove-Delivery:  <id>
//     X-Trove-Signature: sha256=<hmac-sha256(secret, raw body) hex>
//     body: { event, occurred_at, data: { collection_id, article_id, external_id, kind } }
//
// Answers fast and says little: 204 on an accepted delivery, 401 on a bad
// or missing signature, 503 when no secret is configured. Never echoes
// the secret. The only effect is dropping cached reads for the article,
// so a replayed delivery is harmless.

const express = require('express');
const troveKb = require('../services/troveKb');

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const settings = await troveKb.getSettings({ withKey: true });
    if (!settings._webhookSecret) return res.status(503).json({ error: 'No webhook secret configured' });
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : '');
    if (!troveKb.verifyWebhookSignature(settings._webhookSecret, raw, req.get('X-Trove-Signature'))) {
      return res.status(401).json({ error: 'Bad signature' });
    }
    let payload = {};
    try { payload = JSON.parse(raw.toString('utf8') || '{}'); } catch { return res.status(400).json({ error: 'Body is not JSON' }); }
    const event = String(req.get('X-Trove-Event') || payload.event || '');
    const articleId = payload?.data?.article_id;
    if (['kb.article.upserted', 'kb.article.archived'].includes(event) && articleId) {
      troveKb.invalidateArticle(articleId);
    } else {
      // Unknown event or no article: still acknowledged, nothing to drop.
      troveKb.invalidateArticle('');
    }
    troveKb.recordWebhook(event).catch((err) => console.warn('troveKb webhook record:', err.message));
    res.status(204).end();
  } catch (err) {
    console.error('troveKb webhook:', err.message);
    res.status(500).json({ error: 'Webhook failed' });
  }
});

module.exports = router;

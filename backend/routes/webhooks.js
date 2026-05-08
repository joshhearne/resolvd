// Public webhook receiver. Mounted BEFORE auth middleware: each preset
// authenticates via the URL token (hashed and compared to
// external_alert_source.token_hash). HMAC signature verification is
// optional — TODO for v1.1.

const express = require('express');
const { pool } = require('../db/pool');
const { hashToken } = require('../auth/tokens');
const { getPreset } = require('../services/alertMappers');
const { ingestAlertEvent } = require('../services/alertIngest');

const router = express.Router();

router.post('/:preset/:token', async (req, res) => {
  const { preset: presetName, token } = req.params;
  const preset = getPreset(presetName);
  if (!preset) {
    return res.status(404).json({ error: `Unknown preset: ${presetName}` });
  }

  let source;
  try {
    const r = await pool.query(
      `SELECT * FROM external_alert_source
        WHERE token_hash = $1 AND preset = $2 AND enabled = TRUE`,
      [hashToken(token), presetName]
    );
    source = r.rows[0];
  } catch (err) {
    console.error('webhook source lookup error:', err);
    return res.status(500).json({ error: 'Database error' });
  }
  if (!source) return res.status(401).json({ error: 'Invalid token or source disabled' });
  if (!source.default_project_id) {
    return res.status(400).json({ error: 'Source has no default project configured' });
  }

  let event;
  try {
    event = preset.mapper(req.body);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const result = await ingestAlertEvent({
      source,
      preset,
      event,
      rawPayload: req.body,
    });
    res.status(202).json({ ok: true, ...result });
  } catch (err) {
    console.error('webhook process error:', err);
    res.status(500).json({ error: 'Processing error' });
  }
});

module.exports = router;

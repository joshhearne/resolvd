// Public webhook receiver. Mounted BEFORE auth middleware: every route
// authenticates via the URL token (hashed and compared to
// external_alert_source.token_hash). HMAC signature verification is
// optional — per-adapter hook lands in Phase 8 hardening.
//
// Two intake shapes:
//
//   POST /api/webhooks/:preset/:token     — legacy. Vendor known by URL
//                                           (zabbix, action1, ...). Mapper
//                                           comes from alertMappers.PRESETS.
//
//   POST /api/webhooks/in/:token          — generic. Vendor resolved from
//                                           the token's source row. Tries
//                                           the registered adapter's
//                                           mapAlertPayload first; falls
//                                           through to source.field_map
//                                           (tabular path -> field map)
//                                           for webhook-only vendors that
//                                           don't have a code-side adapter.
//
// Every hit is persisted to integration_inbound_events before mapping
// so the admin UI can debug failures and "reprocess" without needing
// the upstream tool to re-fire.

const express = require('express');
const { pool } = require('../db/pool');
const { hashToken } = require('../auth/tokens');
const { getPreset } = require('../services/alertMappers');
const { ingestAlertEvent } = require('../services/alertIngest');
const registry = require('../services/integrations/registry');
const { applyFieldMap } = require('../services/integrations/fieldMap');

const router = express.Router();

// Log every inbound webhook for debug + replay. status starts at
// 'pending'; webhook handler flips to 'processed' on success or 'error'
// with a message. Returns the row id so the handler can update later.
async function logInbound(integrationId, payload) {
  try {
    const r = await pool.query(
      `INSERT INTO integration_inbound_events (integration_id, payload, status)
       VALUES ($1, $2::jsonb, 'pending') RETURNING id`,
      [integrationId || null, JSON.stringify(payload ?? null)]
    );
    return r.rows[0]?.id || null;
  } catch (err) {
    console.error('webhook: failed to log inbound event:', err.message);
    return null;
  }
}

async function markProcessed(id, ticketId) {
  if (!id) return;
  await pool.query(
    `UPDATE integration_inbound_events
        SET status = 'processed', processed_at = NOW(), ticket_id = $2
      WHERE id = $1`,
    [id, ticketId || null]
  ).catch((err) => console.error('webhook: mark processed failed:', err.message));
}

async function markError(id, message) {
  if (!id) return;
  await pool.query(
    `UPDATE integration_inbound_events
        SET status = 'error', processed_at = NOW(), error_message = $2
      WHERE id = $1`,
    [id, String(message || '').slice(0, 2000)]
  ).catch((err) => console.error('webhook: mark error failed:', err.message));
}

// Legacy preset-in-URL route. Kept so existing vendor configs don't
// break on upgrade. New deployments are encouraged to use /in/:token.
router.post('/:preset/:token', async (req, res) => {
  const { preset: presetName, token } = req.params;
  // Bail early on the new generic route slipping into this handler —
  // 'in' isn't a real preset, route order should prevent it, but
  // belt-and-suspenders.
  if (presetName === 'in') return res.status(404).json({ error: 'Unknown preset: in' });
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

  const inboundId = await logInbound(source.id, req.body);
  let event;
  try {
    event = preset.mapper(req.body);
  } catch (err) {
    await markError(inboundId, `map: ${err.message}`);
    return res.status(400).json({ error: err.message });
  }

  try {
    const result = await ingestAlertEvent({ source, preset, event, rawPayload: req.body });
    await markProcessed(inboundId, result?.ticket_id);
    res.status(202).json({ ok: true, ...result });
  } catch (err) {
    console.error('webhook process error:', err);
    await markError(inboundId, `ingest: ${err.message}`);
    res.status(500).json({ error: 'Processing error' });
  }
});

// Generic intake. Resolves the vendor from the token, runs whichever
// of (adapter mapper, field_map resolver) is available.
router.post('/in/:token', async (req, res) => {
  const { token } = req.params;
  let source;
  try {
    const r = await pool.query(
      `SELECT * FROM external_alert_source
        WHERE token_hash = $1 AND enabled = TRUE`,
      [hashToken(token)]
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

  const inboundId = await logInbound(source.id, req.body);

  // 1) Adapter first — if the vendor column points to a registered
  //    adapter with mapAlertPayload, use it. This is the path for
  //    Action1, Zabbix, and any future named vendor.
  const adapter = registry.get(source.vendor || source.preset);
  let event = null;
  if (adapter && typeof adapter.mapAlertPayload === 'function') {
    try {
      event = adapter.mapAlertPayload(req.body, source);
    } catch (err) {
      // Adapter throws on hard structural errors — fall through to
      // field_map only if NO field_map is configured (avoids silent
      // double-attempts when the admin wanted the adapter path).
      const hasFieldMap = Array.isArray(source.field_map?.rows) && source.field_map.rows.length > 0;
      if (!hasFieldMap) {
        await markError(inboundId, `adapter map: ${err.message}`);
        return res.status(400).json({ error: err.message });
      }
    }
  }

  // 2) Field map fallback — generic tabular path -> field map. Built
  //    for vendors without a code-side adapter (Datto webhook plane,
  //    etc.) and for admins who want to override an adapter's defaults.
  if (!event && source.field_map && Array.isArray(source.field_map.rows) && source.field_map.rows.length) {
    const mapped = applyFieldMap(source.field_map, req.body);
    if (!mapped.external_event_id) {
      const err = 'field_map: external_event_id is required (add a row mapping to it)';
      await markError(inboundId, err);
      return res.status(400).json({ error: err });
    }
    if (!mapped.event_type) {
      // Default to 'problem' when the field map doesn't carry status.
      // Most one-shot vendor webhooks only fire on raise, not recovery.
      mapped.event_type = 'problem';
    }
    event = {
      external_event_id: mapped.external_event_id,
      event_type: mapped.event_type,
      severity: mapped.severity || 'Information',
      title: mapped.title || `${source.name} event ${mapped.external_event_id}`,
      description: mapped.description || '',
      vendor_ref: mapped.vendor_ref || null,
      user_email: mapped.user_email || null,
    };
  }

  if (!event) {
    const err = 'no mapping available — register an adapter or configure a field_map';
    await markError(inboundId, err);
    return res.status(422).json({ error: err });
  }

  try {
    // Build a synthetic preset for ingestAlertEvent so its
    // severity -> priority lookup uses the adapter's default map (or
    // an empty map for pure field_map sources).
    const preset = adapter
      ? { defaultSeverityMap: adapter.defaultSeverityMap || {}, mapper: adapter.mapAlertPayload }
      : { defaultSeverityMap: {}, mapper: () => event };
    const result = await ingestAlertEvent({ source, preset, event, rawPayload: req.body });
    await markProcessed(inboundId, result?.ticket_id);
    res.status(202).json({ ok: true, ...result });
  } catch (err) {
    console.error('webhook process error:', err);
    await markError(inboundId, `ingest: ${err.message}`);
    res.status(500).json({ error: 'Processing error' });
  }
});

module.exports = router;

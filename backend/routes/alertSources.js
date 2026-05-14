const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { generateToken, hashToken } = require('../auth/tokens');
const {
  PRESETS,
  DEFAULT_ZABBIX_SEVERITY_MAP,
  DEFAULT_ACTION1_SEVERITY_MAP,
  getPreset,
} = require('../services/alertMappers');
const { buildWritePatch, decryptRow } = require('../services/fields');
const { ingestAlertEvent } = require('../services/alertIngest');
const action1Poll = require('../services/action1Poll');

const router = express.Router();

const PRESET_NAMES = Object.keys(PRESETS);

const PRESET_DEFAULT_SEVERITY_MAPS = {
  zabbix: DEFAULT_ZABBIX_SEVERITY_MAP,
  action1: DEFAULT_ACTION1_SEVERITY_MAP,
};

// Strip secrets before returning. token_hash + api_token_enc are bytea
// blobs no client should see. api_token plaintext is also stripped — the
// UI surfaces only api_token_set boolean so admins know if creds exist.
function publicRow(row, recentEvents) {
  if (!row) return null;
  const { token_hash, api_token, api_token_enc, ...rest } = row;
  return {
    ...rest,
    api_token_set: !!(api_token || api_token_enc),
    recent_events: recentEvents,
  };
}

// GET /api/alert-sources — list all sources
router.get('/', requireAuth, requireRole('Admin'), async (_req, res) => {
  try {
    const r = await pool.query(`
      SELECT s.*,
        (SELECT COUNT(*)::int FROM external_alert_event WHERE source_id = s.id) AS event_count,
        proj.name AS default_project_name
      FROM external_alert_source s
      LEFT JOIN projects proj ON proj.id = s.default_project_id
      ORDER BY s.name
    `);
    res.json(r.rows.map((row) => publicRow(row)));
  } catch (err) {
    console.error('alert-sources list error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/alert-sources/:id — single source w/ recent events
router.get('/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT s.*, proj.name AS default_project_name
         FROM external_alert_source s
         LEFT JOIN projects proj ON proj.id = s.default_project_id
        WHERE s.id = $1`,
      [Number(req.params.id)]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    const events = await pool.query(
      `SELECT id, external_event_id, ticket_id, event_type, received_at
         FROM external_alert_event
        WHERE source_id = $1
        ORDER BY received_at DESC
        LIMIT 50`,
      [Number(req.params.id)]
    );
    res.json(publicRow(r.rows[0], events.rows));
  } catch (err) {
    console.error('alert-source get error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/alert-sources — create. Returns the raw token ONCE.
//
// Two creation modes:
//   * Legacy preset path: { preset: 'action1'|'zabbix', ... }. Backfills
//     vendor + kind + capabilities from the preset (keeps every existing
//     client working without changes).
//   * Registry path: { vendor: 'ninjaone'|'datto'|'whatever',
//                      capabilities?: [...], api_url?, api_client_id?,
//                      api_token? }. Vendor must match a registered
//                      adapter OR be flagged as a webhook-only generic
//                      integration (kind='webhook_only', caps=['alerts']
//                      default) for unsupported vendors.
//
// preset stays in the row for back-compat (legacy mappers / route URL
// /api/webhooks/:preset/:token still resolve through it). vendor +
// capabilities are the new source of truth for behavior.
router.post('/', requireAuth, requireRole('Admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const {
      name,
      preset: presetIn,
      vendor: vendorIn,
      kind: kindIn,
      capabilities: capsIn,
      default_project_id,
      default_assignee_id,
      severity_map,
      auto_resolve_on_recovery,
      enabled,
      api_url,
      api_client_id,
      api_token,
    } = req.body || {};

    if (!name || typeof name !== 'string') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'name required' });
    }
    if (!default_project_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'default_project_id required' });
    }

    // Resolve vendor + preset + kind + caps. Caller can pass any of
    // (vendor, preset) — we normalize to both columns so legacy
    // readers and the new registry path stay happy.
    const registry = require('../services/integrations/registry');
    let vendor = vendorIn ? String(vendorIn).trim() : null;
    let preset = presetIn ? String(presetIn).trim() : null;
    if (!vendor && preset) vendor = preset;
    if (!preset && vendor) preset = vendor;
    if (!vendor) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'vendor or preset required' });
    }

    const adapter = registry.get(vendor);
    let kind = kindIn || adapter?.kind || 'webhook_only';
    if (!['rmm', 'monitor', 'webhook_only'].includes(kind)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'kind must be rmm | monitor | webhook_only' });
    }

    const ALLOWED_CAPS = ['alerts', 'inventory', 'software', 'vulnerabilities', 'companies'];
    let capabilities;
    if (Array.isArray(capsIn) && capsIn.length) {
      const bad = capsIn.find((c) => !ALLOWED_CAPS.includes(c));
      if (bad) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `capabilities: unknown value '${bad}'` });
      }
      // Adapter declares the upper bound — narrowing is fine, widening
      // beyond what the adapter supports is not (would have no effect
      // anyway but better to fail loud than silent).
      if (adapter && Array.isArray(adapter.capabilities)) {
        const overReach = capsIn.find((c) => !adapter.capabilities.includes(c));
        if (overReach) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `capabilities: '${overReach}' not supported by ${vendor} adapter` });
        }
      }
      capabilities = capsIn;
    } else if (adapter && Array.isArray(adapter.capabilities)) {
      capabilities = adapter.capabilities;
    } else {
      capabilities = ['alerts'];
    }

    const proj = await client.query(
      `SELECT id FROM projects WHERE id = $1 AND status = 'active'`,
      [Number(default_project_id)]
    );
    if (!proj.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Project not found or archived' });
    }

    const token = generateToken();
    const tokenHash = hashToken(token);
    const defaultSevMap = adapter?.defaultSeverityMap
      || PRESET_DEFAULT_SEVERITY_MAPS[preset]
      || {};
    const sevMap = severity_map && typeof severity_map === 'object' && !Array.isArray(severity_map)
      ? severity_map
      : defaultSevMap;

    const r = await client.query(
      `INSERT INTO external_alert_source
         (name, preset, vendor, kind, capabilities, token_hash,
          default_project_id, default_assignee_id, severity_map,
          auto_resolve_on_recovery, enabled, api_url, api_client_id,
          created_by)
       VALUES ($1,$2,$3,$4,$5::text[],$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        name.trim(),
        preset,
        vendor,
        kind,
        capabilities,
        tokenHash,
        Number(default_project_id),
        default_assignee_id ? Number(default_assignee_id) : null,
        JSON.stringify(sevMap),
        !!auto_resolve_on_recovery,
        enabled !== false,
        api_url ? String(api_url).trim() : null,
        api_client_id ? String(api_client_id).trim() : null,
        req.session.user.id,
      ]
    );
    const row = r.rows[0];

    // api_token rides through buildWritePatch so it lands in the
    // encrypted-at-rest column under standard mode.
    if (api_token && String(api_token).trim()) {
      const patch = await buildWritePatch(client, 'external_alert_source', {
        api_token: String(api_token).trim(),
      });
      if (patch.cols.length) {
        const sets = patch.cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
        await client.query(
          `UPDATE external_alert_source SET ${sets} WHERE id = $${patch.cols.length + 1}`,
          [...patch.values, row.id]
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ ...publicRow(row), token });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('alert-source create error:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    client.release();
  }
});

// PATCH /api/alert-sources/:id — update mutable fields. api_token is
// encrypted via buildWritePatch when present; pass null to clear.
router.patch('/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = Number(req.params.id);
    const body = req.body || {};
    const sets = [];
    const values = [];
    let p = 1;

    // Plain fields
    const plain = ['name', 'default_project_id', 'default_assignee_id',
      'auto_resolve_on_recovery', 'enabled', 'api_url', 'api_client_id',
      'poll_interval_minutes', 'affect_inventory', 'inventory_company_id'];
    for (const k of plain) {
      if (Object.prototype.hasOwnProperty.call(body, k)) {
        sets.push(`${k} = $${p++}`);
        values.push(body[k]);
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'severity_map')) {
      sets.push(`severity_map = $${p++}::jsonb`);
      values.push(JSON.stringify(body.severity_map || {}));
    }
    if (Object.prototype.hasOwnProperty.call(body, 'attribute_map')) {
      if (typeof body.attribute_map !== 'object' || Array.isArray(body.attribute_map)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'attribute_map must be an object' });
      }
      sets.push(`attribute_map = $${p++}::jsonb`);
      values.push(JSON.stringify(body.attribute_map || {}));
    }
    if (Object.prototype.hasOwnProperty.call(body, 'company_map')) {
      if (typeof body.company_map !== 'object' || Array.isArray(body.company_map)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'company_map must be an object' });
      }
      sets.push(`company_map = $${p++}::jsonb`);
      values.push(JSON.stringify(body.company_map || {}));
    }
    if (Object.prototype.hasOwnProperty.call(body, 'field_map')) {
      const { validateFieldMap } = require('../services/integrations/fieldMap');
      const err = validateFieldMap(body.field_map);
      if (err) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `field_map: ${err}` });
      }
      sets.push(`field_map = $${p++}::jsonb`);
      values.push(JSON.stringify(body.field_map || {}));
    }
    // capabilities[] — admin can narrow what the adapter offers
    // (e.g. an Action1 source the admin only wants alerts from). Empty
    // arrays are rejected — set capabilities = NULL via DB if you
    // really want to clear it (which falls back to adapter default).
    if (Object.prototype.hasOwnProperty.call(body, 'capabilities')) {
      if (!Array.isArray(body.capabilities)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'capabilities must be an array' });
      }
      const ALLOWED = ['alerts', 'inventory', 'software', 'vulnerabilities', 'companies'];
      const bad = body.capabilities.find((c) => !ALLOWED.includes(c));
      if (bad) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `capabilities: unknown value '${bad}'` });
      }
      sets.push(`capabilities = $${p++}::text[]`);
      values.push(body.capabilities);
    }

    // api_token is sensitive — route through buildWritePatch which writes
    // to api_token_enc (standard mode) or api_token (off mode).
    if (Object.prototype.hasOwnProperty.call(body, 'api_token')) {
      const patch = await buildWritePatch(client, 'external_alert_source', {
        api_token: body.api_token || null,
      });
      for (let i = 0; i < patch.cols.length; i++) {
        sets.push(`${patch.cols[i]} = $${p++}`);
        values.push(patch.values[i]);
      }
    }

    if (!sets.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No updatable fields' });
    }
    sets.push('updated_at = NOW()');
    values.push(id);
    const r = await client.query(
      `UPDATE external_alert_source SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`,
      values
    );
    await client.query('COMMIT');
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(publicRow(r.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('alert-source patch error:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    client.release();
  }
});

// POST /api/alert-sources/:id/backfill — pulls open problems from the
// monitoring tool's API and ingests each via the same pipeline as a
// live webhook. Idempotent: events already seen (by event_id+type) are
// skipped (the dedup index does the work).
//
// Supports Zabbix (API token) and Action1 (OAuth2 client_credentials).
router.post('/:id/backfill', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const r = await pool.query(`SELECT * FROM external_alert_source WHERE id = $1`, [id]);
    const source = r.rows[0];
    if (!source) return res.status(404).json({ error: 'Not found' });
    if (!['zabbix', 'action1'].includes(source.preset)) {
      return res.status(400).json({ error: `Backfill not supported for preset: ${source.preset}` });
    }
    if (!source.default_project_id) {
      return res.status(400).json({ error: 'Source has no default project configured' });
    }
    if (!source.api_url) {
      return res.status(400).json({ error: 'API URL not configured on source' });
    }
    await decryptRow('external_alert_source', source);
    const apiToken = source.api_token;
    if (!apiToken) return res.status(400).json({ error: 'API credential not configured on source' });

    if (source.preset === 'action1') {
      return await backfillAction1(req, res, id, source);
    }

    const { host_group, severities } = req.body || {};

    // Resolve groupid if a group name was supplied
    let groupids = null;
    if (host_group && typeof host_group === 'string' && host_group.trim()) {
      const gr = await zabbixCall(source.api_url, apiToken, 'hostgroup.get', {
        filter: { name: [host_group.trim()] },
        output: ['groupid'],
      });
      if (!gr || !gr[0]) {
        return res.status(404).json({ error: `Host group not found: ${host_group}` });
      }
      groupids = [gr[0].groupid];
    }

    // problem.get does NOT support selectHosts. Pull problems first, then
    // enrich with host info via event.get keyed on eventids.
    const params = {
      output: ['eventid', 'name', 'severity', 'clock', 'opdata'],
      recent: false,
    };
    if (groupids) params.groupids = groupids;
    if (Array.isArray(severities) && severities.length) {
      params.severities = severities.map(Number).filter((n) => n >= 0 && n <= 5);
    }

    let problems;
    const hostByEventId = {};
    const hostidByEventId = {};
    const inventoryByHostId = {};
    try {
      problems = await zabbixCall(source.api_url, apiToken, 'problem.get', params);
      if (problems.length) {
        const events = await zabbixCall(source.api_url, apiToken, 'event.get', {
          output: ['eventid'],
          eventids: problems.map((p) => p.eventid),
          selectHosts: ['hostid', 'host', 'name'],
        });
        for (const e of events) {
          const h = e.hosts?.[0];
          if (h) {
            hostByEventId[e.eventid] = h.host || h.name || '';
            if (h.hostid) hostidByEventId[e.eventid] = h.hostid;
          }
        }
        // Pull inventory.poc_1_email for any hosts we touched. Hosts with
        // inventory disabled return inventory: [] from host.get and we
        // silently skip — leaves user_email blank.
        const hostids = Array.from(new Set(Object.values(hostidByEventId)));
        if (hostids.length) {
          const hosts = await zabbixCall(source.api_url, apiToken, 'host.get', {
            output: ['hostid'],
            hostids,
            selectInventory: ['poc_1_email'],
          });
          for (const h of hosts) {
            const email = h.inventory && !Array.isArray(h.inventory)
              ? (h.inventory.poc_1_email || '').trim()
              : '';
            if (email) inventoryByHostId[h.hostid] = email;
          }
        }
      }
      await pool.query(
        `UPDATE external_alert_source
            SET api_last_ok_at = NOW(), api_last_error = NULL WHERE id = $1`,
        [id]
      );
    } catch (err) {
      await pool.query(
        `UPDATE external_alert_source SET api_last_error = $1 WHERE id = $2`,
        [String(err.message).slice(0, 500), id]
      );
      return res.status(502).json({ error: `Zabbix API error: ${err.message}` });
    }

    const preset = getPreset('zabbix');
    const summary = { fetched: problems.length, created: 0, deduped: 0, failed: 0, ticket_ids: [] };

    for (const p of problems) {
      const sev = mapZabbixSeverity(p.severity);
      const host = hostByEventId[p.eventid] || '';
      const hostid = hostidByEventId[p.eventid];
      const userEmail = hostid ? inventoryByHostId[hostid] || '' : '';
      const synthetic = {
        event_id: p.eventid,
        event_status: 'problem',
        severity: sev,
        host_name: host,
        trigger_name: p.name,
        operational_data: p.opdata || '',
        user_email: userEmail,
      };
      try {
        const event = preset.mapper(synthetic);
        const result = await ingestAlertEvent({
          source,
          preset,
          event,
          rawPayload: synthetic,
        });
        if (result.deduped) summary.deduped++;
        else if (result.created) summary.created++;
        if (result.ticket_id) summary.ticket_ids.push(result.ticket_id);
      } catch (err) {
        console.error('backfill ingest error:', err.message);
        summary.failed++;
      }
    }

    res.json(summary);
  } catch (err) {
    console.error('alert-source backfill error:', err);
    res.status(500).json({ error: 'Backfill error' });
  }
});

// Zabbix JSON-RPC. Tries Bearer first (Zabbix 6.4+), falls back to the
// legacy `auth` envelope field for older versions.
async function zabbixCall(url, token, method, params) {
  const body = { jsonrpc: '2.0', id: 1, method, params };
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
  let resp;
  try {
    resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (err) {
    throw new Error(`network: ${err.message}`);
  }
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  let data = await resp.json().catch(() => null);
  if (!data) throw new Error('non-JSON response');

  // Older Zabbix returns { error: { code:-32602, message:"...auth..."} }
  // when bearer is unsupported. Retry with legacy `auth` field.
  if (data.error && /not authorised|auth/i.test(data.error.message || '')) {
    const legacy = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, auth: token }),
    });
    if (!legacy.ok) throw new Error(`HTTP ${legacy.status} (legacy auth)`);
    data = await legacy.json();
  }
  if (data.error) throw new Error(data.error.data || data.error.message || 'zabbix error');
  return data.result || [];
}

function mapZabbixSeverity(n) {
  return ({
    0: 'Not classified',
    1: 'Information',
    2: 'Warning',
    3: 'Average',
    4: 'High',
    5: 'Disaster',
  })[Number(n)] || 'Information';
}

// Action1 polling lives in services/action1Poll.js. This handler is a
// thin wrapper so the on-demand "Pull now" button and the scheduled
// poll share the same code path.
async function backfillAction1(req, res, id, source) {
  try {
    const summary = await action1Poll.pollSource(source);
    return res.json(summary);
  } catch (err) {
    if (err.upstream) {
      return res.status(502).json({ error: `Action1 API error: ${err.message}` });
    }
    return res.status(400).json({ error: err.message });
  }
}

// POST /api/alert-sources/:id/rotate-token — regenerate, return raw once
router.post('/:id/rotate-token', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const token = generateToken();
    const r = await pool.query(
      `UPDATE external_alert_source
          SET token_hash = $1, updated_at = NOW()
        WHERE id = $2 RETURNING *`,
      [hashToken(token), Number(req.params.id)]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ ...publicRow(r.rows[0]), token });
  } catch (err) {
    console.error('alert-source rotate error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/alert-sources/:id
router.delete('/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM external_alert_source WHERE id = $1 RETURNING id`,
      [Number(req.params.id)]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('alert-source delete error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/alert-sources/_meta/presets — static preset metadata so the
// admin UI can render preset-specific defaults (severity map, snippet).
router.get('/_meta/presets', requireAuth, requireRole('Admin'), (_req, res) => {
  res.json({
    presets: PRESET_NAMES.map((name) => ({
      name,
      default_severity_map: PRESET_DEFAULT_SEVERITY_MAPS[name] || {},
    })),
  });
});

// GET /api/alert-sources/_meta/registry — adapter registry snapshot.
// Powers the new Add-integration form and the per-source capabilities
// editor: every adapter advertises its label, kind, declared
// capabilities, default severity map, and credentialsSchema (form
// fields). UI never hard-codes vendor lists; everything renders from
// this response. Auth gated to Admin since the registry is internal
// metadata.
router.get('/_meta/registry', requireAuth, requireRole('Admin'), (_req, res) => {
  const registry = require('../services/integrations/registry');
  res.json({
    adapters: registry.all().map((a) => ({
      vendor: a.vendor,
      label: a.label,
      kind: a.kind,
      capabilities: a.capabilities,
      credentialsSchema: a.credentialsSchema || [],
      default_severity_map: a.defaultSeverityMap || {},
    })),
  });
});

// GET /api/alert-sources/:id/attributes — list the custom-attribute
// names from the most recent synced asset's raw_data.custom[] for this
// source. Powers the admin mapping UI ("what attributes can I map?").
// Falls back to numbered placeholders if no asset has synced yet so
// admins can pre-configure mappings.
router.get('/:id/attributes', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT raw_data FROM assets
        WHERE source_alert_source_id = $1
          AND raw_data ? 'custom'
        ORDER BY last_seen_at DESC NULLS LAST, id DESC
        LIMIT 1`,
      [Number(req.params.id)]
    );
    if (!r.rows[0]) {
      return res.json({
        attributes: [],
        sample_source: null,
        hint: 'No assets synced yet for this source; click Pull now then revisit.',
      });
    }
    const custom = r.rows[0].raw_data?.custom;
    if (!Array.isArray(custom)) return res.json({ attributes: [], sample_source: null });
    const attrs = custom
      .filter((c) => c && typeof c.name === 'string' && c.name.trim())
      .map((c) => ({ name: String(c.name).trim(), sample_value: c.value != null ? String(c.value) : '' }));
    res.json({ attributes: attrs, sample_source: 'most_recent_asset' });
  } catch (err) {
    console.error('attributes list error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/alert-sources/:id/seen-orgs — distinct organization names
// observed in this source's recent assets. Powers the Hudu-style
// company-mapping UI ("here's what the source ships; map each one").
router.get('/:id/seen-orgs', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT DISTINCT organization
         FROM assets
        WHERE source_alert_source_id = $1
          AND organization IS NOT NULL
          AND organization <> ''
        ORDER BY organization`,
      [Number(req.params.id)]
    );
    res.json({ orgs: r.rows.map((row) => row.organization) });
  } catch (err) {
    console.error('seen-orgs error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Inbound event debug — list recent payloads for a source, view one,
// preview field_map output against a saved payload, reprocess.
router.get('/:id/inbound-events', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const r = await pool.query(
      `SELECT id, received_at, processed_at, status, error_message, ticket_id,
              (CASE WHEN status = 'pending' THEN '(pending)' ELSE NULL END) AS placeholder
         FROM integration_inbound_events
        WHERE integration_id = $1
        ORDER BY received_at DESC
        LIMIT 50`,
      [id]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('inbound events list:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.get('/:id/inbound-events/:eventId', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM integration_inbound_events
        WHERE id = $1 AND integration_id = $2`,
      [req.params.eventId, req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('inbound event detail:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Dry-run: apply a hypothetical field_map against a saved payload
// without persisting. Lets the admin tune the map and see what would
// land in each target before saving.
router.post('/:id/inbound-events/:eventId/preview', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const { applyFieldMap, validateFieldMap } = require('../services/integrations/fieldMap');
    const fm = req.body?.field_map || {};
    const err = validateFieldMap(fm);
    if (err) return res.status(400).json({ error: `field_map: ${err}` });
    const r = await pool.query(
      `SELECT payload FROM integration_inbound_events
        WHERE id = $1 AND integration_id = $2`,
      [req.params.eventId, req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ resolved: applyFieldMap(fm, r.rows[0].payload) });
  } catch (err) {
    console.error('inbound event preview:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

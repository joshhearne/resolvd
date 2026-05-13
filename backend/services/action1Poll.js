// Action1 API integration. Action1 doesn't expose alerts via REST and
// doesn't push outbound webhooks — but it does expose policy execution
// results per endpoint. Failed results map to alert-worthy events.
//
// On-demand: routes/alertSources.js calls pollSource() when the admin
// clicks "Pull now". Scheduled: alertSourcePollScheduler runs pollSource()
// for each enabled source on its poll_interval_minutes cadence.

const { pool } = require('../db/pool');
const { decryptRow } = require('./fields');
const { getPreset } = require('./alertMappers');
const { ingestAlertEvent } = require('./alertIngest');

// Accept paste of curl command or trailing path — extract just the
// scheme+host. Throws on input that can't be parsed as an http(s) URL.
function normalizeBaseUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('API URL empty');
  const m = raw.match(/https?:\/\/[^\s"'`]+/i);
  if (!m) throw new Error('API URL must start with https://');
  let u;
  try {
    u = new URL(m[0]);
  } catch {
    throw new Error('API URL is not a valid URL');
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('API URL must be http(s)');
  return `${u.protocol}//${u.host}`;
}

function scrubSecrets(message, ...secrets) {
  let out = String(message || '');
  for (const s of secrets) {
    const v = String(s || '');
    if (v.length >= 4) out = out.split(v).join('***');
  }
  return out;
}

async function oauthToken(baseUrl, clientId, clientSecret) {
  const url = `${baseUrl}/api/3.0/oauth2/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  }).toString();
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (err) {
    throw new Error(`network: ${err.message}`);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status} on token: ${text.slice(0, 200)}`);
  }
  const data = await resp.json().catch(() => null);
  if (!data || !data.access_token) throw new Error('no access_token in response');
  return data.access_token;
}

async function getJSON(url, accessToken) {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const pathOnly = url.replace(/^https?:\/\/[^/]+/, '');
    throw new Error(`HTTP ${resp.status} on ${pathOnly}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json().catch(() => null);
  if (!data) throw new Error(`non-JSON response from ${url}`);
  return data;
}

function items(data) {
  if (Array.isArray(data)) return data;
  return data?.items || data?.records || data?.data || data?.results || [];
}

async function fetchPaged(baseUrl, accessToken, startUrl, maxPages = 10) {
  let url = startUrl;
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const data = await getJSON(url, accessToken);
    for (const item of items(data)) out.push(item);
    const next = data?.next_page || data?.next || data?.nextLink;
    if (!next) break;
    url = /^https?:\/\//.test(next) ? next : `${baseUrl}${next.startsWith('/') ? '' : '/'}${next}`;
  }
  return out;
}

async function fetchOrgs(baseUrl, accessToken) {
  const data = await getJSON(`${baseUrl}/api/3.0/organizations`, accessToken);
  return items(data).map((o) => ({
    id: String(o.id || o.org_id || o.organization_id || '').trim(),
    name: String(o.name || o.title || '').trim(),
  })).filter((o) => o.id);
}

// Pull managed endpoints across every visible org. ?fields=* asks Action1
// for the extended payload (hardware, OS, patch status). Caller decides
// what to persist.
async function fetchAllEndpoints(baseUrl, accessToken) {
  const orgs = await fetchOrgs(baseUrl, accessToken);
  const out = [];
  for (const org of orgs) {
    let endpoints;
    try {
      endpoints = await fetchPaged(
        baseUrl,
        accessToken,
        `${baseUrl}/api/3.0/endpoints/managed/${encodeURIComponent(org.id)}?fields=*`,
        20
      );
    } catch (err) {
      console.warn(`action1 inventory: skip org ${org.id}: ${err.message}`);
      continue;
    }
    for (const ep of endpoints) {
      out.push({ ...ep, _org_id: org.id, _org_name: org.name });
    }
  }
  return out;
}

// Parse Action1 size strings like "7.99 GB RAM" or "/dev/xvda 80 GB SSD".
// Returns bytes (integer) or null if no number+unit pair is found.
function parseSizeToBytes(s) {
  if (!s) return null;
  const m = String(s).match(/(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB|PB)\b/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4, PB: 1024 ** 5 }[m[2].toUpperCase()];
  return Math.round(n * mult);
}

// Action1 timestamps come as "YYYY-MM-DD_HH-MM-SS" (UTC). Normalize.
function parseAction1Timestamp(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// Split a combined OS string like "Ubuntu 24.04.4 LTS (Noble Numbat)" into
// (name, version). Loose heuristic: name = leading word(s) before the
// first digit; version = the rest. Whole string lands in `os` when the
// split fails.
function splitOsString(s) {
  if (!s) return { os: null, version: null };
  const str = String(s).trim();
  const m = str.match(/^([A-Za-z][A-Za-z .]*?)\s+(\d.*)$/);
  if (m) return { os: m[1].trim(), version: m[2].trim() };
  return { os: str, version: null };
}

// Map an Action1 endpoint payload to the columns assets exposes. Action1
// uses a mix of UPPERCASE (OS, MAC, RAM) and lowercase (name, manufacturer,
// last_seen) keys — we accept the documented names plus a few historical
// aliases. Duplicate alias entries are cheap and harmless.
function mapEndpointToAsset(ep) {
  const pick = (...keys) => {
    for (const k of keys) {
      const v = k.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), ep);
      if (v != null && v !== '') return v;
    }
    return null;
  };
  const externalId = String(pick('id', 'endpoint_id', 'guid', 'uuid') || '').trim();
  if (!externalId) return null;

  const ramRaw = pick('ram_bytes', 'memory_bytes', 'ram_total_bytes', 'hardware.ram_bytes');
  const storageRaw = pick('storage_bytes', 'disk_bytes', 'disk_total_bytes', 'hardware.storage_bytes');
  const ram_bytes = (ramRaw != null && Number(ramRaw)) || parseSizeToBytes(pick('RAM', 'ram'));
  const storage_bytes = (storageRaw != null && Number(storageRaw)) || parseSizeToBytes(pick('disk', 'Disk'));

  const osRaw = pick('OS', 'os', 'os_name', 'operating_system');
  const osParts = splitOsString(osRaw);
  const explicitVersion = pick('os_version', 'os_build', 'operating_system_version');

  return {
    source_external_id: externalId,
    hostname: String(pick('name', 'device_name', 'hostname', 'computer_name') || '').trim() || null,
    serial: String(pick('serial', 'serial_number', 'hardware.serial', 'system_serial') || '').trim() || null,
    mac: String(pick('MAC', 'mac', 'mac_address', 'network.mac') || '').trim() || null,
    manufacturer: String(pick('manufacturer', 'vendor', 'hardware.manufacturer') || '').trim() || null,
    model: String(pick('model', 'system_model', 'hardware.model', 'product_name') || '').trim() || null,
    os: osParts.os,
    os_version: String(explicitVersion || osParts.version || '').trim() || null,
    cpu: String(pick('cpu', 'processor', 'hardware.cpu', 'architecture') || '').trim() || null,
    ram_bytes: ram_bytes || null,
    storage_bytes: storage_bytes || null,
    ip_address: String(pick('ip', 'IP', 'ip_address', 'network.ip') || '').trim() || null,
    organization: String(ep._org_name || ep._org_id || '').trim() || null,
    last_seen_at: parseAction1Timestamp(pick('last_seen', 'last_seen_at', 'last_checkin_at', 'last_checkin')),
  };
}

// Asset columns the attribute_map is allowed to overwrite. Whitelist
// keeps malicious / sloppy mapping config from writing arbitrary cols
// (no FK columns, no timestamps, no raw_data).
const MAPPABLE_ASSET_COLUMNS = new Set([
  'hostname', 'serial', 'mac', 'manufacturer', 'model',
  'os', 'os_version', 'cpu', 'ip_address',
]);

// Walk ep.custom[] against the source's attribute_map. Returns
//   { columnOverrides: { col: value }, customFieldValues: [{def_id, value}] }
// for the caller to merge into the asset upsert. Unknown / unmapped
// attributes are silently skipped — extra custom slots are common in
// Action1 tenants.
function resolveAttributeMappings(ep, attributeMap) {
  const out = { columnOverrides: {}, customFieldValues: [] };
  if (!attributeMap || typeof attributeMap !== 'object') return out;
  const custom = Array.isArray(ep?.custom) ? ep.custom : null;
  if (!custom) return out;
  for (const item of custom) {
    if (!item || typeof item.name !== 'string') continue;
    const value = item.value;
    if (value == null || value === '') continue;
    const mapping = attributeMap[item.name];
    if (!mapping || !mapping.type || !mapping.target) continue;
    if (mapping.type === 'asset_column') {
      if (MAPPABLE_ASSET_COLUMNS.has(mapping.target)) {
        out.columnOverrides[mapping.target] = String(value);
      }
    } else if (mapping.type === 'custom_field') {
      const defId = Number(mapping.target);
      if (Number.isInteger(defId) && defId > 0) {
        out.customFieldValues.push({ def_id: defId, value });
      }
    }
  }
  return out;
}

// Apply custom field values to an asset post-upsert. Loads each def to
// know which value_* column to write. Empty value clears the row.
async function applyCustomFieldValues(assetId, items) {
  if (!items.length) return;
  const ids = items.map((i) => i.def_id);
  const defs = await pool.query(
    `SELECT id, type, options FROM custom_field_defs
      WHERE id = ANY($1::int[]) AND entity_type = 'asset'`,
    [ids]
  );
  const byId = Object.fromEntries(defs.rows.map((d) => [d.id, d]));
  for (const it of items) {
    const def = byId[it.def_id];
    if (!def) continue;
    let col = null, val = null;
    const raw = it.value;
    switch (def.type) {
      case 'text':
        col = 'value_text'; val = String(raw); break;
      case 'number': {
        const n = Number(raw);
        if (!Number.isFinite(n)) continue;
        col = 'value_number'; val = n; break;
      }
      case 'date': {
        const d = new Date(raw);
        if (isNaN(d.getTime())) continue;
        col = 'value_date'; val = d.toISOString(); break;
      }
      case 'bool': {
        const s = String(raw).toLowerCase();
        col = 'value_bool'; val = ['true', '1', 'yes', 'on'].includes(s); break;
      }
      case 'select': {
        const valid = (def.options || []).some((o) => o.value === String(raw));
        if (!valid) continue;
        col = 'value_text'; val = String(raw); break;
      }
      default: continue;
    }
    const cols = ['value_text', 'value_number', 'value_date', 'value_bool'];
    const vals = cols.map((c) => (c === col ? val : null));
    await pool.query(
      `INSERT INTO custom_field_values
         (def_id, asset_id, value_text, value_number, value_date, value_bool)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (def_id, asset_id) DO UPDATE SET
         value_text = EXCLUDED.value_text,
         value_number = EXCLUDED.value_number,
         value_date = EXCLUDED.value_date,
         value_bool = EXCLUDED.value_bool,
         updated_at = NOW()`,
      [def.id, assetId, ...vals]
    );
  }
}

async function upsertAssets(sourceId, sourceSystem, endpoints, attributeMap = {}) {
  let upserted = 0;
  let skipped = 0;
  for (const ep of endpoints) {
    const mapped = mapEndpointToAsset(ep);
    if (!mapped) { skipped++; continue; }
    // Attribute mapping: overrides take precedence over the standard
    // field extraction so a tenant that puts Asset Tag in "Custom
    // Attribute 1" can route it to .serial (or wherever they want).
    const mappings = resolveAttributeMappings(ep, attributeMap);
    for (const [col, val] of Object.entries(mappings.columnOverrides)) {
      mapped[col] = val;
    }
    try {
      const inserted = await pool.query(
        `INSERT INTO assets
          (source_system, source_external_id, source_alert_source_id,
           hostname, serial, mac, manufacturer, model, os, os_version,
           cpu, ram_bytes, storage_bytes, ip_address, organization,
           last_seen_at, raw_data, updated_at)
         VALUES
          ($1, $2, $3,
           $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15,
           $16, $17::jsonb, NOW())
         ON CONFLICT (source_system, source_external_id) DO UPDATE SET
           source_alert_source_id = EXCLUDED.source_alert_source_id,
           hostname = EXCLUDED.hostname,
           serial = EXCLUDED.serial,
           mac = EXCLUDED.mac,
           manufacturer = EXCLUDED.manufacturer,
           model = EXCLUDED.model,
           os = EXCLUDED.os,
           os_version = EXCLUDED.os_version,
           cpu = EXCLUDED.cpu,
           ram_bytes = EXCLUDED.ram_bytes,
           storage_bytes = EXCLUDED.storage_bytes,
           ip_address = EXCLUDED.ip_address,
           organization = EXCLUDED.organization,
           last_seen_at = EXCLUDED.last_seen_at,
           raw_data = EXCLUDED.raw_data,
           updated_at = NOW()
         RETURNING id`,
        [
          sourceSystem, mapped.source_external_id, sourceId,
          mapped.hostname, mapped.serial, mapped.mac, mapped.manufacturer,
          mapped.model, mapped.os, mapped.os_version,
          mapped.cpu, mapped.ram_bytes, mapped.storage_bytes,
          mapped.ip_address, mapped.organization,
          mapped.last_seen_at, JSON.stringify(ep),
        ]
      );
      const assetId = inserted.rows[0]?.id;
      if (assetId && mappings.customFieldValues.length) {
        await applyCustomFieldValues(assetId, mappings.customFieldValues).catch((err) => {
          console.error('asset custom field write error:', err.message);
        });
      }
      upserted++;
    } catch (err) {
      console.error('asset upsert error:', err.message);
      skipped++;
    }
  }
  return { upserted, skipped };
}

// Collect failed policy results across every org the API client can see.
// Each failed result becomes a synthetic event flowing through the
// existing action1 mapper. Dedup key = policy + endpoint + run-timestamp
// so a re-run of the same policy spawns a fresh ticket. Returns scan
// metrics alongside the matched alerts so the admin can see how much
// was walked even when nothing matched (status filter mismatch is the
// most common "0 created" cause).
async function fetchFailedPolicyResults(baseUrl, accessToken) {
  const MAX_ITEMS = 1000;
  const MAX_POLICIES_PER_ORG = 100;
  const orgs = await fetchOrgs(baseUrl, accessToken);
  if (!orgs.length) throw new Error('no organizations visible to this API client');

  const FAIL_STATUSES = new Set(['failed', 'error', 'failure']);
  const statusCounts = {};
  let orgCount = 0;
  let policyCount = 0;
  let resultCount = 0;

  const out = [];
  for (const org of orgs) {
    orgCount++;
    const policies = await fetchPaged(
      baseUrl,
      accessToken,
      `${baseUrl}/api/3.0/policies/instances/${encodeURIComponent(org.id)}`,
      5
    );
    for (const policy of policies.slice(0, MAX_POLICIES_PER_ORG)) {
      const policyId = String(policy.id || policy.policy_id || '').trim();
      if (!policyId) continue;
      policyCount++;
      const policyName = String(policy.title || policy.name || `Policy ${policyId}`).trim();
      let results;
      try {
        results = await fetchPaged(
          baseUrl,
          accessToken,
          `${baseUrl}/api/3.0/policies/instances/${encodeURIComponent(org.id)}/${encodeURIComponent(policyId)}/endpoint_results`,
          10
        );
      } catch (err) {
        console.warn(`action1: skip policy ${policyId} (${org.id}): ${err.message}`);
        continue;
      }
      for (const r of results) {
        resultCount++;
        const rawStatus = String(r.status || r.state || r.result || '').trim();
        const status = rawStatus.toLowerCase();
        statusCounts[rawStatus || '(empty)'] = (statusCounts[rawStatus || '(empty)'] || 0) + 1;
        if (!FAIL_STATUSES.has(status)) continue;
        const endpointId = String(r.endpoint_id || r.endpointId || r.endpoint?.id || '').trim();
        const endpointName = String(r.endpoint_name || r.endpoint?.name || r.computer_name || '').trim();
        const ranAt = String(
          r.finished_at || r.completed_at || r.run_at || r.timestamp || r.updated_at || ''
        ).trim();
        const dedup = `${policyId}:${endpointId || 'unknown'}:${ranAt || 'no-ts'}`;
        out.push({
          event_id: dedup,
          state: 'triggered',
          severity: 'High',
          alert_name: `${policyName} failed`,
          endpoint_id: endpointId,
          endpoint_name: endpointName,
          organization: org.name || org.id,
          details: String(r.error || r.error_message || r.message || r.output || '').slice(0, 4000),
          url: `${baseUrl}/console/#/policies/${encodeURIComponent(policyId)}`,
          _org_id: org.id,
        });
        if (out.length >= MAX_ITEMS) {
          return { alerts: out, scan: { orgCount, policyCount, resultCount, statusCounts, truncated: true } };
        }
      }
    }
  }
  return { alerts: out, scan: { orgCount, policyCount, resultCount, statusCounts, truncated: false } };
}

// Run a single poll cycle for one source row. `source` must be a fully
// loaded external_alert_source record (decryption already applied).
// Returns summary; updates api_last_* and last_poll_at columns.
async function pollSource(source) {
  if (source.preset !== 'action1') throw new Error(`not an action1 source: ${source.preset}`);
  if (!source.default_project_id) throw new Error('source has no default project configured');
  const clientId = (source.api_client_id || '').trim();
  const clientSecret = (source.api_token || '').trim();
  if (!clientId) throw new Error('Action1 Client ID not configured');
  if (!clientSecret) throw new Error('Action1 Client Secret not configured');

  const baseUrl = normalizeBaseUrl(source.api_url);
  let alerts;
  let scan;
  try {
    const token = await oauthToken(baseUrl, clientId, clientSecret);
    ({ alerts, scan } = await fetchFailedPolicyResults(baseUrl, token));
    await pool.query(
      `UPDATE external_alert_source
          SET api_last_ok_at = NOW(), api_last_error = NULL, last_poll_at = NOW()
        WHERE id = $1`,
      [source.id]
    );
  } catch (err) {
    const safe = scrubSecrets(String(err.message), clientSecret).slice(0, 500);
    await pool.query(
      `UPDATE external_alert_source
          SET api_last_error = $1, last_poll_at = NOW()
        WHERE id = $2`,
      [safe, source.id]
    );
    const wrapped = new Error(safe);
    wrapped.upstream = true;
    throw wrapped;
  }

  const preset = getPreset('action1');
  const summary = {
    fetched: alerts.length,
    created: 0,
    deduped: 0,
    failed: 0,
    ticket_ids: [],
    scan,
  };
  for (const a of alerts) {
    try {
      const event = preset.mapper(a);
      const result = await ingestAlertEvent({ source, preset, event, rawPayload: a });
      if (result.deduped) summary.deduped++;
      else if (result.created) summary.created++;
      if (result.ticket_id) summary.ticket_ids.push(result.ticket_id);
    } catch (err) {
      console.error('action1 ingest error:', err.message);
      summary.failed++;
    }
  }

  // Inventory sync — same OAuth token, separate endpoint walk. Gated by
  // the per-source affect_inventory toggle so admins can opt in once
  // they've smoke tested. Errors here don't fail the alert poll.
  if (source.affect_inventory) {
    try {
      const token = await oauthToken(baseUrl, clientId, clientSecret);
      const endpoints = await fetchAllEndpoints(baseUrl, token);
      const inv = await upsertAssets(source.id, 'action1', endpoints, source.attribute_map || {});
      summary.inventory = { fetched: endpoints.length, ...inv };
    } catch (err) {
      summary.inventory = { error: scrubSecrets(String(err.message), clientSecret).slice(0, 500) };
    }
  }

  return summary;
}

module.exports = { pollSource, normalizeBaseUrl };

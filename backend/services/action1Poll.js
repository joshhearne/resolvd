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

// Map an Action1 endpoint payload to the columns assets exposes. Action1
// field names shift across product revisions, so accept a few aliases.
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

  return {
    source_external_id: externalId,
    hostname: String(pick('name', 'hostname', 'computer_name') || '').trim() || null,
    serial: String(pick('serial', 'serial_number', 'hardware.serial') || '').trim() || null,
    mac: String(pick('mac', 'mac_address', 'network.mac') || '').trim() || null,
    manufacturer: String(pick('manufacturer', 'vendor', 'hardware.manufacturer') || '').trim() || null,
    model: String(pick('model', 'hardware.model') || '').trim() || null,
    os: String(pick('os', 'os_name', 'operating_system') || '').trim() || null,
    os_version: String(pick('os_version', 'os_build', 'operating_system_version') || '').trim() || null,
    cpu: String(pick('cpu', 'processor', 'hardware.cpu') || '').trim() || null,
    ram_bytes: ramRaw != null ? Number(ramRaw) || null : null,
    storage_bytes: storageRaw != null ? Number(storageRaw) || null : null,
    ip_address: String(pick('ip', 'ip_address', 'network.ip') || '').trim() || null,
    organization: String(ep._org_name || ep._org_id || '').trim() || null,
    last_seen_at: (() => {
      const v = pick('last_seen', 'last_seen_at', 'last_checkin_at', 'last_checkin');
      if (!v) return null;
      const d = new Date(v);
      return isNaN(d.getTime()) ? null : d.toISOString();
    })(),
  };
}

async function upsertAssets(sourceId, sourceSystem, endpoints) {
  let upserted = 0;
  let skipped = 0;
  for (const ep of endpoints) {
    const mapped = mapEndpointToAsset(ep);
    if (!mapped) { skipped++; continue; }
    try {
      await pool.query(
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
           updated_at = NOW()`,
        [
          sourceSystem, mapped.source_external_id, sourceId,
          mapped.hostname, mapped.serial, mapped.mac, mapped.manufacturer,
          mapped.model, mapped.os, mapped.os_version,
          mapped.cpu, mapped.ram_bytes, mapped.storage_bytes,
          mapped.ip_address, mapped.organization,
          mapped.last_seen_at, JSON.stringify(ep),
        ]
      );
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
      const inv = await upsertAssets(source.id, 'action1', endpoints);
      summary.inventory = { fetched: endpoints.length, ...inv };
    } catch (err) {
      summary.inventory = { error: scrubSecrets(String(err.message), clientSecret).slice(0, 500) };
    }
  }

  return summary;
}

module.exports = { pollSource, normalizeBaseUrl };

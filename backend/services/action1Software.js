// Per-asset installed-software sync for Action1. Called on-demand from
// the asset detail UI ("Sync software" button) rather than as part of
// the regular alert poll — large tenants would otherwise hit Action1
// hard once per minute. Operates on one asset at a time and only when
// the asset is computer-type (workstation / server / laptop).
//
// API path: /api/3.0/endpoints/managed/{org_id}/{endpoint_id}/software
// returns an array of installed packages. Field names vary across
// Action1 product revisions, so accept a few aliases per field.

const { pool } = require('../db/pool');
const { decryptRow } = require('./fields');

const SOFTWARE_TYPE_SLUGS = new Set(['workstation', 'server', 'laptop']);

function normalizeBaseUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('API URL empty');
  const m = raw.match(/https?:\/\/[^\s"'`]+/i);
  if (!m) throw new Error('API URL must start with https://');
  const u = new URL(m[0]);
  return `${u.protocol}//${u.host}`;
}

async function oauthToken(baseUrl, clientId, clientSecret) {
  const url = `${baseUrl}/api/3.0/oauth2/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  }).toString();
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
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
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    throw new Error(`HTTP ${resp.status} on ${path}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json().catch(() => null);
  if (!data) throw new Error('non-JSON response');
  return data;
}

function items(data) {
  if (Array.isArray(data)) return data;
  return data?.items || data?.records || data?.data || data?.software || [];
}

async function fetchPaged(baseUrl, accessToken, startUrl, maxPages = 20) {
  let url = startUrl;
  const out = [];
  for (let i = 0; i < maxPages; i++) {
    const data = await getJSON(url, accessToken);
    for (const item of items(data)) out.push(item);
    const next = data?.next_page || data?.next;
    if (!next) break;
    url = /^https?:\/\//.test(next) ? next : `${baseUrl}${next.startsWith('/') ? '' : '/'}${next}`;
  }
  return out;
}

// Action1 reports each row as { id, type:'ReportRow', fields: { ... } }.
// Pull from .fields first, fall back to flat keys for other RMM shapes.
function f(s, ...keys) {
  const fields = s?.fields || {};
  for (const k of keys) {
    if (fields[k] != null && fields[k] !== '') return fields[k];
    if (s?.[k] != null && s?.[k] !== '') return s[k];
  }
  return null;
}
function pickName(s) {
  return String(f(s, 'Name', 'name', 'display_name', 'title') || '').trim();
}
function pickVersion(s) {
  return String(f(s, 'Version', 'version', 'display_version') || '').trim() || null;
}
function pickVendor(s) {
  return String(f(s, 'Vendor', 'vendor', 'publisher', 'manufacturer', 'Publisher') || '').trim() || null;
}
function pickInstallDate(s) {
  const v = f(s, 'Install Date', 'install_date', 'installed_at', 'installdate', 'InstallDate');
  if (!v) return null;
  const raw = String(v).trim();
  // Action1 reports "20260505" (YYYYMMDD, no separators).
  const ymd = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (ymd) {
    const d = new Date(`${ymd[1]}-${ymd[2]}-${ymd[3]}T00:00:00Z`);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  // Also accept "YYYY-MM-DD" / "YYYY-MM-DD_HH-MM-SS" / ISO.
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[_T](\d{2})[-:](\d{2})[-:](\d{2}))?/);
  if (m) {
    const iso = m[4]
      ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`
      : `${m[1]}-${m[2]}-${m[3]}T00:00:00Z`;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
function pickSize(s) {
  const v = f(s, 'size_bytes', 'size', 'installed_size', 'Size');
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// Sync installed software for one asset. Asset must be computer-type
// AND have a source_alert_source_id (so we can recover the API creds
// + org_id). Returns { fetched, upserted } summary.
async function syncSoftwareForAsset(assetId) {
  const r = await pool.query(
    `SELECT a.id, a.source_external_id, a.source_alert_source_id, a.raw_data,
            at.slug AS type_slug
       FROM assets a
       LEFT JOIN asset_types at ON at.id = a.asset_type_id
      WHERE a.id = $1`,
    [Number(assetId)]
  );
  const asset = r.rows[0];
  if (!asset) throw new Error('asset not found');
  if (asset.source_alert_source_id == null) {
    throw new Error('Asset is manual (no upstream source) — software sync only works for RMM-managed assets');
  }
  if (asset.type_slug && !SOFTWARE_TYPE_SLUGS.has(asset.type_slug)) {
    throw new Error(`Software sync skipped: type '${asset.type_slug}' is not a computer-type asset`);
  }
  const orgId = asset.raw_data?.organization_id || asset.raw_data?._org_id;
  if (!orgId) throw new Error('Cannot resolve Action1 organization for this asset');

  const sourceRow = await pool.query(
    `SELECT * FROM external_alert_source WHERE id = $1`,
    [asset.source_alert_source_id]
  );
  const source = sourceRow.rows[0];
  if (!source) throw new Error('Source no longer exists');
  await decryptRow('external_alert_source', source);
  const clientSecret = source.api_token;
  if (!clientSecret || !source.api_client_id || !source.api_url) {
    throw new Error('Source API credentials incomplete');
  }

  const syncStartedAt = new Date();
  const baseUrl = normalizeBaseUrl(source.api_url);
  const accessToken = await oauthToken(baseUrl, source.api_client_id, clientSecret);
  // Path per PSAction1's R_InstalledSoftware / G_EndpointApps:
  //   /api/3.0/apps/{org_id}/data/{endpoint_id}
  // returns the installed-software list for a single endpoint.
  const startUrl = `${baseUrl}/api/3.0/apps/${encodeURIComponent(orgId)}/data/${encodeURIComponent(asset.source_external_id)}`;
  const list = await fetchPaged(baseUrl, accessToken, startUrl);

  const { resolveSoftwareName } = require('./softwareAliases');
  let upserted = 0;
  for (const s of list) {
    const name = pickName(s);
    if (!name) continue;
    const version = pickVersion(s);
    const vendor = pickVendor(s);
    const install_date = pickInstallDate(s);
    const size_bytes = pickSize(s);
    // Alias-resolve against the admin-curated software_aliases table.
    // Returns null when no alias matches — keep canonical_* NULL so the
    // UI's "fallback to raw name" path kicks in.
    const alias = await resolveSoftwareName({ name, vendor });
    await pool.query(
      `INSERT INTO asset_software
         (asset_id, name, version, vendor, install_date, size_bytes, raw,
          canonical_name, canonical_vendor, last_alias_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, NOW())
       ON CONFLICT (asset_id, name, version) DO UPDATE SET
         vendor = EXCLUDED.vendor,
         install_date = EXCLUDED.install_date,
         size_bytes = EXCLUDED.size_bytes,
         raw = EXCLUDED.raw,
         canonical_name = EXCLUDED.canonical_name,
         canonical_vendor = EXCLUDED.canonical_vendor,
         last_alias_id = EXCLUDED.last_alias_id,
         updated_at = NOW()`,
      [
        asset.id, name, version, vendor, install_date, size_bytes, JSON.stringify(s),
        alias?.canonical_name || null,
        alias?.canonical_vendor || null,
        alias?.alias_id || null,
      ]
    );
    upserted++;
  }
  // Stale row cleanup: anything not touched in this sync (updated_at
  // < the moment we started) for this asset is treated as uninstalled
  // and dropped. Use updated_at as the boundary — the UPSERT bumps it
  // on every match. Two-second slack to avoid clock-skew false drops.
  await pool.query(
    `DELETE FROM asset_software
      WHERE asset_id = $1 AND updated_at < NOW() - INTERVAL '2 seconds'
        AND updated_at < $2::timestamptz`,
    [asset.id, syncStartedAt]
  ).catch((err) => console.warn(`asset_software cleanup failed for asset ${asset.id}:`, err.message));
  await pool.query(
    `UPDATE assets SET last_software_sync_at = NOW() WHERE id = $1`,
    [asset.id]
  );
  return { fetched: list.length, upserted };
}

module.exports = { syncSoftwareForAsset };

// Uptime Kuma adapter.
//
// Alerts: Kuma posts its default Webhook notification JSON to the
// tokenized /api/webhooks/in/:token URL (mapper in alertMappers).
//
// Status: pullStatus() reads Kuma's Prometheus endpoint (/metrics,
// basic auth with an empty user and a Kuma API key as the password)
// for every monitor's live state, uptime and response time. Kuma has
// no REST API beyond that; its UI talks Socket.IO.
//
// api_url is the base Resolvd polls (an internal Docker URL such as
// http://uptime-kuma:3001 works); web_url, when set, is the
// human-facing base used for "Open in Uptime Kuma" links.

const { register } = require('./registry');
const { PRESETS } = require('../alertMappers');
const { parsePrometheusText } = require('../prometheusText');

const preset = PRESETS['uptime-kuma'];

const STATE_BY_CODE = { 0: 'down', 1: 'up', 2: 'pending', 3: 'maintenance' };

function trimBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

// Prometheus samples -> one row per monitor, keyed like the webhook
// path (monitor:<id>) so polled and alerted items are the same row.
// Group monitors are kept (item_type 'group'): they are the services
// their monitors roll up into. /metrics doesn't say which group a
// monitor is in; that comes from webhook payloads or an admin.
function snapshotFromMetrics(samples) {
  const byId = new Map();
  for (const s of samples) {
    const id = s.labels.monitor_id;
    if (!id || !s.name.startsWith('monitor_')) continue;
    let row = byId.get(id);
    if (!row) {
      const target = s.labels.monitor_url && s.labels.monitor_url !== 'null' && s.labels.monitor_url !== 'https://'
        ? s.labels.monitor_url
        : (s.labels.monitor_hostname && s.labels.monitor_hostname !== 'null'
            ? `${s.labels.monitor_hostname}${s.labels.monitor_port && s.labels.monitor_port !== 'null' ? `:${s.labels.monitor_port}` : ''}`
            : null);
      row = {
        item_key: `monitor:${id}`,
        external_id: String(id),
        label: s.labels.monitor_name || `Monitor ${id}`,
        item_type: s.labels.monitor_type || null,
        detail: target ? `${s.labels.monitor_type || 'monitor'} · ${target}` : null,
        state: null,
        uptime_1d: null,
        uptime_30d: null,
        response_ms: null,
        cert_days: null,
      };
      byId.set(id, row);
    }
    const finite = Number.isFinite(s.value);
    switch (s.name) {
      case 'monitor_status':
        row.state = STATE_BY_CODE[s.value] || null;
        break;
      case 'monitor_uptime_ratio':
        if (!finite) break;
        if (s.labels.window === '1d') row.uptime_1d = s.value;
        if (s.labels.window === '30d') row.uptime_30d = s.value;
        break;
      case 'monitor_response_time':
        if (finite && s.value >= 0) row.response_ms = Math.round(s.value);
        break;
      case 'monitor_cert_days_remaining':
        if (finite) row.cert_days = Math.round(s.value);
        break;
      default:
        break;
    }
  }
  return [...byId.values()];
}

register({
  vendor: 'uptime-kuma',
  label: 'Uptime Kuma',
  kind: 'monitor',
  capabilities: ['alerts', 'status'],
  credentialsSchema: [
    { name: 'api_url', kind: 'url', required: false, label: 'Kuma API base (polled)' },
    { name: 'api_token', kind: 'secret', required: false, encrypted: true, label: 'Kuma API key' },
  ],
  defaultSeverityMap: preset.defaultSeverityMap,
  mapAlertPayload(payload, source) {
    const event = preset.mapper(payload);
    if (!event || event.ignore) return event;
    const base = trimBase(source?.web_url || source?.api_url);
    const monitorId = event.item_key.slice('monitor:'.length);
    if (base) {
      event.vendor_ref = `${base}/dashboard/${monitorId}`;
      event.description += `\n\n[Open in Uptime Kuma](${event.vendor_ref})`;
    }
    return event;
  },
  async pullStatus(source) {
    const base = trimBase(source.api_url);
    if (!base) throw new Error('Kuma API base URL not set');
    if (!source.api_token) throw new Error('Kuma API key not set');
    const auth = Buffer.from(`:${source.api_token}`).toString('base64');
    const res = await fetch(`${base}/metrics`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`GET /metrics -> HTTP ${res.status}`);
    return snapshotFromMetrics(parsePrometheusText(await res.text()));
  },
});

module.exports = { snapshotFromMetrics };

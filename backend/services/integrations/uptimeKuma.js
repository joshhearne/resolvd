// Uptime Kuma adapter. Webhook-only: Kuma posts its default Webhook
// notification JSON to the tokenized /api/webhooks/in/:token URL. Kuma
// has no REST API for pulls (its UI talks Socket.IO), so no inventory
// capability. Optional api_url is the Kuma base URL, used only to link
// tickets back to the monitor's dashboard page.

const { register } = require('./registry');
const { PRESETS } = require('../alertMappers');

const preset = PRESETS['uptime-kuma'];

register({
  vendor: 'uptime-kuma',
  label: 'Uptime Kuma',
  kind: 'monitor',
  capabilities: ['alerts'],
  credentialsSchema: [
    { name: 'api_url', kind: 'url', required: false, label: 'Uptime Kuma URL (for links)' },
  ],
  defaultSeverityMap: preset.defaultSeverityMap,
  mapAlertPayload(payload, source) {
    const event = preset.mapper(payload);
    if (!event || event.ignore) return event;
    const base = String(source?.api_url || '').trim().replace(/\/+$/, '');
    const monitorId = event.item_key.slice('monitor:'.length);
    if (base) {
      event.vendor_ref = `${base}/dashboard/${monitorId}`;
      event.description += `\n\n[Open in Uptime Kuma](${event.vendor_ref})`;
    }
    return event;
  },
});

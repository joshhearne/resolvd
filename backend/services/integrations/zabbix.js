// Zabbix adapter. Webhook-only on the alerts side today — Zabbix's
// own API is JSON-RPC and would be a separate pull adapter when the
// inventory capability gets added (the Zabbix hosts inventory tab
// exposes machine details that map well to assets.*). For now this
// stub registers the vendor + alert mapper so the admin UI and the
// webhook intake can route Zabbix sources through the registry rather
// than the legacy preset switch.

const { register } = require('./registry');
const { PRESETS } = require('../alertMappers');

const preset = PRESETS.zabbix;

register({
  vendor: 'zabbix',
  label: 'Zabbix',
  kind: 'monitor',
  capabilities: ['alerts'],
  credentialsSchema: [
    // Zabbix posts to a tokenized webhook URL — no outbound creds
    // needed yet. When a pullInventory adapter lands, this will
    // grow api_url + api_user + api_token entries.
  ],
  defaultSeverityMap: preset.defaultSeverityMap,
  mapAlertPayload(payload /* , source */) {
    return preset.mapper(payload);
  },
});

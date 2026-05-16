// Action1 adapter. Wraps the existing pull + software + alert-mapper
// modules behind the registry interface so future vendors (NinjaOne,
// Datto, ConnectWise) can plug into the same hooks without per-vendor
// special casing in the scheduler or admin UI.
//
// Logic stays where it lived — action1Poll / action1Software /
// alertMappers — so we keep behavior bit-for-bit while moving the
// indirection layer to a vendor-agnostic registry. A later phase can
// inline the bodies under this folder once every consumer is on the
// registry path.

const { register } = require('./registry');
const action1Poll = require('../action1Poll');
const action1Software = require('../action1Software');
const { PRESETS } = require('../alertMappers');

const preset = PRESETS.action1;

register({
  vendor: 'action1',
  label: 'Action1',
  kind: 'rmm',
  capabilities: ['alerts', 'inventory', 'software', 'vulnerabilities', 'companies'],
  credentialsSchema: [
    { name: 'api_url', kind: 'url', required: true, label: 'API URL' },
    { name: 'api_client_id', kind: 'text', required: true, label: 'Client ID' },
    { name: 'api_token', kind: 'secret', required: true, encrypted: true, label: 'Client secret' },
  ],
  defaultSeverityMap: preset.defaultSeverityMap,
  mapAlertPayload(payload /* , source */) {
    return preset.mapper(payload);
  },
  async pullInventory(source) {
    return action1Poll.pollSource(source);
  },
  async pullSoftware(_source, asset) {
    return action1Software.syncSoftwareForAsset(asset.id);
  },
});

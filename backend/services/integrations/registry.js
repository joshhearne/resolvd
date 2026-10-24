// Multi-vendor integration registry. Each adapter file in this dir
// exports an object describing how to talk to one upstream vendor —
// credentials schema, capability list, and (optionally) inventory /
// software / vulnerability pull fns plus a webhook payload mapper.
//
// Adapter shape:
//   {
//     vendor: 'action1',          // matches integrations.vendor
//     label: 'Action1',           // display name in admin UI
//     kind: 'rmm',                // 'rmm' | 'monitor' | 'webhook_only'
//     capabilities: [             // declared per vendor; admin can
//       'alerts',                 // narrow further per integration row
//       'inventory',
//       'software',
//       'vulnerabilities',
//       'companies',
//     ],
//     credentialsSchema: [        // optional — drives form rendering
//       { name, kind: 'text'|'url'|'secret', required, encrypted? }
//     ],
//     defaultSeverityMap: {...},  // optional, used by resolvePriority
//     mapAlertPayload(payload, source) { return normalizedEvent | null },
//     async pullInventory(source) { /* yields normalized rows */ },
//     async pullSoftware(source, asset) { /* yields software rows */ },
//     async pullVulnerabilities(source, asset) { /* optional */ },
//     async testConnection(creds) { return { ok, error? } },
//   }
//
// Capabilities are the source of truth for what the admin UI exposes
// per integration. The schema-side `capabilities` column carries the
// effective list (adapter default ∩ admin opt-in); pull schedulers /
// webhook handlers consult this column rather than the adapter so an
// admin can disable a capability without disabling the integration.

const adapters = new Map();

function register(adapter) {
  if (!adapter || !adapter.vendor) {
    throw new Error('integration adapter must have a vendor');
  }
  if (adapters.has(adapter.vendor)) {
    throw new Error(`integration adapter ${adapter.vendor} already registered`);
  }
  adapters.set(adapter.vendor, adapter);
}

function get(vendor) {
  return adapters.get(vendor) || null;
}

function all() {
  return Array.from(adapters.values());
}

// Adapters that declare a given capability. Caller usually intersects
// this with the source row's effective capabilities column before
// invoking — see schedulers.
function withCapability(cap) {
  return all().filter((a) => Array.isArray(a.capabilities) && a.capabilities.includes(cap));
}

// Convenience: vendors offering an inventory pull. Used by the
// scheduler to know which sources to tick.
function inventoryVendors() {
  return withCapability('inventory').filter((a) => typeof a.pullInventory === 'function');
}

function softwareVendors() {
  return withCapability('software').filter((a) => typeof a.pullSoftware === 'function');
}

module.exports = { register, get, all, withCapability, inventoryVendors, softwareVendors };

// Eager-load every adapter in this directory. Adapters self-register
// via register() at require time, so a simple require() per file is
// enough — no manifest to maintain. NOTE: this MUST run AFTER
// module.exports is assigned so each adapter file's
// `require('./registry')` gets the populated export object instead of
// an empty placeholder (the Node CommonJS circular-require gotcha).
const fs = require('fs');
const path = require('path');
function loadAll() {
  const dir = __dirname;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'registry.js') continue;
    if (entry.isFile() && entry.name.endsWith('.js')) {
      require(path.join(dir, entry.name));
    }
  }
}
loadAll();

// Payload mappers per monitoring preset. Each mapper returns a
// normalized event:
//   {
//     external_event_id: string,   // unique per fire (dedup key)
//     event_type:        'problem'|'recovery',
//     severity:          string,    // raw — caller maps to priority
//     title:             string,
//     description:       string,    // markdown — body of created ticket / comment
//     vendor_ref:        string?,   // optional, surfaces on ticket
//   }
//
// Mappers throw on a payload that's structurally invalid; the route
// returns 400. Soft "missing field" cases get sane defaults so a
// half-templated webhook still yields a visible ticket.

// Zabbix Webhook media-type. The Zabbix admin pastes a one-script
// template that posts the following shape (configurable in their UI but
// the script we hand them produces this). Keys are conservative — most
// real installs send extras (host groups, tags, etc.) which we keep in
// raw_payload but don't act on.
function zabbix(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('payload required');
  }
  const eventId = String(
    payload.event_id ||
    payload.eventid ||
    payload.id ||
    ''
  ).trim();
  if (!eventId) throw new Error('event_id required');

  // Zabbix sends "PROBLEM" or "OK"/"RESOLVED" depending on operation.
  // Some templates send {EVENT.VALUE} (1=problem, 0=recovery).
  const rawStatus = String(
    payload.event_status ||
    payload.status ||
    payload.event_value ||
    ''
  ).toLowerCase().trim();
  let eventType;
  if (['problem', '1', 'fire', 'firing'].includes(rawStatus)) eventType = 'problem';
  else if (['ok', '0', 'recovery', 'resolved', 'resolve'].includes(rawStatus)) eventType = 'recovery';
  else throw new Error(`unknown status: ${rawStatus || '(empty)'}`);

  const severity = String(
    payload.severity ||
    payload.event_severity ||
    payload.trigger_severity ||
    'Information'
  ).trim();

  const host = payload.host_name || payload.host || '';
  const trigger = payload.trigger_name || payload.subject || payload.name || '';
  const triggerDesc = payload.trigger_description || payload.description || '';
  const opdata = payload.operational_data || payload.opdata || '';

  const userEmail = String(payload.user_email || '').trim().toLowerCase() || null;

  const titleParts = [];
  if (host) titleParts.push(`[${host}]`);
  titleParts.push(trigger || `Zabbix event ${eventId}`);
  const title = titleParts.join(' ').slice(0, 200);

  const lines = [];
  if (host) lines.push(`**Host:** ${host}`);
  lines.push(`**Severity:** ${severity}`);
  if (userEmail) lines.push(`**Inventory contact:** ${userEmail}`);
  lines.push(`**Event ID:** ${eventId}`);
  if (triggerDesc) lines.push('', triggerDesc);
  if (opdata) lines.push('', `Operational data: ${opdata}`);
  if (payload.event_tags) lines.push('', `Tags: ${payload.event_tags}`);
  if (payload.event_url) lines.push('', `[View in Zabbix](${payload.event_url})`);

  return {
    external_event_id: eventId,
    event_type: eventType,
    severity,
    title,
    description: lines.join('\n'),
    vendor_ref: payload.event_url || null,
    user_email: userEmail,
  };
}

// Default Zabbix severity → Resolvd priority (1 highest, 5 lowest).
// Override per-source via severity_map JSONB column.
const DEFAULT_ZABBIX_SEVERITY_MAP = {
  Disaster: 1,
  High: 2,
  Average: 3,
  Warning: 4,
  Information: 5,
  'Not classified': 5,
};

// Action1 (cloud RMM) webhook integration. Action1 fires JSON POSTs from
// its Alerts feature when an alert rule trips (patch failure, endpoint
// offline, vulnerability detected, software install failed, scheduled task
// failed, etc.). Field naming in their payloads has shifted across
// product revisions, so this mapper accepts a few aliases per field.
function action1(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('payload required');
  }

  // Action1 uses several keys across versions for the alert/event id.
  // Prefer event_id (per-fire) over alert_id (per-rule) when both are
  // present — dedup is sharper on per-fire.
  const eventId = String(
    payload.event_id ||
    payload.EventId ||
    payload.alert_event_id ||
    payload.alert_id ||
    payload.AlertId ||
    payload.id ||
    ''
  ).trim();
  if (!eventId) throw new Error('event_id / alert_id required');

  const rawState = String(
    payload.state ||
    payload.alert_state ||
    payload.status ||
    payload.event_type ||
    payload.EventType ||
    ''
  ).toLowerCase().trim();
  let eventType;
  if (['triggered', 'firing', 'fire', 'open', 'problem', 'active', 'alert', 'raised'].includes(rawState)) {
    eventType = 'problem';
  } else if (['resolved', 'recovered', 'cleared', 'closed', 'ok', 'recovery'].includes(rawState)) {
    eventType = 'recovery';
  } else {
    throw new Error(`unknown state: ${rawState || '(empty)'}`);
  }

  const severity = String(
    payload.severity ||
    payload.Severity ||
    payload.alert_severity ||
    'Information'
  ).trim();

  // Endpoint identity — Action1's "Endpoint" is a host/computer name.
  // Several payload shapes exist: flat (endpoint_name) or nested
  // (Endpoint.Name). Pick whichever is present.
  const endpointName = String(
    payload.endpoint_name ||
    payload.endpoint ||
    payload.computer_name ||
    payload.host_name ||
    (payload.Endpoint && (payload.Endpoint.Name || payload.Endpoint.name)) ||
    ''
  ).trim();
  const endpointId = String(
    payload.endpoint_id ||
    (payload.Endpoint && (payload.Endpoint.Id || payload.Endpoint.id)) ||
    ''
  ).trim();
  const endpointOs = String(
    payload.os ||
    payload.endpoint_os ||
    (payload.Endpoint && (payload.Endpoint.OS || payload.Endpoint.os)) ||
    ''
  ).trim();

  const organization = String(
    payload.organization ||
    payload.org_name ||
    payload.OrganizationName ||
    (payload.Organization && (payload.Organization.Name || payload.Organization.name)) ||
    ''
  ).trim();

  const alertName = String(
    payload.alert_name ||
    payload.AlertName ||
    payload.name ||
    payload.title ||
    `Action1 alert ${eventId}`
  ).trim();

  const details = String(
    payload.details ||
    payload.Details ||
    payload.message ||
    payload.description ||
    ''
  ).trim();

  const action1Url = String(
    payload.url ||
    payload.Url ||
    payload.alert_url ||
    payload.console_url ||
    ''
  ).trim() || null;

  const userEmail = String(payload.user_email || payload.contact_email || '')
    .trim()
    .toLowerCase() || null;

  const titleParts = [];
  if (endpointName) titleParts.push(`[${endpointName}]`);
  titleParts.push(alertName);
  const title = titleParts.join(' ').slice(0, 200);

  const lines = [];
  if (endpointName) lines.push(`**Endpoint:** ${endpointName}`);
  if (endpointOs) lines.push(`**OS:** ${endpointOs}`);
  if (endpointId) lines.push(`**Endpoint ID:** ${endpointId}`);
  if (organization) lines.push(`**Organization:** ${organization}`);
  lines.push(`**Severity:** ${severity}`);
  if (userEmail) lines.push(`**Contact:** ${userEmail}`);
  lines.push(`**Event ID:** ${eventId}`);
  if (details) lines.push('', details);
  if (action1Url) lines.push('', `[View in Action1](${action1Url})`);

  return {
    external_event_id: eventId,
    event_type: eventType,
    severity,
    title,
    description: lines.join('\n'),
    vendor_ref: action1Url,
    user_email: userEmail,
  };
}

// Default Action1 severity → Resolvd priority. Action1's built-in scale
// is three-level (Critical / Warning / Information); patch + vulnerability
// alerts can also surface "High" / "Medium" / "Low" depending on rule.
const DEFAULT_ACTION1_SEVERITY_MAP = {
  Critical: 1,
  High: 2,
  Warning: 3,
  Medium: 3,
  Low: 4,
  Information: 5,
  Info: 5,
};

const PRESETS = {
  zabbix: { mapper: zabbix, defaultSeverityMap: DEFAULT_ZABBIX_SEVERITY_MAP },
  action1: { mapper: action1, defaultSeverityMap: DEFAULT_ACTION1_SEVERITY_MAP },
};

function getPreset(name) {
  return PRESETS[name] || null;
}

// Resolves severity → priority. severity_map (per-source override) merges
// on top of the preset's default map. Falls back to 3 when both miss.
function resolvePriority(preset, severity, sourceMap) {
  const def = preset?.defaultSeverityMap || {};
  const merged = { ...def, ...(sourceMap || {}) };
  // case-insensitive lookup
  const want = String(severity || '').trim().toLowerCase();
  for (const [k, v] of Object.entries(merged)) {
    if (k.toLowerCase() === want) return Math.max(1, Math.min(5, Number(v) || 3));
  }
  return 3;
}

module.exports = {
  getPreset,
  resolvePriority,
  PRESETS,
  DEFAULT_ZABBIX_SEVERITY_MAP,
  DEFAULT_ACTION1_SEVERITY_MAP,
};

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

const PRESETS = {
  zabbix: { mapper: zabbix, defaultSeverityMap: DEFAULT_ZABBIX_SEVERITY_MAP },
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

module.exports = { getPreset, resolvePriority, PRESETS, DEFAULT_ZABBIX_SEVERITY_MAP };

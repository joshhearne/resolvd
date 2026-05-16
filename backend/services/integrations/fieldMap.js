// Tabular field-map resolver. Translates an inbound vendor payload
// into the normalized event shape ingestAlertEvent expects, using only
// declarative rules — NO procedural rules engine, NO AND/OR DSL. Each
// row of the field_map describes one extraction: pick a JSON path from
// the payload, optionally transform the string, optionally remap via
// a finite enum -> enum table, and write to a known target field.
//
// Map shape:
//   {
//     rows: [
//       {
//         source_path: '$.host.name',      // JSON path or dot path
//         target: 'title',                 // see TARGETS below
//         transform: 'trim' | 'lower' | 'upper'
//                  | { kind: 'regex_extract', pattern: '...', group?: 1 }
//                  | { kind: 'prepend', text: '...' }
//                  | { kind: 'append',  text: '...' }
//                  | { kind: 'replace', pattern: '...', replacement: '...' }
//                  | null,
//         value_map: { 'CRITICAL': '1', 'HIGH': '2', ... }   // optional
//       },
//       ...
//     ]
//   }
//
// Known targets — the resolver only writes these keys (everything else
// is rejected, so a typo in admin doesn't smuggle a column write):
const TARGETS = new Set([
  'external_event_id',  // dedup key. required for ingestAlertEvent.
  'event_type',         // 'problem' | 'recovery'
  'severity',           // raw string; alertIngest maps -> priority
  'title',              // ticket title
  'description',        // ticket body (markdown ok)
  'vendor_ref',         // optional ref URL or id
  'user_email',         // optional contact email for assignee resolution
]);

// Path support: '$.foo.bar[0].baz' or 'foo.bar[0].baz'. Returns the
// resolved value or undefined. We keep this tiny — full JSONPath is
// overkill for the 90% case and adds a dep.
function readPath(obj, path) {
  if (!path) return undefined;
  let s = String(path).trim();
  if (s.startsWith('$.')) s = s.slice(2);
  else if (s.startsWith('$')) s = s.slice(1);
  if (!s) return obj;
  // Split on . and bracket index, dropping empties.
  const parts = [];
  for (const seg of s.split('.')) {
    const m = seg.match(/^([^[\]]*)((?:\[\d+\])*)$/);
    if (!m) return undefined;
    if (m[1]) parts.push(m[1]);
    const idx = m[2].match(/\[(\d+)\]/g);
    if (idx) for (const i of idx) parts.push(Number(i.slice(1, -1)));
  }
  let cur = obj;
  for (const k of parts) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

function applyTransform(value, transform) {
  if (value == null) return value;
  let s = String(value);
  if (!transform) return s;
  if (transform === 'trim') return s.trim();
  if (transform === 'lower') return s.toLowerCase();
  if (transform === 'upper') return s.toUpperCase();
  if (typeof transform !== 'object') return s;
  if (transform.kind === 'regex_extract') {
    try {
      const re = new RegExp(transform.pattern);
      const m = s.match(re);
      if (!m) return '';
      const g = Number(transform.group);
      if (Number.isInteger(g) && g >= 0 && m[g] != null) return m[g];
      return m[0];
    } catch {
      return '';
    }
  }
  if (transform.kind === 'prepend') return String(transform.text || '') + s;
  if (transform.kind === 'append') return s + String(transform.text || '');
  if (transform.kind === 'replace') {
    try {
      const re = new RegExp(transform.pattern, 'g');
      return s.replace(re, String(transform.replacement ?? ''));
    } catch {
      return s;
    }
  }
  return s;
}

function applyValueMap(value, map) {
  if (!map || typeof map !== 'object') return value;
  if (value == null) return value;
  // Case-insensitive lookup so the admin doesn't have to match the
  // vendor's exact casing (CRITICAL vs Critical).
  const want = String(value).trim().toLowerCase();
  for (const [k, v] of Object.entries(map)) {
    if (String(k).trim().toLowerCase() === want) return v;
  }
  return value;
}

// Result of applying a map. Caller (webhook route) is responsible for
// ensuring required keys (external_event_id, event_type) are present;
// this function only writes what the rows say.
function applyFieldMap(fieldMap, payload) {
  const out = {};
  const rows = Array.isArray(fieldMap?.rows) ? fieldMap.rows : [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const target = String(row.target || '').trim();
    if (!TARGETS.has(target)) continue;
    const raw = readPath(payload, row.source_path);
    const transformed = applyTransform(raw, row.transform);
    const mapped = applyValueMap(transformed, row.value_map);
    if (mapped !== undefined && mapped !== '') {
      out[target] = String(mapped);
    }
  }
  return out;
}

function validateFieldMap(fieldMap) {
  if (fieldMap == null || (typeof fieldMap === 'object' && Object.keys(fieldMap).length === 0)) {
    return null; // empty is fine — means "no mapping"
  }
  if (typeof fieldMap !== 'object') return 'field_map must be an object';
  if (!Array.isArray(fieldMap.rows)) return 'field_map.rows must be an array';
  for (let i = 0; i < fieldMap.rows.length; i++) {
    const r = fieldMap.rows[i];
    if (!r || typeof r !== 'object') return `row ${i}: must be an object`;
    if (typeof r.source_path !== 'string' || !r.source_path.trim()) {
      return `row ${i}: source_path required`;
    }
    if (!TARGETS.has(String(r.target || ''))) {
      return `row ${i}: target must be one of ${Array.from(TARGETS).join(', ')}`;
    }
    if (r.transform != null && typeof r.transform !== 'string' && typeof r.transform !== 'object') {
      return `row ${i}: transform must be a string or object`;
    }
    if (r.value_map != null && typeof r.value_map !== 'object') {
      return `row ${i}: value_map must be an object`;
    }
  }
  return null;
}

module.exports = { applyFieldMap, validateFieldMap, readPath, TARGETS: Array.from(TARGETS) };

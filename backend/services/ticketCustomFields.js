// Ticket custom-field values: validate against the chosen form, coerce by
// type, write (encrypting sensitive defs), and read back (decrypting).
//
// Required-ness is read from ticket_form_fields.required — i.e. ONLY the
// fields bound to the form being filed are ever considered. A field bound to
// some other project's form can't make this ticket fail validation. That is
// the anti-bleed guarantee enforced at the data layer.

const { encrypt, decrypt } = require('./crypto');
const { getMode } = require('./fields');

// Coerce + validate a raw value against a def. Returns { col, value } where
// col is the value_* column to populate, or { error } on a type mismatch.
// Mirrors routes/customFields.js coerceValue (kept local to avoid a
// route→service dependency cycle).
function coerceValue(value, def) {
  if (value == null || value === '') return { col: null, value: null };
  switch (def.type) {
    case 'text':
      return { col: 'value_text', value: String(value) };
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) return { error: 'number required' };
      return { col: 'value_number', value: n };
    }
    case 'date': {
      const d = new Date(value);
      if (isNaN(d.getTime())) return { error: 'date required (ISO8601)' };
      return { col: 'value_date', value: d.toISOString() };
    }
    case 'bool':
      return { col: 'value_bool', value: !!value };
    case 'select': {
      const valid = (def.options || []).some((o) => o.value === String(value));
      if (!valid) return { error: 'value not in options' };
      return { col: 'value_text', value: String(value) };
    }
    default:
      return { error: 'unknown type' };
  }
}

const aad = (ticketId, defId) => `custom_field_value:${ticketId}:${defId}`;

// Load the form's bound fields (non-archived defs) with the per-form required
// flag merged on.
async function loadFormFields(client, formId) {
  const r = await client.query(
    `SELECT ff.required,
            d.id AS def_id, d.slug, d.label, d.type, d.options, d.sensitive, d.agent_only
       FROM ticket_form_fields ff
       JOIN custom_field_defs d ON d.id = ff.field_def_id
      WHERE ff.form_id = $1 AND d.archived = FALSE
      ORDER BY ff.sort_order, ff.id`,
    [formId]
  );
  return r.rows;
}

// Validate the submitted values against the form. `input` is
// [{ def_id, value }]. Returns { missing: [slug…], coerced: [{def, col, value}] }.
// Throws { status, error } on a type mismatch. Values for defs not bound to
// the form are ignored (can't be smuggled onto the ticket).
async function validateForForm(client, formId, input, { agentView = false } = {}) {
  let fields = await loadFormFields(client, formId);
  // Submitters never see agent-only fields: they aren't rendered, can't be
  // required of the submitter, and any value smuggled in is dropped.
  if (!agentView) fields = fields.filter((f) => !f.agent_only);
  const provided = new Map();
  for (const it of Array.isArray(input) ? input : []) {
    const id = Number(it && it.def_id);
    if (Number.isInteger(id)) provided.set(id, it.value);
  }
  const missing = [];
  const coerced = [];
  for (const f of fields) {
    const raw = provided.has(f.def_id) ? provided.get(f.def_id) : null;
    const empty = raw == null || raw === '' || (f.type === 'bool' && raw === false);
    if (f.required && empty) {
      // bool required means "must be true" (e.g. an acknowledgement checkbox).
      if (f.type !== 'bool' || raw !== true) { missing.push(f.slug); continue; }
    }
    if (raw == null || raw === '') continue;
    const c = coerceValue(raw, f);
    if (c.error) {
      const err = new Error(`${f.slug}: ${c.error}`);
      err.status = 400;
      throw err;
    }
    if (c.col != null) coerced.push({ def: f, col: c.col, value: c.value });
  }
  return { missing, coerced };
}

// Persist coerced values for a ticket. Sensitive text defs are encrypted into
// value_text_enc when encryption mode is on; otherwise stored plaintext (UI
// still masks). Call inside the ticket-create transaction.
async function writeValues(client, ticketId, coerced) {
  if (!coerced || !coerced.length) return;
  const mode = await getMode(client);
  for (const { def, col, value } of coerced) {
    const cols = { value_text: null, value_number: null, value_date: null, value_bool: null, value_text_enc: null };
    if (def.sensitive && col === 'value_text' && mode && mode !== 'off') {
      cols.value_text_enc = await encrypt(value, aad(ticketId, def.def_id));
    } else {
      cols[col] = value;
    }
    await client.query(
      `INSERT INTO custom_field_values
         (def_id, ticket_id, value_text, value_number, value_date, value_bool, value_text_enc)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (def_id, ticket_id) WHERE ticket_id IS NOT NULL DO UPDATE SET
         value_text = EXCLUDED.value_text, value_number = EXCLUDED.value_number,
         value_date = EXCLUDED.value_date, value_bool = EXCLUDED.value_bool,
         value_text_enc = EXCLUDED.value_text_enc, updated_at = NOW()`,
      [def.def_id, ticketId, cols.value_text, cols.value_number, cols.value_date, cols.value_bool, cols.value_text_enc]
    );
  }
}

// Read a ticket's custom-field values for display. Decrypts sensitive values.
// `reveal` controls whether sensitive plaintext is returned or masked.
async function readValues(client, ticketId, { reveal = false } = {}) {
  const r = await client.query(
    `SELECT d.id AS def_id, d.slug, d.label, d.type, d.sensitive,
            v.value_text, v.value_number, v.value_date, v.value_bool, v.value_text_enc
       FROM custom_field_values v
       JOIN custom_field_defs d ON d.id = v.def_id
      WHERE v.ticket_id = $1
      ORDER BY d.sort_order, d.id`,
    [ticketId]
  );
  const out = [];
  for (const row of r.rows) {
    let value = null;
    if (row.value_text_enc) {
      if (reveal) {
        try { value = await decrypt(row.value_text_enc, aad(ticketId, row.def_id)); }
        catch { value = null; }
      } else {
        value = '••••••';
      }
    } else if (row.type === 'number') value = row.value_number;
    else if (row.type === 'date') value = row.value_date;
    else if (row.type === 'bool') value = row.value_bool;
    else value = row.sensitive && !reveal ? '••••••' : row.value_text;
    out.push({ def_id: row.def_id, slug: row.slug, label: row.label, type: row.type, sensitive: row.sensitive, value });
  }
  return out;
}

// Agent-side edit of an existing ticket's custom fields (incl. agent-only).
// `input` is [{ def_id, value }]; only defs bound to the ticket's form are
// honored. Empty value clears the field. Returns the list of changed slugs.
async function applyTicketPatch(client, ticketId, formId, input) {
  const fields = await loadFormFields(client, formId);
  const byId = new Map(fields.map((f) => [f.def_id, f]));
  const toWrite = [];
  const toClear = [];
  const changed = [];
  for (const it of Array.isArray(input) ? input : []) {
    const def = byId.get(Number(it && it.def_id));
    if (!def) continue; // not bound to this ticket's form — ignore
    const c = coerceValue(it.value, def);
    if (c.error) { const e = new Error(`${def.slug}: ${c.error}`); e.status = 400; throw e; }
    if (c.col == null) toClear.push(def); else toWrite.push({ def, col: c.col, value: c.value });
    changed.push(def.slug);
  }
  if (toWrite.length) await writeValues(client, ticketId, toWrite);
  for (const def of toClear) {
    await client.query(`DELETE FROM custom_field_values WHERE ticket_id = $1 AND def_id = $2`, [ticketId, def.def_id]);
  }
  return changed;
}

module.exports = { validateForForm, writeValues, readValues, loadFormFields, applyTicketPatch, coerceValue };

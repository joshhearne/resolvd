// Mode-aware field encryption for route handlers.
//
// Phase 2 cutover: when encryption_settings.mode === 'standard', writes go
// to *_enc shadow columns and the plaintext column is NULLed. Reads prefer
// *_enc and fall back to plaintext (handles rows from before backfill or
// rows touched while mode was 'off').
//
// AAD context is `<table>.<col>` only — not row id. Reasoning: we want
// INSERTs to be a single statement (id is unknown until RETURNING), and
// in-DB write access already implies the attacker can overwrite plaintext,
// so binding to the column prevents the only realistic gain (cross-column
// substitution within a row).
//
// The mode is cached for 30s to avoid a settings lookup on every request.

const { encrypt, decrypt } = require('./crypto');

const CACHE_TTL_MS = 30_000;
let cachedMode = null;
let cachedAt = 0;

async function getMode(client) {
  const now = Date.now();
  if (cachedMode && (now - cachedAt) < CACHE_TTL_MS) return cachedMode;
  const r = await client.query('SELECT mode FROM encryption_settings WHERE id = 1');
  cachedMode = r.rows[0]?.mode || 'off';
  cachedAt = now;
  return cachedMode;
}

function invalidateModeCache() {
  cachedMode = null;
  cachedAt = 0;
}

// FIELD_MAP[table][plainCol] = encCol. Drives both write encryption and
// row-level decryption when responding to clients.
const FIELD_MAP = {
  tickets: {
    title: 'title_enc',
    description: 'description_enc',
    review_note: 'review_note_enc',
    mot_blocker_note: 'mot_blocker_note_enc',
  },
  comments: {
    body: 'body_enc',
  },
  audit_log: {
    old_value: 'old_value_enc',
    new_value: 'new_value_enc',
    note: 'note_enc',
  },
  attachments: {
    original_name: 'original_name_enc',
  },
  companies: {
    name: 'name_enc',
    notes: 'notes_enc',
  },
  contacts: {
    name: 'name_enc',
    email: 'email_enc',
    phone: 'phone_enc',
    notes: 'notes_enc',
  },
};

// Build a column/value patch for a write. `plainObj` carries the human-
// readable values keyed by plaintext column name. Returns:
//   { cols: [...], values: [...] }
// suitable for splicing into INSERT or UPDATE statements. Encrypted mode
// emits _enc columns with the plaintext column explicitly set to NULL so
// stale data can't linger after a flip.
async function buildWritePatch(client, table, plainObj) {
  const map = FIELD_MAP[table];
  if (!map) throw new Error(`No encryption map for table ${table}`);
  const mode = await getMode(client);

  const cols = [];
  const values = [];

  for (const [plainCol, value] of Object.entries(plainObj)) {
    const encCol = map[plainCol];
    if (!encCol) {
      // Not a sensitive field — pass through unchanged.
      cols.push(plainCol);
      values.push(value);
      continue;
    }
    if (mode === 'off' || value == null) {
      cols.push(plainCol); values.push(value ?? null);
      cols.push(encCol);   values.push(null);
    } else {
      const ctx = `${table}.${plainCol}`;
      const blob = await encrypt(value, ctx);
      cols.push(plainCol); values.push(null);
      cols.push(encCol);   values.push(blob);
    }
  }

  return { cols, values };
}

// Decrypt sensitive fields on a single row in place. Aliased columns
// (e.g. `bt.title as blocking_ticket_title`) are not handled here — the
// caller passes an alias map for those.
async function decryptRow(table, row, opts = {}) {
  if (!row) return row;
  const map = FIELD_MAP[table];
  if (!map) return row;

  for (const [plainCol, encCol] of Object.entries(map)) {
    if (row[encCol]) {
      try {
        row[plainCol] = await decrypt(row[encCol], `${table}.${plainCol}`);
      } catch (err) {
        // Surface decryption failures as null rather than 500 — likely
        // means the master key was rotated without backfill, or the row
        // was written under a different KEK that's no longer reachable.
        console.error(`decryptRow: failed ${table}.${plainCol}:`, err.message);
        row[plainCol] = null;
      }
      delete row[encCol];
    } else if (encCol in row) {
      // Strip the bytea payload from the response either way.
      delete row[encCol];
    }
  }

  // Optional alias mapping: { aliasOnRow: 'tickets.title' }
  if (opts.aliases) {
    for (const [alias, source] of Object.entries(opts.aliases)) {
      const [aliasTable, aliasCol] = source.split('.');
      const encAlias = `${alias}_enc`;
      if (row[encAlias]) {
        try {
          row[alias] = await decrypt(row[encAlias], `${aliasTable}.${aliasCol}`);
        } catch (err) {
          console.error(`decryptRow alias: failed ${alias}:`, err.message);
          row[alias] = null;
        }
        delete row[encAlias];
      }
    }
  }

  return row;
}

async function decryptRows(table, rows, opts = {}) {
  if (!Array.isArray(rows)) return rows;
  for (const row of rows) await decryptRow(table, row, opts);
  return rows;
}

module.exports = {
  getMode,
  invalidateModeCache,
  buildWritePatch,
  decryptRow,
  decryptRows,
  FIELD_MAP,
};

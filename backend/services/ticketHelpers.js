const { buildWritePatch } = require('./fields');

// Insert a row into audit_log. Caller passes the pg client so writes
// participate in their transaction. `note` is sensitive (encrypted under
// standard mode); `old_value`/`new_value` likewise — done via
// buildWritePatch which handles per-field encryption transparently.
async function auditLog(client, { ticketId, userId, action, oldValue, newValue, note }) {
  const patch = await buildWritePatch(client, 'audit_log', {
    old_value: oldValue ?? null,
    new_value: newValue ?? null,
    note: note ?? null,
  });
  const cols = ['ticket_id', 'user_id', 'action', ...patch.cols];
  const values = [ticketId || null, userId || null, action, ...patch.values];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  await client.query(
    `INSERT INTO audit_log (${cols.join(', ')}) VALUES (${placeholders})`,
    values
  );
}

// System comment: internal-only, no user_id (system actor). Body encrypts
// under standard mode via buildWritePatch.
async function systemComment(client, ticketId, body) {
  const patch = await buildWritePatch(client, 'comments', { body });
  const cols = ['ticket_id', 'user_id', 'is_internal', 'is_system', ...patch.cols];
  const values = [ticketId, null, true, true, ...patch.values];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  await client.query(
    `INSERT INTO comments (${cols.join(', ')}) VALUES (${placeholders})`,
    values
  );
}

module.exports = { auditLog, systemComment };

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

const GLOBAL_HANDLER_ROLES = new Set(['Admin', 'Manager', 'Tech']);

// "Handler" on a ticket = anyone the notes middleware would let through:
// global Admin/Manager/Tech, or a project_members row with a handler
// role_override, or is_agent=TRUE. Centralised so other routes that
// gate the same capability (vendor-visible comments, etc.) match the
// notes endpoint exactly.
async function isProjectHandler(client, { userId, role, projectId }) {
  if (GLOBAL_HANDLER_ROLES.has(role)) return true;
  if (!projectId || !userId) return false;
  const m = await client.query(
    'SELECT role_override, is_agent FROM project_members WHERE project_id = $1 AND user_id = $2',
    [projectId, userId]
  );
  const row = m.rows[0];
  if (!row) return false;
  return row.is_agent === true || GLOBAL_HANDLER_ROLES.has(row.role_override);
}

module.exports = { auditLog, systemComment, isProjectHandler, GLOBAL_HANDLER_ROLES };

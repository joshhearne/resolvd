// Ticket visibility scope — single source of truth for "which tickets
// can this user see?" across the ticket grid, ticket detail, dashboard
// and follow endpoints.
//
// Rules:
//   - Admin / Manager (global role): every ticket.
//   - Everyone else: tickets in projects where they have *full* project
//     visibility, PLUS tickets they submitted, PLUS tickets they follow.
//   - Full project visibility = a project_members row whose effective
//     role is not 'Submitter'. Effective role resolves as:
//       is_agent=TRUE → handler (full), else role_override, else the
//       user's global role.
//     So a global Submitter only sees the whole board of a project when
//     an Admin explicitly elevates them there (role_override Tech/etc. or
//     is_agent), and a global Tech/Viewer downgraded to Submitter on a
//     project is restricted on that project only.
//
// Submitter-scoped users therefore see their own submissions + tickets
// they were added to as a follower, never the rest of the project board
// (issues #101 / #102).

const { pool } = require('../db/pool');

const UNRESTRICTED_ROLES = new Set(['Admin', 'Manager']);
const RESTRICTED_EFFECTIVE_ROLE = 'Submitter';

// Pure: derive the full-visibility project list from membership rows.
// Exported for unit tests.
function fullProjectIdsFromMemberships(globalRole, memberships) {
  const out = [];
  for (const m of memberships || []) {
    if (m.is_agent === true) { out.push(m.project_id); continue; }
    const effective = m.role_override || globalRole;
    if (effective !== RESTRICTED_EFFECTIVE_ROLE) out.push(m.project_id);
  }
  return out;
}

// Returns { unrestricted: true } or
//         { unrestricted: false, userId, fullProjectIds: int[] }.
async function getTicketScope(user, client = pool) {
  if (!user) return { unrestricted: false, userId: null, fullProjectIds: [] };
  if (UNRESTRICTED_ROLES.has(user.role)) return { unrestricted: true };
  const r = await client.query(
    'SELECT project_id, role_override, is_agent FROM project_members WHERE user_id = $1',
    [user.id]
  );
  return {
    unrestricted: false,
    userId: user.id,
    fullProjectIds: fullProjectIdsFromMemberships(user.role, r.rows),
  };
}

// Build a SQL predicate restricting `${alias}` (a tickets alias) to the
// scope. `startIndex` is the next free $n placeholder. Returns
// { sql, params } — sql is 'TRUE' for unrestricted scopes.
function scopeClause(scope, alias = 't', startIndex = 1) {
  if (scope.unrestricted) return { sql: 'TRUE', params: [] };
  const a = startIndex;
  const b = startIndex + 1;
  return {
    sql: `(${alias}.project_id = ANY($${a}::int[])
       OR ${alias}.submitted_by = $${b}
       OR EXISTS (SELECT 1 FROM ticket_followers tf_scope
                   WHERE tf_scope.ticket_id = ${alias}.id AND tf_scope.user_id = $${b}))`,
    params: [scope.fullProjectIds, scope.userId],
  };
}

// Can `user` view a single ticket? Accepts either a ticket id or a row
// with { id, project_id, submitted_by }.
async function canViewTicket(user, ticketOrId, client = pool) {
  const scope = await getTicketScope(user, client);
  if (scope.unrestricted) return true;
  let t = ticketOrId;
  if (typeof ticketOrId !== 'object' || ticketOrId === null) {
    const r = await client.query(
      'SELECT id, project_id, submitted_by FROM tickets WHERE id = $1',
      [Number(ticketOrId)]
    );
    t = r.rows[0];
    if (!t) return false;
  }
  if (scope.fullProjectIds.includes(t.project_id)) return true;
  if (t.submitted_by === scope.userId) return true;
  const f = await client.query(
    'SELECT 1 FROM ticket_followers WHERE ticket_id = $1 AND user_id = $2',
    [t.id, scope.userId]
  );
  return f.rows.length > 0;
}

// A user whose global role is Submitter gets the curated "my tickets"
// dashboard rather than the team dashboard, independent of any project
// elevation (issue #102).
function isSubmitterRole(user) {
  return user?.role === RESTRICTED_EFFECTIVE_ROLE;
}

// Express middleware: 404 when the caller can't see the ticket named by
// req.params[param]. 404 (not 403) so ticket ids can't be probed.
// Non-numeric params pass through so literal sub-routes (/bulk, /counts)
// keep working when this is mounted on a param pattern.
function requireTicketVisible(param = 'id') {
  return async (req, res, next) => {
    // Unauthenticated: let the route's own requireAuth answer 401.
    if (!req.session?.user) return next();
    const raw = req.params[param];
    if (!/^\d+$/.test(String(raw || ''))) return next();
    try {
      const ok = await canViewTicket(req.session.user, Number(raw));
      if (!ok) return res.status(404).json({ error: 'Ticket not found' });
      next();
    } catch (err) {
      console.error('ticket visibility check:', err);
      res.status(500).json({ error: 'Database error' });
    }
  };
}

module.exports = {
  getTicketScope,
  scopeClause,
  canViewTicket,
  isSubmitterRole,
  requireTicketVisible,
  fullProjectIdsFromMemberships,
};

// Auto-assignment by (priority, project) at ticket create time.
//
// Strategy contract:
//   round_robin  — cycle through agent_pool by index; cursor on the
//                  policy row advances atomically via UPDATE…RETURNING
//                  so concurrent ticket inserts don't double-pick the
//                  same agent.
//   case_load    — among agent_pool, return the user with the fewest
//                  currently open tickets (resolved_at IS NULL AND
//                  status not 'Closed' / 'Resolved' tags). Ties break
//                  by user_id ascending.
//   specific_user — return specific_user_id; agent_pool ignored.
// enabled=FALSE on the row short-circuits — caller falls back to the
// project default_assignee_id.

const { pool } = require('../db/pool');

// Resolution rules with priority operators:
//   1. Project-scoped row beats org-default. If a project row matches,
//      org defaults are ignored entirely.
//   2. Within the chosen scope, exact ('=') match beats range
//      operators. Two range matches break ties by recency (created_at
//      DESC) so an admin's latest edit wins.
// The CASE expression below maps operators to a numeric specificity
// rank so PostgreSQL's ORDER BY can pick deterministically.
async function policyForTicket(client, priority, projectId) {
  const db = client || pool;
  const opMatch = `(
    (priority_op = '=' AND priority = $1) OR
    (priority_op = '<' AND $1 < priority) OR
    (priority_op = '>' AND $1 > priority) OR
    (priority_op = '<=' AND $1 <= priority) OR
    (priority_op = '>=' AND $1 >= priority)
  )`;
  const orderBy = `CASE priority_op WHEN '=' THEN 0 ELSE 1 END, created_at DESC`;

  if (projectId) {
    const r = await db.query(
      `SELECT * FROM assignment_policies
        WHERE project_id = $2 AND enabled = TRUE AND ${opMatch}
        ORDER BY ${orderBy}
        LIMIT 1`,
      [priority, projectId]
    );
    if (r.rows[0]) return r.rows[0];
  }
  const def = await db.query(
    `SELECT * FROM assignment_policies
      WHERE project_id IS NULL AND enabled = TRUE AND ${opMatch}
      ORDER BY ${orderBy}
      LIMIT 1`,
    [priority]
  );
  return def.rows[0] || null;
}

// Pick an assignee per the policy's strategy. Returns user_id or null
// when no candidate can be found (empty pool / inactive users / etc.).
// MUST be called inside a transaction for round_robin to be atomic
// (the UPDATE…RETURNING moves the cursor under the row's lock).
async function pickAssignee(client, policy) {
  if (!policy || !policy.enabled) return null;

  if (policy.strategy === 'specific_user') {
    if (!policy.specific_user_id) return null;
    const r = await (client || pool).query(
      `SELECT id FROM users WHERE id = $1 AND status = 'active'`,
      [policy.specific_user_id]
    );
    return r.rows[0]?.id || null;
  }

  const pool_ = Array.isArray(policy.agent_pool) ? policy.agent_pool : [];
  if (!pool_.length) return null;
  // Filter to active users; preserve order for round_robin.
  const active = await (client || pool).query(
    `SELECT id FROM users WHERE id = ANY($1::int[]) AND status = 'active'`,
    [pool_]
  );
  const activeIds = new Set(active.rows.map((r) => r.id));
  const orderedActive = pool_.filter((id) => activeIds.has(id));
  if (!orderedActive.length) return null;

  if (policy.strategy === 'round_robin') {
    // Atomic cursor increment: UPDATE…RETURNING the post-increment value
    // serializes concurrent picks against the same policy row.
    const r = await (client || pool).query(
      `UPDATE assignment_policies
          SET round_robin_cursor = round_robin_cursor + 1,
              updated_at = NOW()
        WHERE id = $1
       RETURNING round_robin_cursor`,
      [policy.id]
    );
    const cursor = r.rows[0].round_robin_cursor;
    // Use cursor-1 so the first ever pick lands on index 0.
    const idx = ((cursor - 1) % orderedActive.length + orderedActive.length) % orderedActive.length;
    return orderedActive[idx];
  }

  if (policy.strategy === 'case_load') {
    // Open ticket count per candidate. Open = resolved_at IS NULL AND
    // not closed by status semantic_tag. Ties broken by user_id ASC.
    const r = await (client || pool).query(
      `WITH counts AS (
         SELECT u.id AS user_id,
           COUNT(t.id) FILTER (
             WHERE t.assigned_to = u.id
               AND t.resolved_at IS NULL
               AND COALESCE(s.semantic_tag, '') NOT IN ('closed')
           )::int AS open_count
         FROM users u
         LEFT JOIN tickets t ON t.assigned_to = u.id
         LEFT JOIN statuses s ON s.name = t.status
         WHERE u.id = ANY($1::int[])
         GROUP BY u.id
       )
       SELECT user_id FROM counts
        ORDER BY open_count ASC, user_id ASC
        LIMIT 1`,
      [orderedActive]
    );
    return r.rows[0]?.user_id || null;
  }

  return null;
}

// One-shot helper: resolve policy + pick assignee in one call. Used by
// the ticket create handler.
async function applyOnCreate(client, { priority, projectId }) {
  const policy = await policyForTicket(client, priority, projectId);
  if (!policy) return null;
  return await pickAssignee(client, policy);
}

module.exports = { policyForTicket, pickAssignee, applyOnCreate };

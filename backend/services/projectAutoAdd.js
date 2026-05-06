// Auto-add new users to projects flagged with auto_add_new_users=TRUE.
// Called from any path that activates a user — SSO first login, invite
// acceptance, etc. ON CONFLICT DO NOTHING keeps re-runs idempotent so
// hooking the helper at multiple boundaries is harmless.

const { pool } = require('../db/pool');

async function autoAddUserToFlaggedProjects(userId, client = pool) {
  if (!userId) return 0;
  const r = await client.query(
    `SELECT id FROM projects WHERE auto_add_new_users = TRUE AND status = 'active'`
  );
  let added = 0;
  for (const row of r.rows) {
    const ins = await client.query(
      `INSERT INTO project_members (project_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (project_id, user_id) DO NOTHING
       RETURNING id`,
      [row.id, userId]
    );
    if (ins.rows[0]) added++;
  }
  return added;
}

module.exports = { autoAddUserToFlaggedProjects };

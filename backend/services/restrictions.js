// Resolves project-level mention/follower scope rules against the org-wide
// defaults stored in `branding`. A NULL on the project means "inherit", a
// boolean is an explicit per-project override.

const { pool } = require('../db/pool');

async function getRestrictionDefaults(client = pool) {
  const r = await client.query(
    `SELECT default_restrict_followers, default_restrict_mentions FROM branding WHERE id = 1`
  );
  const row = r.rows[0] || {};
  return {
    followers: row.default_restrict_followers !== false,
    mentions: row.default_restrict_mentions !== false,
  };
}

function effectiveFlag(projectFlag, defaultFlag) {
  return projectFlag === null || projectFlag === undefined ? defaultFlag : !!projectFlag;
}

// Loads the project's raw flags + the org defaults, returns both forms.
// Caller can use `effective.*` for enforcement and `raw.*` for UI.
async function getProjectRestrictions(projectId, client = pool) {
  const p = await client.query(
    `SELECT restrict_followers_to_members, restrict_mentions_to_members
       FROM projects WHERE id = $1`,
    [projectId]
  );
  const row = p.rows[0] || {};
  const def = await getRestrictionDefaults(client);
  return {
    raw: {
      followers: row.restrict_followers_to_members,
      mentions: row.restrict_mentions_to_members,
    },
    effective: {
      followers: effectiveFlag(row.restrict_followers_to_members, def.followers),
      mentions: effectiveFlag(row.restrict_mentions_to_members, def.mentions),
    },
    defaults: def,
  };
}

module.exports = { getRestrictionDefaults, effectiveFlag, getProjectRestrictions };

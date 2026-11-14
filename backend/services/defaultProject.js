// Default project resolution: a user's own users.default_project_id wins;
// otherwise the org-wide branding.default_project_id (set by an Admin,
// e.g. Incident). Only active projects count. Callers still check that
// the user can access the project (the New Ticket form only offers
// projects the user can see, so an inaccessible default is skipped).

const { pool } = require('../db/pool');

async function orgDefaultProjectId(client = pool) {
  const r = await client.query(
    `SELECT b.default_project_id
       FROM branding b
       JOIN projects p ON p.id = b.default_project_id AND p.status = 'active'
      WHERE b.id = 1`
  );
  return r.rows[0]?.default_project_id ?? null;
}

// { own, org, effective } for a user's stored default (may be null).
async function resolveDefaultProject(ownDefaultProjectId, client = pool) {
  const org = await orgDefaultProjectId(client);
  const own = ownDefaultProjectId ?? null;
  return { own, org, effective: own ?? org };
}

module.exports = { orgDefaultProjectId, resolveDefaultProject };

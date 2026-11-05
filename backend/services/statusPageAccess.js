// Who can see a status page.
//
//   1. Admin / Manager: every page (they curate them).
//   2. Staff-only page (is_public = false): Admin / Manager / Tech only.
//   3. Project-limited page (status_page_projects rows): the viewer must
//      be a member of at least one of those projects. Applies on top of
//      rule 2, so a Tech outside the project doesn't see it either.
//
// Used by routes/statusPages.js (list, detail, subscribe) and the
// subscription notifier, so a subscriber who loses access stops getting
// emails.

const { pool } = require('../db/pool');

const ALWAYS = new Set(['Admin', 'Manager']);
const STAFF = new Set(['Admin', 'Manager', 'Tech']);

// Pure. viewer: { role, memberProjectIds: int[] }
//       page:   { is_public, project_ids: int[] }
function canViewPage(viewer, page) {
  if (!viewer) return false;
  if (ALWAYS.has(viewer.role)) return true;
  if (page.is_public === false && !STAFF.has(viewer.role)) return false;
  const limit = page.project_ids || [];
  if (limit.length) {
    const mine = new Set(viewer.memberProjectIds || []);
    if (!limit.some((id) => mine.has(id))) return false;
  }
  return true;
}

async function memberProjectIds(userId, client = pool) {
  const r = await client.query('SELECT project_id FROM project_members WHERE user_id = $1', [userId]);
  return r.rows.map((x) => x.project_id);
}

// Session user → viewer for canViewPage (one membership query).
async function viewerFor(user, client = pool) {
  if (!user) return null;
  if (ALWAYS.has(user.role)) return { role: user.role, memberProjectIds: [] };
  return { role: user.role, memberProjectIds: await memberProjectIds(user.id, client) };
}

// { pageId: [projectId, ...] } for the given pages.
async function pageProjectIds(pageIds, client = pool) {
  const out = new Map(pageIds.map((id) => [id, []]));
  if (!pageIds.length) return out;
  const r = await client.query(
    `SELECT page_id, project_id FROM status_page_projects WHERE page_id = ANY($1::int[]) ORDER BY project_id`,
    [pageIds]
  );
  for (const row of r.rows) out.get(row.page_id)?.push(row.project_id);
  return out;
}

module.exports = { canViewPage, viewerFor, memberProjectIds, pageProjectIds };

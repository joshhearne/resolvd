// Replace Resolvd's built-in KB with Bothy.
//
// The local articles were exported to Bothy with external_id
// `resolvd:kb:<local id>` (backend/scripts/export-kb-to-bothy.js), and a
// runbook's steps carry ids equal to the first 8 hex of the BlockNote
// block id they came from. So every local row has a deterministic twin:
//   kb_articles.id            -> Bothy article with that external_id
//   step_states["<block id>"] -> step "<block id without dashes>[0:8]"
//
// plan() reports matches without changing anything. apply() copies
// ticket_kb_links into ticket_bothy_links, re-keys runbook runs onto the
// Bothy runbook, archives the local articles, and switches the local KB
// off. Local rows are kept for rollback.

const { pool } = require('../db/pool');
const bothy = require('./bothy');

function httpError(status, message) { const e = new Error(message); e.httpStatus = status; return e; }

const stepIdFromBlock = (blockId) => String(blockId || '').replace(/-/g, '').slice(0, 8).toLowerCase();

// external_id -> Bothy article, across every mapped collection.
async function bothyIndex() {
  const s = await bothy.getSettings();
  if (!s.enabled) throw httpError(503, 'Bothy is not configured');
  const ids = [...s.internal_collection_ids, ...s.public_collection_ids];
  const index = new Map();
  for (const cid of ids) {
    let rows = [];
    try { rows = await bothy.listArticles({ collectionId: cid, max: 2000 }); }
    catch (err) { console.warn(`bothyMigration: list ${cid} failed:`, err.message); }
    for (const a of rows) if (a.external_id && !index.has(a.external_id)) index.set(a.external_id, a);
  }
  return index;
}

async function plan() {
  const index = await bothyIndex();
  const arts = await pool.query(`
    SELECT a.id, a.slug, a.title, a.kind, a.status, a.agent_only, p.name AS project,
           (SELECT COUNT(*) FROM ticket_kb_links l WHERE l.article_id = a.id)::int AS links,
           (SELECT COUNT(*) FROM ticket_runbook_runs r WHERE r.article_id = a.id)::int AS runs
      FROM kb_articles a JOIN projects p ON p.id = a.project_id
     ORDER BY a.id`);
  const rows = arts.rows.map((a) => {
    const twin = index.get(`resolvd:kb:${a.id}`) || null;
    return {
      local_id: a.id, title: a.title, kind: a.kind, status: a.status, agent_only: a.agent_only, project: a.project,
      links: a.links, runs: a.runs,
      bothy_article_id: twin?.article_id || null,
      bothy_collection: twin?.collection_name || null,
      bothy_kind: twin?.kind || null,
      match: twin ? (twin.kind === a.kind ? 'ok' : 'kind_mismatch') : 'missing',
    };
  });
  // Runbook step coverage: every block id in step_states must map to a step on the twin.
  const runs = await pool.query(`SELECT r.id, r.ticket_id, r.article_id, r.step_states FROM ticket_runbook_runs r WHERE r.article_id IS NOT NULL AND r.bothy_article_id IS NULL`);
  const stepsCache = new Map();
  const runRows = [];
  for (const r of runs.rows) {
    const row = rows.find((x) => x.local_id === r.article_id);
    let covered = null;
    if (row?.bothy_article_id) {
      if (!stepsCache.has(row.bothy_article_id)) {
        try { stepsCache.set(row.bothy_article_id, new Set(((await bothy.getArticle(row.bothy_article_id, { handler: true })).steps || []).map((st) => st.id))); }
        catch { stepsCache.set(row.bothy_article_id, new Set()); }
      }
      const ids = stepsCache.get(row.bothy_article_id);
      const keys = Object.keys(r.step_states || {});
      covered = { total: keys.length, matched: keys.filter((k) => ids.has(stepIdFromBlock(k))).length };
    }
    runRows.push({ run_id: r.id, ticket_id: r.ticket_id, local_id: r.article_id, bothy_article_id: row?.bothy_article_id || null, steps: covered });
  }
  const s = await bothy.getSettings();
  return {
    local_kb_enabled: s.local_kb_enabled,
    articles: rows,
    links_total: rows.reduce((n, r) => n + r.links, 0),
    links_movable: rows.filter((r) => r.bothy_article_id).reduce((n, r) => n + r.links, 0),
    runs: runRows,
    runs_movable: runRows.filter((r) => r.bothy_article_id).length,
    missing: rows.filter((r) => r.match === 'missing').length,
    already_migrated: (await pool.query(`SELECT COUNT(*)::int AS n FROM ticket_bothy_links WHERE kind = 'system' AND created_by IS NULL`)).rows[0].n,
  };
}

async function apply({ userId }) {
  const p = await plan();
  const movable = p.articles.filter((a) => a.bothy_article_id);
  const client = await pool.connect();
  const out = { links_copied: 0, runs_moved: 0, runs_steps_dropped: 0, articles_archived: 0, skipped_missing: p.missing };
  try {
    await client.query('BEGIN');
    for (const a of movable) {
      // Ticket links: copy, keep the original kind, mark created_by null so a
      // migrated row is recognisable (the UI shows the twin's snapshot).
      const links = await client.query(`SELECT ticket_id, kind, created_at FROM ticket_kb_links WHERE article_id = $1`, [a.local_id]);
      for (const l of links.rows) {
        const r = await client.query(
          `INSERT INTO ticket_bothy_links (ticket_id, article_id, title, collection_id, collection_name, kind, created_by, created_at)
           SELECT $1, $2, $3, NULL, $4, $5, NULL, $6
           ON CONFLICT (ticket_id, article_id) DO NOTHING`,
          [l.ticket_id, a.bothy_article_id, a.title, a.bothy_collection, l.kind, l.created_at]
        );
        out.links_copied += r.rowCount;
      }
      // Runbook runs: re-key block ids to step ids, point at the twin.
      if (a.kind === 'runbook') {
        const twin = await bothy.getArticle(a.bothy_article_id, { handler: true });
        const stepIds = new Set((twin.steps || []).map((st) => st.id));
        const runs = await client.query(`SELECT id, step_states FROM ticket_runbook_runs WHERE article_id = $1 AND bothy_article_id IS NULL`, [a.local_id]);
        for (const run of runs.rows) {
          const next = {};
          for (const [blockId, state] of Object.entries(run.step_states || {})) {
            const sid = stepIdFromBlock(blockId);
            if (stepIds.has(sid)) next[sid] = state; else out.runs_steps_dropped += 1;
          }
          await client.query(
            `UPDATE ticket_runbook_runs SET bothy_article_id = $1, bothy_title = $2, step_states = $3::jsonb, article_id = NULL WHERE id = $4`,
            [a.bothy_article_id, twin.title, JSON.stringify(next), run.id]
          );
          out.runs_moved += 1;
        }
      }
      const arch = await client.query(`UPDATE kb_articles SET status = 'archived', updated_at = NOW() WHERE id = $1 AND status <> 'archived'`, [a.local_id]);
      out.articles_archived += arch.rowCount;
    }
    await client.query(`UPDATE bothy_settings SET local_kb_enabled = FALSE, updated_at = NOW() WHERE id = 1`);
    await client.query(
      `INSERT INTO audit_log (ticket_id, user_id, action, note) VALUES (NULL, $1, 'kb.migrated_to_bothy', $2)`,
      [userId, JSON.stringify(out)]
    ).catch(() => {});
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  bothy.invalidateCache();
  return out;
}

module.exports = { plan, apply, stepIdFromBlock };

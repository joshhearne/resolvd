// Nightly refresh of the Trove KB snapshots Resolvd keeps for display when
// Trove KB is unreachable: ticket_trove_kb_links.title/collection_name and
// ticket_runbook_runs.trove_kb_title. One article read per distinct id,
// through the service cache. First run ten minutes after boot, then daily.
//
// Single-process design like the other schedulers here.

const { pool } = require('../db/pool');
const troveKb = require('./troveKb');

const FIRST_DELAY_MS = 10 * 60 * 1000;
const INTERVAL_MS = 24 * 60 * 60 * 1000;

async function refreshSnapshots() {
  const settings = await troveKb.getSettings();
  if (!settings.enabled) return { skipped: 'disabled' };
  const ids = await pool.query(`
    SELECT article_id AS id FROM ticket_trove_kb_links
    UNION
    SELECT trove_kb_article_id FROM ticket_runbook_runs WHERE trove_kb_article_id IS NOT NULL`);
  let updated = 0; let missing = 0;
  for (const row of ids.rows) {
    let a;
    try { a = await troveKb.getArticle(row.id, { handler: true }); }
    catch (err) { if (err.httpStatus === 404) missing += 1; continue; }
    const r1 = await pool.query(
      `UPDATE ticket_trove_kb_links SET title = $2, collection_id = $3, collection_name = $4
        WHERE article_id = $1 AND (title IS DISTINCT FROM $2 OR collection_name IS DISTINCT FROM $4)`,
      [a.article_id, a.title, a.collection_id, a.collection_name]);
    const r2 = await pool.query(
      `UPDATE ticket_runbook_runs SET trove_kb_title = $2 WHERE trove_kb_article_id = $1 AND trove_kb_title IS DISTINCT FROM $2`,
      [a.article_id, a.title]);
    updated += r1.rowCount + r2.rowCount;
  }
  await pool.query(`UPDATE trove_kb_settings SET snapshots_refreshed_at = NOW() WHERE id = 1`);
  troveKb.invalidateCache();
  return { articles: ids.rows.length, updated, missing };
}

let timer = null;
function startScheduler() {
  if (timer) return;
  const tick = async () => {
    try {
      const r = await refreshSnapshots();
      if (!r.skipped) console.log(`troveKb snapshots: ${r.articles} articles, ${r.updated} rows updated, ${r.missing} missing`);
    } catch (err) { console.warn('troveKb snapshots:', err.message); }
  };
  setTimeout(() => { tick(); timer = setInterval(tick, INTERVAL_MS); if (timer.unref) timer.unref(); }, FIRST_DELAY_MS).unref?.();
}

module.exports = { startScheduler, refreshSnapshots };

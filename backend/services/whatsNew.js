// "What's new" roll-up. Every user-visible change ships as a small file in
// backend/changes/ (see the README there). The files travel inside the
// backend image, so on boot the running build compares them with what the
// database has already seen: anything new becomes a release, and the
// people it concerns get a bell notification and a pop-up.
//
// Audience: Admin / Manager / Tech see every entry; everyone else sees only
// entries marked `audience: everyone`.
//
// A rollback boots an older image that lacks the newest files. Those
// entries are dropped again (with their releases and notifications), so
// the pop-up never describes a build that isn't running.

const fs = require('fs');
const path = require('path');
const { pool } = require('../db/pool');

const CHANGES_DIR = path.join(__dirname, '..', 'changes');
const STAFF_ROLES = ['Admin', 'Manager', 'Tech'];
const KINDS = ['feature', 'improvement', 'fix'];

const KIND_ALIASES = {
  feature: 'feature', feat: 'feature', added: 'feature', new: 'feature',
  improvement: 'improvement', improved: 'improvement', changed: 'improvement', enhancement: 'improvement',
  fix: 'fix', fixed: 'fix', bugfix: 'fix', bug: 'fix',
};
const AUDIENCE_ALIASES = {
  everyone: 'everyone', all: 'everyone', users: 'everyone', submitters: 'everyone',
  staff: 'staff', techs: 'staff', agents: 'staff', handlers: 'staff',
};

const MAX_ITEM_LEN = 500;
const MAX_ITEMS = 20;

function isStaff(role) {
  return STAFF_ROLES.includes(role);
}

// Parse one change file:
//
//   ---
//   type: feature          # feature | improvement | fix
//   audience: everyone     # everyone | staff (default: staff)
//   ---
//   Holidays can span several days, or close early.
//
// The body is one bullet, or several when written as a "- " list.
// Returns null when the file isn't a usable entry.
function parseChange(id, text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text || ''));
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z_]+)\s*:\s*([^#]*)/.exec(line);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().toLowerCase();
  }
  const kind = KIND_ALIASES[meta.type || meta.kind];
  if (!kind) return null;
  const audience = AUDIENCE_ALIASES[meta.audience] || 'staff';

  const items = [];
  let para = [];
  const flush = () => {
    if (para.length) items.push(para.join(' '));
    para = [];
  };
  for (const raw of m[2].split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) { flush(); para.push(bullet[1]); } else para.push(line);
  }
  flush();
  const clean = items
    .map((s) => s.trim().slice(0, MAX_ITEM_LEN))
    .filter(Boolean)
    .slice(0, MAX_ITEMS);
  if (!clean.length) return null;
  return { id: String(id).slice(0, 200), kind, audience, items: clean };
}

function loadChanges(dir = CHANGES_DIR) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.md') || name.toLowerCase() === 'readme.md') continue;
    const id = name.slice(0, -3);
    const entry = parseChange(id, fs.readFileSync(path.join(dir, name), 'utf8'));
    if (entry) out.push(entry);
    else console.warn(`[whats-new] skipping ${name}: needs a type (feature / improvement / fix) and a body`);
  }
  return out;
}

function summarize(entries) {
  const n = { feature: 0, improvement: 0, fix: 0 };
  for (const e of entries) n[e.kind] += e.items.length;
  const parts = [];
  if (n.feature) parts.push(`${n.feature} new feature${n.feature === 1 ? '' : 's'}`);
  if (n.improvement) parts.push(`${n.improvement} improvement${n.improvement === 1 ? '' : 's'}`);
  if (n.fix) parts.push(`${n.fix} fix${n.fix === 1 ? '' : 'es'}`);
  return parts.join(', ');
}

// Bring the database in line with the change files in this build. Called
// once on boot, after the schema is ready.
async function syncChanges({ entries = loadChanges(), version, commit } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('resolvd:whats-new'))`);

    const known = await client.query('SELECT id FROM change_entries');
    const knownIds = new Set(known.rows.map((r) => r.id));
    const fileIds = new Set(entries.map((e) => e.id));

    // Entries this build doesn't have (a rollback): forget them, and any
    // release (plus its notifications) left with nothing in it.
    const gone = [...knownIds].filter((id) => !fileIds.has(id));
    if (gone.length) {
      await client.query('DELETE FROM change_entries WHERE id = ANY($1)', [gone]);
      const empty = await client.query(
        `DELETE FROM change_releases r
          WHERE NOT EXISTS (SELECT 1 FROM change_entries e WHERE e.release_id = r.id)
          RETURNING id`,
      );
      const emptyIds = empty.rows.map((r) => r.id);
      if (emptyIds.length) {
        await client.query(
          `DELETE FROM notifications
            WHERE type = 'system_update' AND (data->>'release_id')::int = ANY($1)`,
          [emptyIds],
        );
      }
    }

    // Wording fixes to entries that already shipped.
    for (const e of entries.filter((x) => knownIds.has(x.id))) {
      await client.query(
        'UPDATE change_entries SET kind = $2, audience = $3, items = $4 WHERE id = $1',
        [e.id, e.kind, e.audience, JSON.stringify(e.items)],
      );
    }

    const fresh = entries.filter((e) => !knownIds.has(e.id));
    let releaseId = null;
    if (fresh.length) {
      const r = await client.query(
        'INSERT INTO change_releases (version, commit) VALUES ($1, $2) RETURNING id',
        [version || null, commit || null],
      );
      releaseId = r.rows[0].id;
      for (const e of fresh) {
        await client.query(
          `INSERT INTO change_entries (id, release_id, kind, audience, items)
           VALUES ($1, $2, $3, $4, $5)`,
          [e.id, releaseId, e.kind, e.audience, JSON.stringify(e.items)],
        );
      }

      // Bell notification for everyone the release has something for.
      // Accounts created from now on don't get it (see visibleReleases).
      const label = version && version !== 'dev' ? version : 'a new build';
      const everyone = fresh.filter((e) => e.audience === 'everyone');
      const audiences = [
        { roles: STAFF_ROLES, include: true, list: fresh },
        { roles: STAFF_ROLES, include: false, list: everyone },
      ];
      for (const a of audiences) {
        if (!a.list.length) continue;
        await client.query(
          `INSERT INTO notifications (user_id, type, title, body, data)
           SELECT id, 'system_update', $1, $2, $3
             FROM users
            WHERE status = 'active' AND (role = ANY($4)) = $5`,
          [
            `Resolvd was updated to ${label}`,
            `${summarize(a.list)}. Click to see what's changed.`,
            JSON.stringify({ release_id: releaseId }),
            a.roles,
            a.include,
          ],
        );
      }
    }

    await client.query('COMMIT');
    return { added: fresh.length, removed: gone.length, releaseId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Releases with at least one entry this user may see, newest first.
//   unseen: only releases since the user last closed the pop-up (and
//           deployed after their account was created)
//   releaseId: just that release
async function visibleReleases(userId, { unseen = false, releaseId = null, limit = 20 } = {}) {
  const u = await pool.query(
    'SELECT role, created_at, whats_new_seen_release_id FROM users WHERE id = $1',
    [userId],
  );
  const user = u.rows[0];
  if (!user) return [];
  const params = [isStaff(user.role), limit];
  const where = [`(e.audience = 'everyone' OR $1)`];
  if (unseen) {
    params.push(user.whats_new_seen_release_id || 0, user.created_at || new Date(0));
    where.push(`r.id > $${params.length - 1}`, `r.deployed_at > $${params.length}`);
  }
  if (releaseId != null) {
    params.push(releaseId);
    where.push(`r.id = $${params.length}`);
  }
  const r = await pool.query(
    `SELECT r.id, r.version, r.deployed_at,
            json_agg(json_build_object('id', e.id, 'kind', e.kind, 'audience', e.audience, 'items', e.items)
                     ORDER BY e.id) AS entries
       FROM change_releases r
       JOIN change_entries e ON e.release_id = r.id
      WHERE ${where.join(' AND ')}
      GROUP BY r.id
      ORDER BY r.id DESC
      LIMIT $2`,
    params,
  );
  return r.rows;
}

// The user closed the pop-up (or opened a release from the bell): stop
// showing releases up to this one, and clear their bell entries.
async function markSeen(userId, releaseId) {
  await pool.query(
    `UPDATE users SET whats_new_seen_release_id = GREATEST(COALESCE(whats_new_seen_release_id, 0), $2)
      WHERE id = $1`,
    [userId, releaseId],
  );
  await pool.query(
    `UPDATE notifications SET read_at = NOW()
      WHERE user_id = $1 AND type = 'system_update' AND read_at IS NULL
        AND (data->>'release_id')::int <= $2`,
    [userId, releaseId],
  );
}

module.exports = {
  CHANGES_DIR,
  KINDS,
  isStaff,
  parseChange,
  loadChanges,
  summarize,
  syncChanges,
  visibleReleases,
  markSeen,
};

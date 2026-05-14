const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const EDIT_ROLES = ['Admin', 'Manager', 'Tech'];

function canEdit(role) {
  return EDIT_ROLES.includes(role);
}

// Project access: Admin sees all; everyone else must be a member.
async function userCanReadProject(user, projectId) {
  if (user.role === 'Admin') return true;
  const r = await pool.query(
    'SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2 LIMIT 1',
    [projectId, user.id]
  );
  return r.rowCount > 0;
}

// BlockNote stores content as an array of block objects. Walk it and
// flatten any text-bearing leaves so we can index/search over plain text.
function extractText(blocks) {
  if (!Array.isArray(blocks)) return '';
  const out = [];
  const walk = (node) => {
    if (!node) return;
    if (typeof node === 'string') { out.push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node === 'object') {
      if (typeof node.text === 'string') out.push(node.text);
      if (node.content) walk(node.content);
      if (node.children) walk(node.children);
    }
  };
  walk(blocks);
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

async function uniqueSlug(projectId, base, excludeId = null) {
  let slug = base;
  let n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const params = [projectId, slug];
    let sql = 'SELECT id FROM kb_articles WHERE project_id = $1 AND slug = $2';
    if (excludeId) { params.push(excludeId); sql += ' AND id <> $3'; }
    const r = await pool.query(sql, params);
    if (r.rowCount === 0) return slug;
    n += 1;
    slug = `${base}-${n}`;
  }
}

// GET /api/kb/projects — projects the caller can browse for KB.
router.get('/projects', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const sql = user.role === 'Admin'
      ? `SELECT p.id, p.name, p.prefix,
                (SELECT COUNT(*) FROM kb_articles a
                  WHERE a.project_id = p.id AND a.status <> 'archived')::int AS article_count
           FROM projects p
          WHERE p.status = 'active'
          ORDER BY p.name`
      : `SELECT p.id, p.name, p.prefix,
                (SELECT COUNT(*) FROM kb_articles a
                  WHERE a.project_id = p.id AND a.status <> 'archived')::int AS article_count
           FROM projects p
           JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1
          WHERE p.status = 'active'
          ORDER BY p.name`;
    const r = await pool.query(sql, user.role === 'Admin' ? [] : [user.id]);
    res.json(r.rows);
  } catch (err) {
    console.error('kb projects list:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/kb/projects/:projectId/articles — list (optional ?q=, ?status=)
router.get('/projects/:projectId/articles', requireAuth, async (req, res) => {
  try {
    const projectId = Number(req.params.projectId);
    if (!Number.isFinite(projectId)) return res.status(400).json({ error: 'Bad project id' });
    if (!(await userCanReadProject(req.session.user, projectId))) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { q, status } = req.query;
    const params = [projectId];
    const where = ['a.project_id = $1'];
    if (status && ['draft','published','archived'].includes(status)) {
      params.push(status); where.push(`a.status = $${params.length}`);
    } else {
      where.push(`a.status <> 'archived'`);
    }
    if (q && String(q).trim()) {
      params.push(`%${String(q).trim().toLowerCase()}%`);
      where.push(`(LOWER(a.title) LIKE $${params.length} OR LOWER(a.content_text) LIKE $${params.length})`);
    }
    const r = await pool.query(
      `SELECT a.id, a.project_id, a.slug, a.title, a.status, a.updated_at, a.published_at,
              a.view_count,
              u.display_name AS last_edited_by_name,
              LEFT(a.content_text, 240) AS excerpt
         FROM kb_articles a
         LEFT JOIN users u ON u.id = a.last_edited_by
        WHERE ${where.join(' AND ')}
        ORDER BY (a.status = 'published') DESC, a.updated_at DESC`,
      params
    );
    res.json(r.rows);
  } catch (err) {
    console.error('kb list articles:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/kb/projects/:projectId/articles/:slug — read by slug
router.get('/projects/:projectId/articles/:slug', requireAuth, async (req, res) => {
  try {
    const projectId = Number(req.params.projectId);
    if (!Number.isFinite(projectId)) return res.status(400).json({ error: 'Bad project id' });
    if (!(await userCanReadProject(req.session.user, projectId))) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const r = await pool.query(
      `SELECT a.*,
              au.display_name AS author_name,
              eu.display_name AS last_edited_by_name
         FROM kb_articles a
         LEFT JOIN users au ON au.id = a.author_id
         LEFT JOIN users eu ON eu.id = a.last_edited_by
        WHERE a.project_id = $1 AND a.slug = $2`,
      [projectId, req.params.slug]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    // bump view count (best-effort, don't block response)
    pool.query('UPDATE kb_articles SET view_count = view_count + 1 WHERE id = $1', [r.rows[0].id]).catch(() => {});
    res.json(r.rows[0]);
  } catch (err) {
    console.error('kb get article:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/kb/projects/:projectId/articles — create
router.post('/projects/:projectId/articles', requireAuth, async (req, res) => {
  const user = req.session.user;
  if (!canEdit(user.role)) return res.status(403).json({ error: 'Forbidden' });
  const projectId = Number(req.params.projectId);
  if (!Number.isFinite(projectId)) return res.status(400).json({ error: 'Bad project id' });
  if (!(await userCanReadProject(user, projectId))) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { title, slug: slugIn, content_json, status } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'title required' });
  const blocks = Array.isArray(content_json) ? content_json : [];
  const slugBase = slugify(slugIn || title);
  const slug = await uniqueSlug(projectId, slugBase);
  const text = extractText(blocks);
  const st = ['draft','published','archived'].includes(status) ? status : 'draft';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO kb_articles (project_id, slug, title, content_json, content_text, status, author_id, last_edited_by, published_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7, CASE WHEN $6 = 'published' THEN NOW() ELSE NULL END)
       RETURNING *`,
      [projectId, slug, String(title).trim(), JSON.stringify(blocks), text, st, user.id]
    );
    const art = ins.rows[0];
    await client.query(
      `INSERT INTO kb_article_versions (article_id, version_no, title, content_json, content_text, author_id, change_summary)
       VALUES ($1, 1, $2, $3, $4, $5, 'Initial version')`,
      [art.id, art.title, JSON.stringify(blocks), text, user.id]
    );
    await client.query('COMMIT');
    res.status(201).json(art);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Slug already in use' });
    console.error('kb create:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    client.release();
  }
});

// PATCH /api/kb/articles/:id — update (title, slug, content, status)
router.patch('/articles/:id', requireAuth, async (req, res) => {
  const user = req.session.user;
  if (!canEdit(user.role)) return res.status(403).json({ error: 'Forbidden' });
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });

  const cur = await pool.query('SELECT * FROM kb_articles WHERE id = $1', [id]);
  if (cur.rowCount === 0) return res.status(404).json({ error: 'Not found' });
  const art = cur.rows[0];
  if (!(await userCanReadProject(user, art.project_id))) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { title, slug: slugIn, content_json, status, change_summary } = req.body || {};
  const nextTitle = (title && String(title).trim()) || art.title;
  let nextSlug = art.slug;
  if (slugIn && slugify(slugIn) !== art.slug) {
    nextSlug = await uniqueSlug(art.project_id, slugify(slugIn), art.id);
  }
  const blocks = Array.isArray(content_json) ? content_json : null;
  const nextJson = blocks ? JSON.stringify(blocks) : art.content_json;
  const nextText = blocks ? extractText(blocks) : art.content_text;
  const nextStatus = ['draft','published','archived'].includes(status) ? status : art.status;
  const publishingNow = nextStatus === 'published' && art.status !== 'published';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE kb_articles
          SET title = $1, slug = $2, content_json = $3, content_text = $4,
              status = $5, last_edited_by = $6, updated_at = NOW(),
              published_at = CASE WHEN $7 THEN NOW() ELSE published_at END
        WHERE id = $8
        RETURNING *`,
      [nextTitle, nextSlug, nextJson, nextText, nextStatus, user.id, publishingNow, art.id]
    );
    const nextArt = upd.rows[0];
    // Snapshot version only if content/title actually changed.
    if (blocks || nextTitle !== art.title) {
      const vNo = await client.query(
        'SELECT COALESCE(MAX(version_no),0) + 1 AS n FROM kb_article_versions WHERE article_id = $1',
        [art.id]
      );
      await client.query(
        `INSERT INTO kb_article_versions (article_id, version_no, title, content_json, content_text, author_id, change_summary)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [art.id, vNo.rows[0].n, nextTitle, nextJson, nextText, user.id, change_summary || null]
      );
    }
    await client.query('COMMIT');
    res.json(nextArt);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Slug already in use' });
    console.error('kb update:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    client.release();
  }
});

// DELETE /api/kb/articles/:id — soft delete (archive). Admin/Manager hard-delete via ?hard=1.
router.delete('/articles/:id', requireAuth, async (req, res) => {
  const user = req.session.user;
  if (!canEdit(user.role)) return res.status(403).json({ error: 'Forbidden' });
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });

  const cur = await pool.query('SELECT project_id FROM kb_articles WHERE id = $1', [id]);
  if (cur.rowCount === 0) return res.status(404).json({ error: 'Not found' });
  if (!(await userCanReadProject(user, cur.rows[0].project_id))) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const hard = String(req.query.hard || '') === '1';
  try {
    if (hard) {
      if (!['Admin','Manager'].includes(user.role)) return res.status(403).json({ error: 'Forbidden' });
      await pool.query('DELETE FROM kb_articles WHERE id = $1', [id]);
    } else {
      await pool.query(
        `UPDATE kb_articles SET status = 'archived', updated_at = NOW(), last_edited_by = $1 WHERE id = $2`,
        [user.id, id]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('kb delete:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/kb/articles/:id/versions — version list
router.get('/articles/:id/versions', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
  const cur = await pool.query('SELECT project_id FROM kb_articles WHERE id = $1', [id]);
  if (cur.rowCount === 0) return res.status(404).json({ error: 'Not found' });
  if (!(await userCanReadProject(req.session.user, cur.rows[0].project_id))) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const r = await pool.query(
    `SELECT v.id, v.version_no, v.title, v.change_summary, v.created_at,
            u.display_name AS author_name
       FROM kb_article_versions v
       LEFT JOIN users u ON u.id = v.author_id
      WHERE v.article_id = $1
      ORDER BY v.version_no DESC`,
    [id]
  );
  res.json(r.rows);
});

// GET /api/kb/articles/:id/versions/:n — single version (for diff/preview)
router.get('/articles/:id/versions/:n', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const n = Number(req.params.n);
  if (!Number.isFinite(id) || !Number.isFinite(n)) return res.status(400).json({ error: 'Bad id' });
  const cur = await pool.query('SELECT project_id FROM kb_articles WHERE id = $1', [id]);
  if (cur.rowCount === 0) return res.status(404).json({ error: 'Not found' });
  if (!(await userCanReadProject(req.session.user, cur.rows[0].project_id))) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const r = await pool.query(
    `SELECT v.*, u.display_name AS author_name
       FROM kb_article_versions v
       LEFT JOIN users u ON u.id = v.author_id
      WHERE v.article_id = $1 AND v.version_no = $2`,
    [id, n]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Not found' });
  res.json(r.rows[0]);
});

// POST /api/kb/articles/:id/restore/:n — restore version n
router.post('/articles/:id/restore/:n', requireAuth, async (req, res) => {
  const user = req.session.user;
  if (!canEdit(user.role)) return res.status(403).json({ error: 'Forbidden' });
  const id = Number(req.params.id);
  const n = Number(req.params.n);
  if (!Number.isFinite(id) || !Number.isFinite(n)) return res.status(400).json({ error: 'Bad id' });

  const cur = await pool.query('SELECT project_id FROM kb_articles WHERE id = $1', [id]);
  if (cur.rowCount === 0) return res.status(404).json({ error: 'Not found' });
  if (!(await userCanReadProject(user, cur.rows[0].project_id))) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const v = await client.query(
      'SELECT title, content_json, content_text FROM kb_article_versions WHERE article_id = $1 AND version_no = $2',
      [id, n]
    );
    if (v.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Version not found' }); }
    const { title, content_json, content_text } = v.rows[0];
    const upd = await client.query(
      `UPDATE kb_articles
          SET title = $1, content_json = $2, content_text = $3,
              last_edited_by = $4, updated_at = NOW()
        WHERE id = $5
        RETURNING *`,
      [title, content_json, content_text, user.id, id]
    );
    const vNo = await client.query(
      'SELECT COALESCE(MAX(version_no),0) + 1 AS n FROM kb_article_versions WHERE article_id = $1',
      [id]
    );
    await client.query(
      `INSERT INTO kb_article_versions (article_id, version_no, title, content_json, content_text, author_id, change_summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, vNo.rows[0].n, title, content_json, content_text, user.id, `Restored from v${n}`]
    );
    await client.query('COMMIT');
    res.json(upd.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('kb restore:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    client.release();
  }
});

module.exports = router;

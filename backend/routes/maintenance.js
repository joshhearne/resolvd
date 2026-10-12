// Maintenance windows. Anyone logged in can read them (they appear on
// status pages); Techs and up log and edit them, including the "what
// was done" work notes; Admin / Manager can delete.
//
// While a window covers an item, alerts for that item are recorded but
// not promoted to tickets (see alertIngest.evaluateAndAct); promotion
// is re-checked when the window ends.

const express = require('express');
const { pool, transaction } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const EDITORS = ['Admin', 'Manager', 'Tech'];

const SELECT_WINDOW = `
  SELECT w.*, t.internal_ref AS ticket_ref,
         cu.display_name AS created_by_name, uu.display_name AS updated_by_name,
         p.prefix AS project_prefix, p.name AS project_name,
         COALESCE((
           SELECT JSON_AGG(JSON_BUILD_OBJECT('id', i.id, 'label', i.label, 'detail', i.detail)
                           ORDER BY i.label)
             FROM maintenance_window_items mi
             JOIN alert_monitored_items i ON i.id = mi.item_id
            WHERE mi.window_id = w.id
         ), '[]'::json) AS items,
         COALESCE((
           SELECT JSON_AGG(JSON_BUILD_OBJECT('id', u.id, 'display_name', u.display_name)
                           ORDER BY u.display_name)
             FROM maintenance_window_assignees a
             JOIN users u ON u.id = a.user_id
            WHERE a.window_id = w.id
         ), '[]'::json) AS assignees
    FROM maintenance_windows w
    LEFT JOIN tickets t ON t.id = w.ticket_id
    LEFT JOIN users cu ON cu.id = w.created_by
    LEFT JOIN users uu ON uu.id = w.updated_by
    LEFT JOIN projects p ON p.id = w.project_id
`;

// GET /api/maintenance?scope=active|upcoming|past|all
router.get('/', async (req, res) => {
  const scope = String(req.query.scope || 'all');
  const where = {
    active: 'w.starts_at <= NOW() AND w.ends_at > NOW()',
    upcoming: 'w.starts_at > NOW()',
    past: 'w.ends_at <= NOW()',
    all: 'TRUE',
  }[scope];
  if (!where) return res.status(400).json({ error: 'scope must be active, upcoming, past or all' });
  try {
    const r = await pool.query(
      `${SELECT_WINDOW} WHERE ${where}
        ORDER BY w.starts_at DESC LIMIT 200`
    );
    res.json(r.rows);
  } catch (err) {
    console.error('maintenance list:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `${SELECT_WINDOW} WHERE w.id = $1`,
      [Number(req.params.id)]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Maintenance window not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('maintenance get:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Validate + normalize a create/patch body. Returns { error } or
// { fields, itemIds, ticketRef } where fields only carries keys present.
function parseBody(body, partial) {
  const fields = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  if (!partial || has('title')) {
    const title = String(body.title || '').trim();
    if (!title) return { error: 'title required' };
    if (title.length > 200) return { error: 'title too long (max 200)' };
    fields.title = title;
  }
  for (const k of ['description', 'work_notes']) {
    if (has(k)) {
      const v = body[k] == null ? null : String(body[k]);
      if (v && v.length > 20000) return { error: `${k} too long (max 20000)` };
      fields[k] = v || null;
    }
  }
  for (const k of ['starts_at', 'ends_at']) {
    if (!partial || has(k)) {
      const d = new Date(body[k]);
      if (!body[k] || Number.isNaN(d.getTime())) return { error: `${k} must be a date-time` };
      fields[k] = d.toISOString();
    }
  }
  let itemIds = null;
  if (!partial || has('item_ids')) {
    if (!Array.isArray(body.item_ids)) return { error: 'item_ids array required' };
    itemIds = [...new Set(body.item_ids.map(Number).filter(Number.isInteger))];
  }
  let assigneeIds = null;
  if (has('assignee_ids')) {
    if (!Array.isArray(body.assignee_ids)) return { error: 'assignee_ids must be an array' };
    assigneeIds = [...new Set(body.assignee_ids.map(Number).filter(Number.isInteger))];
  }
  if (has('project_id')) {
    const pid = body.project_id == null || body.project_id === '' ? null : Number(body.project_id);
    if (pid !== null && !Number.isInteger(pid)) return { error: 'project_id must be a project id' };
    fields.project_id = pid;
  }
  const ticketRef = has('ticket_ref') ? String(body.ticket_ref || '').trim() : undefined;
  return { fields, itemIds, assigneeIds, ticketRef };
}

async function resolveTicket(client, ref) {
  if (!ref) return null;
  const r = await client.query(
    `SELECT id FROM tickets WHERE UPPER(internal_ref) = UPPER($1) LIMIT 1`,
    [ref]
  );
  if (!r.rows[0]) {
    const err = new Error(`No ticket ${ref}`);
    err.status = 400;
    throw err;
  }
  return r.rows[0].id;
}

async function setItems(client, windowId, itemIds) {
  await client.query(`DELETE FROM maintenance_window_items WHERE window_id = $1`, [windowId]);
  if (!itemIds.length) return;
  await client.query(
    `INSERT INTO maintenance_window_items (window_id, item_id)
     SELECT $1, i.id FROM alert_monitored_items i WHERE i.id = ANY($2::int[])`,
    [windowId, itemIds]
  );
}

// Only staff can be scheduled on a window. Unknown or ineligible ids
// are an error rather than silently dropped.
async function setAssignees(client, windowId, userIds) {
  if (userIds.length) {
    const ok = await client.query(
      `SELECT id FROM users WHERE id = ANY($1::int[])
          AND role IN ('Admin', 'Manager', 'Tech') AND status = 'active'`,
      [userIds]
    );
    if (ok.rows.length !== userIds.length) {
      const err = new Error('Assignees must be active Admin, Manager or Tech users');
      err.status = 400;
      throw err;
    }
  }
  await client.query(`DELETE FROM maintenance_window_assignees WHERE window_id = $1`, [windowId]);
  if (!userIds.length) return;
  await client.query(
    `INSERT INTO maintenance_window_assignees (window_id, user_id)
     SELECT $1, UNNEST($2::int[])`,
    [windowId, userIds]
  );
}

// The project a window belongs to when none is picked: the first item
// with an effective project (its pin, its service's pin, then the
// integration's default project), the same order alerts use.
async function defaultProjectFor(client, itemIds) {
  if (!itemIds?.length) return null;
  const r = await client.query(
    `SELECT COALESCE(i.project_id, par.project_id, s.default_project_id) AS project_id
       FROM alert_monitored_items i
       LEFT JOIN alert_monitored_items par ON par.id = i.parent_item_id
       JOIN external_alert_source s ON s.id = i.source_id
      WHERE i.id = ANY($1::int[])
        AND COALESCE(i.project_id, par.project_id, s.default_project_id) IS NOT NULL
      ORDER BY ARRAY_POSITION($1::int[], i.id)
      LIMIT 1`,
    [itemIds]
  );
  return r.rows[0]?.project_id ?? null;
}

// Alerts deferred by this window wait for its end. When the window is
// shortened (or its items change), pull their re-check in so the
// scheduler re-evaluates promptly; it re-checks maintenance itself.
async function retimeDeferredAlerts(client, windowId) {
  await client.query(
    `UPDATE alerts a
        SET next_evaluation_at = GREATEST(LEAST(a.next_evaluation_at, w.ends_at), NOW())
       FROM maintenance_windows w
      WHERE w.id = $1
        AND a.state = 'firing' AND a.ticket_id IS NULL
        AND a.next_evaluation_at IS NOT NULL
        AND a.suppression_reason LIKE 'maintenance:' || w.id || ' %'`,
    [windowId]
  );
}

router.post('/', requireRole(...EDITORS), async (req, res) => {
  const parsed = parseBody(req.body || {}, false);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { fields, itemIds, assigneeIds, ticketRef } = parsed;
  if (new Date(fields.ends_at) <= new Date(fields.starts_at)) {
    return res.status(400).json({ error: 'ends_at must be after starts_at' });
  }
  try {
    const id = await transaction(async (client) => {
      const ticketId = await resolveTicket(client, ticketRef);
      const projectId = fields.project_id !== undefined
        ? fields.project_id
        : await defaultProjectFor(client, itemIds);
      const r = await client.query(
        `INSERT INTO maintenance_windows
           (title, description, work_notes, starts_at, ends_at, ticket_id, project_id, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING id`,
        [
          fields.title, fields.description ?? null, fields.work_notes ?? null,
          fields.starts_at, fields.ends_at, ticketId, projectId, req.session.user.id,
        ]
      );
      await setItems(client, r.rows[0].id, itemIds);
      if (assigneeIds) await setAssignees(client, r.rows[0].id, assigneeIds);
      return r.rows[0].id;
    });
    const out = await pool.query(`${SELECT_WINDOW} WHERE w.id = $1`, [id]);
    res.status(201).json(out.rows[0]);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('maintenance create:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.patch('/:id', requireRole(...EDITORS), async (req, res) => {
  const parsed = parseBody(req.body || {}, true);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { fields, itemIds, assigneeIds, ticketRef } = parsed;
  const id = Number(req.params.id);
  try {
    const found = await transaction(async (client) => {
      const cur = await client.query(
        `SELECT starts_at, ends_at FROM maintenance_windows WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (!cur.rows[0]) return false;
      const starts = new Date(fields.starts_at || cur.rows[0].starts_at);
      const ends = new Date(fields.ends_at || cur.rows[0].ends_at);
      if (ends <= starts) {
        const err = new Error('ends_at must be after starts_at');
        err.status = 400;
        throw err;
      }
      const sets = [];
      const vals = [];
      let p = 1;
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${p++}`); vals.push(v);
      }
      if (ticketRef !== undefined) {
        sets.push(`ticket_id = $${p++}`); vals.push(await resolveTicket(client, ticketRef));
      }
      sets.push(`updated_by = $${p++}`); vals.push(req.session.user.id);
      sets.push('updated_at = NOW()');
      vals.push(id);
      await client.query(`UPDATE maintenance_windows SET ${sets.join(', ')} WHERE id = $${p}`, vals);
      if (itemIds) await setItems(client, id, itemIds);
      if (assigneeIds) await setAssignees(client, id, assigneeIds);
      await retimeDeferredAlerts(client, id);
      return true;
    });
    if (!found) return res.status(404).json({ error: 'Maintenance window not found' });
    const out = await pool.query(`${SELECT_WINDOW} WHERE w.id = $1`, [id]);
    res.json(out.rows[0]);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('maintenance patch:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.delete('/:id', requireRole('Admin', 'Manager'), async (req, res) => {
  const id = Number(req.params.id);
  try {
    const found = await transaction(async (client) => {
      // Shorten to now first so deferred alerts get re-checked, then drop.
      const r = await client.query(
        `UPDATE maintenance_windows SET ends_at = GREATEST(NOW(), starts_at + INTERVAL '1 second')
          WHERE id = $1 RETURNING id`,
        [id]
      );
      if (!r.rows[0]) return false;
      await retimeDeferredAlerts(client, id);
      await client.query(`DELETE FROM maintenance_windows WHERE id = $1`, [id]);
      return true;
    });
    if (!found) return res.status(404).json({ error: 'Maintenance window not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('maintenance delete:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

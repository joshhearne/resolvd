// Personal tasks. Each row belongs to one user (owner_user_id) — there
// is no project- or admin-scoped browsing here; routes filter to the
// caller's own list. Recurrence shares the preset/cron compiler with
// services/ticketSchedules so admins authoring both feel one consistent
// model.
//
// Endpoints:
//   GET    /api/tasks                — caller's list (status filter, due window)
//   POST   /api/tasks                — create
//   PATCH  /api/tasks/:id            — edit (title/body/project/recurrence/etc.)
//   POST   /api/tasks/:id/complete   — mark one occurrence done
//   POST   /api/tasks/:id/skip       — advance recurring task without completion
//   POST   /api/tasks/:id/reschedule — bump next_due_at to a chosen time
//   DELETE /api/tasks/:id            — delete (owner only)

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { buildWritePatch, decryptRows } = require('../services/fields');
const sched = require('../services/ticketSchedules');

const router = express.Router();

function clampPriority(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

// Normalise the caller's recurrence shape into the columns we persist.
// For 'once' we just take due_at verbatim; for 'preset'/'cron' we use
// the shared cron helpers from ticketSchedules so the maths matches the
// scheduled-ticket world. Returns { fields: {...}, error?: string }.
function normaliseRecurrence(b) {
  const tz = b.timezone && typeof b.timezone === 'string' ? b.timezone : 'UTC';
  const endKind = ['never', 'count', 'date'].includes(b.end_kind) ? b.end_kind : 'never';
  const endCount = endKind === 'count' && Number.isFinite(Number(b.end_count))
    ? Math.max(1, Math.trunc(Number(b.end_count))) : null;
  const endDate = endKind === 'date' && b.end_date ? new Date(b.end_date) : null;

  if (b.recurrence_kind === 'once' || !b.recurrence_kind) {
    const due = b.due_at ? new Date(b.due_at) : null;
    return {
      fields: {
        recurrence_kind: 'once',
        cron_expr: null, preset_kind: null, preset_config: null,
        timezone: tz,
        end_kind: 'never', end_count: null, end_date: null,
        next_due_at: due,
      },
    };
  }
  if (b.recurrence_kind === 'preset' || b.recurrence_kind === 'cron') {
    let cron;
    try {
      cron = sched.normaliseToCron(b);
    } catch (e) {
      return { error: e.message };
    }
    const next = sched.computeNextFire(cron, tz, new Date(), { endKind, endDate });
    return {
      fields: {
        recurrence_kind: b.recurrence_kind,
        cron_expr: cron,
        preset_kind: b.recurrence_kind === 'preset' ? (b.preset_kind || null) : null,
        preset_config: b.recurrence_kind === 'preset' && b.preset_config
          ? JSON.stringify(b.preset_config) : null,
        timezone: tz,
        end_kind: endKind, end_count: endCount, end_date: endDate,
        next_due_at: next,
      },
    };
  }
  return { error: 'recurrence_kind must be once | preset | cron' };
}

// GET /api/tasks?status=pending&overdue_only=1
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const where = ['owner_user_id = $1'];
    const params = [userId];
    if (req.query.status) {
      params.push(String(req.query.status));
      where.push(`status = $${params.length}`);
    }
    if (req.query.overdue_only === '1') {
      where.push(`next_due_at IS NOT NULL AND next_due_at <= NOW()`);
    }
    const r = await pool.query(
      `SELECT t.id, t.owner_user_id, t.project_id, t.ticket_id,
              t.title, t.title_enc, t.body, t.body_enc,
              t.status, t.recurrence_kind, t.cron_expr, t.preset_kind, t.preset_config,
              t.timezone, t.end_kind, t.end_count, t.end_date,
              t.fires_count, t.next_due_at, t.last_completed_at, t.completed_at,
              t.cancelled_at, t.created_at, t.updated_at,
              tk.internal_ref AS ticket_ref, tk.title AS ticket_title, tk.title_enc AS ticket_title_enc
         FROM tasks t
         LEFT JOIN tickets tk ON tk.id = t.ticket_id
        WHERE ${where.join(' AND ')}
        ORDER BY
          CASE WHEN t.status = 'pending' THEN 0 ELSE 1 END,
          t.next_due_at ASC NULLS LAST,
          t.id DESC`,
      params
    );
    await decryptRows('tasks', r.rows);
    // Decrypt the joined ticket title via a second pass — the
    // decryptRows helper only handles columns named per FIELD_MAP,
    // so the aliased ticket_title_enc gets unpacked by hand.
    for (const row of r.rows) {
      if (row.ticket_title_enc && !row.ticket_title) {
        try {
          const { decrypt } = require('../services/crypto');
          row.ticket_title = await decrypt(row.ticket_title_enc, `tickets.title`);
        } catch { /* leave null */ }
      }
      delete row.ticket_title_enc;
    }
    res.json(r.rows);
  } catch (err) {
    console.error('tasks list:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.get('/:id(\\d+)', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const id = Number(req.params.id);
    const r = await pool.query(
      `SELECT * FROM tasks WHERE id = $1 AND owner_user_id = $2`,
      [id, userId]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    await decryptRows('tasks', r.rows);
    const cmps = await pool.query(
      `SELECT id, completed_at, completed_by, note
         FROM task_completions WHERE task_id = $1
        ORDER BY completed_at DESC LIMIT 50`,
      [id]
    );
    res.json({ ...r.rows[0], completions: cmps.rows });
  } catch (err) {
    console.error('task get:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const title = String(b.title || '').trim();
    if (!title) return res.status(400).json({ error: 'title required' });
    const userId = req.session.user.id;

    const rec = normaliseRecurrence(b);
    if (rec.error) return res.status(400).json({ error: rec.error });

    const sensitive = await buildWritePatch(pool, 'tasks', {
      title,
      body: b.body ? String(b.body) : null,
    });

    const baseCols = [
      'owner_user_id', 'project_id', 'ticket_id', 'status',
      'recurrence_kind', 'cron_expr', 'preset_kind', 'preset_config',
      'timezone', 'end_kind', 'end_count', 'end_date', 'next_due_at',
    ];
    const baseVals = [
      userId,
      b.project_id ? Number(b.project_id) : null,
      b.ticket_id ? Number(b.ticket_id) : null,
      'pending',
      rec.fields.recurrence_kind,
      rec.fields.cron_expr,
      rec.fields.preset_kind,
      rec.fields.preset_config,
      rec.fields.timezone,
      rec.fields.end_kind,
      rec.fields.end_count,
      rec.fields.end_date,
      rec.fields.next_due_at,
    ];
    const cols = [...baseCols, ...sensitive.cols];
    const vals = [...baseVals, ...sensitive.values];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const ins = await pool.query(
      `INSERT INTO tasks (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id, next_due_at`,
      vals
    );
    res.status(201).json(ins.rows[0]);
  } catch (err) {
    console.error('task create:', err);
    res.status(500).json({ error: err.message || 'create failed' });
  }
});

router.patch('/:id(\\d+)', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const id = Number(req.params.id);
    const existing = await pool.query(
      `SELECT * FROM tasks WHERE id = $1 AND owner_user_id = $2`,
      [id, userId]
    );
    if (!existing.rows[0]) return res.status(404).json({ error: 'not found' });
    const row = existing.rows[0];
    const b = req.body || {};

    const sets = [];
    const values = [];
    let p = 1;
    function push(col, val) { sets.push(`${col} = $${p++}`); values.push(val); }

    if (b.project_id !== undefined) push('project_id', b.project_id ? Number(b.project_id) : null);

    const touchesRecurrence = ['recurrence_kind', 'cron_expr', 'preset_kind', 'preset_config',
                               'timezone', 'end_kind', 'end_count', 'end_date', 'due_at'].some((k) => k in b);
    if (touchesRecurrence) {
      const merged = { ...row, ...b };
      const rec = normaliseRecurrence(merged);
      if (rec.error) return res.status(400).json({ error: rec.error });
      for (const [col, val] of Object.entries(rec.fields)) push(col, val);
    }

    if (b.title !== undefined || b.body !== undefined) {
      const sensitive = await buildWritePatch(pool, 'tasks', {
        title: b.title !== undefined ? String(b.title).trim() : row.title,
        body: b.body !== undefined ? (b.body ? String(b.body) : null) : row.body,
      });
      for (let i = 0; i < sensitive.cols.length; i++) push(sensitive.cols[i], sensitive.values[i]);
    }

    if (!sets.length) return res.status(400).json({ error: 'no updatable fields' });
    sets.push(`updated_at = NOW()`);
    values.push(id);
    await pool.query(
      `UPDATE tasks SET ${sets.join(', ')} WHERE id = $${p}`,
      values
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('task patch:', err);
    res.status(500).json({ error: err.message || 'update failed' });
  }
});

// POST /:id/complete — record a completion. For one-off tasks this
// flips status to 'completed'. For recurring tasks it advances
// next_due_at via cron-parser and bumps fires_count; status only
// flips when an end_kind threshold is hit.
router.post('/:id(\\d+)/complete', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const id = Number(req.params.id);
    const r = await pool.query(
      `SELECT * FROM tasks WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
      [id, userId]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    const t = r.rows[0];
    if (t.status !== 'pending') return res.status(409).json({ error: `task already ${t.status}` });

    const now = new Date();
    await pool.query(
      `INSERT INTO task_completions (task_id, completed_by, note)
       VALUES ($1, $2, $3)`,
      [t.id, userId, req.body?.note ? String(req.body.note).slice(0, 1000) : null]
    );

    let nextDue = null;
    let done = false;
    if (t.recurrence_kind === 'once') {
      done = true;
    } else {
      const nextFiresCount = t.fires_count + 1;
      const endCountHit = t.end_kind === 'count' && t.end_count && nextFiresCount >= t.end_count;
      if (endCountHit) {
        done = true;
      } else {
        try {
          nextDue = sched.computeNextFire(t.cron_expr, t.timezone || 'UTC', now, {
            endKind: t.end_kind, endDate: t.end_date,
          });
          if (!nextDue) done = true; // end_date exhausted
        } catch (err) {
          console.error(`task ${t.id} compute next failed:`, err.message);
          done = true;
        }
      }
    }

    await pool.query(
      `UPDATE tasks
          SET fires_count = $1,
              last_completed_at = $2,
              next_due_at = $3,
              status = $4,
              completed_at = $5,
              updated_at = NOW()
        WHERE id = $6`,
      [
        t.fires_count + 1,
        now,
        done ? null : nextDue,
        done ? 'completed' : 'pending',
        done ? now : null,
        t.id,
      ]
    );

    res.json({ ok: true, completed: done, next_due_at: done ? null : nextDue });
  } catch (err) {
    console.error('task complete:', err);
    res.status(500).json({ error: err.message || 'complete failed' });
  }
});

// POST /:id/skip — advance recurring task without recording a
// completion. Useful when the occurrence is irrelevant ("we're closed
// that day, skip this week's cleanup").
router.post('/:id(\\d+)/skip', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const id = Number(req.params.id);
    const r = await pool.query(
      `SELECT * FROM tasks WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
      [id, userId]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    const t = r.rows[0];
    if (t.recurrence_kind === 'once') {
      return res.status(400).json({ error: 'skip only applies to recurring tasks; complete or cancel instead' });
    }
    let nextDue = null;
    try {
      nextDue = sched.computeNextFire(t.cron_expr, t.timezone || 'UTC', new Date(), {
        endKind: t.end_kind, endDate: t.end_date,
      });
    } catch (err) {
      console.error(`task ${t.id} skip compute failed:`, err.message);
    }
    await pool.query(
      `UPDATE tasks SET next_due_at = $1, updated_at = NOW() WHERE id = $2`,
      [nextDue, t.id]
    );
    res.json({ ok: true, next_due_at: nextDue });
  } catch (err) {
    console.error('task skip:', err);
    res.status(500).json({ error: err.message || 'skip failed' });
  }
});

// POST /:id/reschedule  { next_due_at: ISO }
// Bump the due time. Works for both one-off (postpones the only
// occurrence) and recurring (postpones this occurrence only — the
// recurrence keeps its cadence after the next completion).
router.post('/:id(\\d+)/reschedule', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const id = Number(req.params.id);
    const target = req.body?.next_due_at ? new Date(req.body.next_due_at) : null;
    if (!target || isNaN(target.getTime())) {
      return res.status(400).json({ error: 'next_due_at required (ISO datetime)' });
    }
    const r = await pool.query(
      `UPDATE tasks SET next_due_at = $1, updated_at = NOW()
        WHERE id = $2 AND owner_user_id = $3 AND status = 'pending'
        RETURNING id`,
      [target, id, userId]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not found or not pending' });
    res.json({ ok: true, next_due_at: target });
  } catch (err) {
    console.error('task reschedule:', err);
    res.status(500).json({ error: err.message || 'reschedule failed' });
  }
});

router.delete('/:id(\\d+)', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const id = Number(req.params.id);
    await pool.query(`DELETE FROM tasks WHERE id = $1 AND owner_user_id = $2`, [id, userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('task delete:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

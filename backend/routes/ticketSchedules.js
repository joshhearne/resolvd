// Admin/Manager CRUD for recurring ticket templates. Materialisation
// itself runs in services/ticketSchedules.js via the scheduler tick;
// this module is just the REST surface. Preview endpoint renders the
// next N fires without persisting so admins can sanity-check a cron
// expression before they save it.

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { buildWritePatch, decryptRows } = require('../services/fields');
const sched = require('../services/ticketSchedules');

const router = express.Router();
const HANDLERS = ['Admin', 'Manager'];

// GET /api/ticket-schedules — list (active and archived alike; UI
// filters). Joins project + assignee for the table view.
router.get('/', requireAuth, requireRole(...HANDLERS), async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT s.*,
             p.prefix AS project_prefix, p.name AS project_name,
             u.display_name AS assignee_name, u.email AS assignee_email,
             cu.display_name AS created_by_name,
             rb.title AS runbook_title, rb.slug AS runbook_slug
        FROM ticket_schedules s
        JOIN projects p ON p.id = s.project_id
        LEFT JOIN users u ON u.id = s.assigned_to
        LEFT JOIN users cu ON cu.id = s.created_by
        LEFT JOIN kb_articles rb ON rb.id = s.runbook_article_id AND rb.kind = 'runbook'
       ORDER BY s.enabled DESC, s.next_fire_at ASC NULLS LAST, s.id ASC
    `);
    await decryptRows('ticket_schedules', r.rows);
    res.json(r.rows);
  } catch (err) {
    console.error('ticket-schedules list:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.get('/:id(\\d+)', requireAuth, requireRole(...HANDLERS), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM ticket_schedules WHERE id = $1`,
      [Number(req.params.id)]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    await decryptRows('ticket_schedules', r.rows);

    const runs = await pool.query(
      `SELECT id, fired_at, ticket_id, status, error_message
         FROM ticket_schedule_runs
        WHERE schedule_id = $1
        ORDER BY fired_at DESC
        LIMIT 25`,
      [r.rows[0].id]
    );
    res.json({ ...r.rows[0], recent_runs: runs.rows });
  } catch (err) {
    console.error('ticket-schedules get:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/ticket-schedules/preview — no persistence; returns the
// next N fires + a plain-English description so the admin can sanity
// the recurrence before saving.
router.post('/preview', requireAuth, requireRole(...HANDLERS), async (req, res) => {
  try {
    const { recurrence_kind, cron_expr, preset_kind, preset_config,
            timezone = 'UTC', end_kind = 'never', end_date = null } = req.body || {};
    let cron;
    try {
      cron = sched.normaliseToCron({ recurrence_kind, cron_expr, preset_kind, preset_config });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    const out = [];
    let from = new Date();
    for (let i = 0; i < 5; i++) {
      const next = sched.computeNextFire(cron, timezone, from, {
        endKind: end_kind, endDate: end_date,
      });
      if (!next) break;
      out.push(next.toISOString());
      from = next;
    }
    res.json({
      cron_expr: cron,
      timezone,
      description: sched.describeCron(cron),
      next_fires: out,
    });
  } catch (err) {
    console.error('ticket-schedules preview:', err);
    res.status(500).json({ error: err.message || 'preview failed' });
  }
});

router.post('/', requireAuth, requireRole(...HANDLERS), async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    const projectId = Number(b.project_id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ error: 'project_id required' });
    }
    let cron;
    try {
      cron = sched.normaliseToCron(b);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    const tz = b.timezone && typeof b.timezone === 'string' ? b.timezone : 'UTC';
    const endKind = ['never', 'count', 'date'].includes(b.end_kind) ? b.end_kind : 'never';
    const endCount = endKind === 'count' && Number.isFinite(Number(b.end_count))
      ? Math.max(1, Math.trunc(Number(b.end_count))) : null;
    const endDate = endKind === 'date' && b.end_date ? new Date(b.end_date) : null;
    const contactIds = Array.isArray(b.contact_ids)
      ? b.contact_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0)
      : [];
    const followerIds = Array.isArray(b.follower_ids)
      ? b.follower_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0)
      : [];

    const nextFire = sched.computeNextFire(cron, tz, new Date(), {
      endKind, endDate,
    });

    const sensitive = await buildWritePatch(pool, 'ticket_schedules', {
      title: b.title ? String(b.title).trim() : null,
      description: b.description ? String(b.description) : null,
    });
    const baseCols = [
      'name', 'enabled', 'project_id',
      'impact', 'urgency', 'assigned_to', 'requestor_user_id',
      'contact_ids', 'follower_ids', 'runbook_article_id',
      'recurrence_kind', 'cron_expr', 'preset_kind', 'preset_config',
      'timezone', 'end_kind', 'end_count', 'end_date',
      'next_fire_at', 'created_by',
    ];
    const baseVals = [
      name,
      b.enabled !== false,
      projectId,
      Math.max(1, Math.min(3, Number(b.impact) || 2)),
      Math.max(1, Math.min(3, Number(b.urgency) || 2)),
      b.assigned_to ? Number(b.assigned_to) : null,
      b.requestor_user_id ? Number(b.requestor_user_id) : null,
      contactIds,
      followerIds,
      b.runbook_article_id ? Number(b.runbook_article_id) : null,
      b.recurrence_kind === 'cron' ? 'cron' : 'preset',
      cron,
      b.recurrence_kind === 'preset' ? (b.preset_kind || null) : null,
      b.recurrence_kind === 'preset' && b.preset_config ? JSON.stringify(b.preset_config) : null,
      tz, endKind, endCount, endDate,
      nextFire,
      req.session.user.id,
    ];
    const cols = [...baseCols, ...sensitive.cols];
    const vals = [...baseVals, ...sensitive.values];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const ins = await pool.query(
      `INSERT INTO ticket_schedules (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`,
      vals
    );
    res.status(201).json({ id: ins.rows[0].id, next_fire_at: nextFire });
  } catch (err) {
    console.error('ticket-schedules create:', err);
    res.status(500).json({ error: err.message || 'create failed' });
  }
});

router.patch('/:id(\\d+)', requireAuth, requireRole(...HANDLERS), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await pool.query(`SELECT * FROM ticket_schedules WHERE id = $1`, [id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'not found' });
    const row = existing.rows[0];
    const b = req.body || {};

    const sets = [];
    const values = [];
    let p = 1;
    function push(col, val) {
      sets.push(`${col} = $${p++}`);
      values.push(val);
    }

    if (b.name !== undefined) push('name', String(b.name).trim());
    if (b.enabled !== undefined) push('enabled', !!b.enabled);
    if (b.project_id !== undefined) push('project_id', Number(b.project_id));
    if (b.impact !== undefined) push('impact', Math.max(1, Math.min(3, Number(b.impact))));
    if (b.urgency !== undefined) push('urgency', Math.max(1, Math.min(3, Number(b.urgency))));
    if (b.assigned_to !== undefined) push('assigned_to', b.assigned_to ? Number(b.assigned_to) : null);
    if (b.requestor_user_id !== undefined) push('requestor_user_id', b.requestor_user_id ? Number(b.requestor_user_id) : null);
    if (b.contact_ids !== undefined) {
      push('contact_ids', Array.isArray(b.contact_ids)
        ? b.contact_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0)
        : []);
    }
    if (b.follower_ids !== undefined) {
      push('follower_ids', Array.isArray(b.follower_ids)
        ? b.follower_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0)
        : []);
    }
    if (b.runbook_article_id !== undefined) {
      push('runbook_article_id', b.runbook_article_id ? Number(b.runbook_article_id) : null);
    }

    // Recurrence rewrite triggers next_fire_at recompute. We recompute
    // whenever recurrence_kind, cron_expr, preset_*, timezone, or end_*
    // changes — anything that could change the iterator's output.
    const touchesRecurrence = ['recurrence_kind', 'cron_expr', 'preset_kind', 'preset_config',
                               'timezone', 'end_kind', 'end_count', 'end_date'].some((k) => k in b);
    if (touchesRecurrence) {
      const merged = { ...row, ...b };
      let cron;
      try {
        cron = sched.normaliseToCron(merged);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      const tz = merged.timezone || 'UTC';
      const endKind = ['never', 'count', 'date'].includes(merged.end_kind) ? merged.end_kind : 'never';
      const endCount = endKind === 'count' && Number.isFinite(Number(merged.end_count))
        ? Math.max(1, Math.trunc(Number(merged.end_count))) : null;
      const endDate = endKind === 'date' && merged.end_date ? new Date(merged.end_date) : null;
      const nextFire = sched.computeNextFire(cron, tz, new Date(), { endKind, endDate });

      push('recurrence_kind', merged.recurrence_kind === 'cron' ? 'cron' : 'preset');
      push('cron_expr', cron);
      push('preset_kind', merged.recurrence_kind === 'preset' ? (merged.preset_kind || null) : null);
      push('preset_config', merged.recurrence_kind === 'preset' && merged.preset_config
        ? JSON.stringify(merged.preset_config) : null);
      push('timezone', tz);
      push('end_kind', endKind);
      push('end_count', endCount);
      push('end_date', endDate);
      push('next_fire_at', nextFire);
    }

    if (b.title !== undefined || b.description !== undefined) {
      const sensitive = await buildWritePatch(pool, 'ticket_schedules', {
        title: b.title !== undefined ? (b.title ? String(b.title).trim() : null) : row.title,
        description: b.description !== undefined ? (b.description ? String(b.description) : null) : row.description,
      });
      for (let i = 0; i < sensitive.cols.length; i++) {
        push(sensitive.cols[i], sensitive.values[i]);
      }
    }

    if (!sets.length) return res.status(400).json({ error: 'no updatable fields' });
    sets.push(`updated_at = NOW()`);
    values.push(id);
    await pool.query(
      `UPDATE ticket_schedules SET ${sets.join(', ')} WHERE id = $${p}`,
      values
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('ticket-schedules patch:', err);
    res.status(500).json({ error: err.message || 'update failed' });
  }
});

router.delete('/:id(\\d+)', requireAuth, requireRole(...HANDLERS), async (req, res) => {
  try {
    await pool.query(`DELETE FROM ticket_schedules WHERE id = $1`, [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (err) {
    console.error('ticket-schedules delete:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /:id/fire-now — manual one-shot. Doesn't advance next_fire_at
// or fires_count. Useful for testing a freshly authored template.
router.post('/:id(\\d+)/fire-now', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM ticket_schedules WHERE id = $1`, [Number(req.params.id)]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    await decryptRows('ticket_schedules', r.rows);
    const ticketId = await sched.fireSchedule(r.rows[0]);
    await pool.query(
      `INSERT INTO ticket_schedule_runs (schedule_id, fired_at, ticket_id, status, error_message)
       VALUES ($1, NOW(), $2, 'ok', 'manual fire')`,
      [r.rows[0].id, ticketId]
    ).catch(() => {});
    res.json({ ok: true, ticket_id: ticketId });
  } catch (err) {
    console.error('ticket-schedules fire-now:', err);
    res.status(500).json({ error: err.message || 'fire failed' });
  }
});

module.exports = router;

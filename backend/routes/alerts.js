// Alerts API. Distinct from /api/alert-sources (the integrations
// themselves). Lists deduped alert rows with state, lets admins
// promote firing alerts into tickets manually, suppress noisy ones,
// or re-evaluate after a rule change.
//
// Role gate: Admin/Manager/Tech across the board.

const express = require('express');
const { pool, transaction } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { decryptRows, decryptRow } = require('../services/fields');
const { promoteAlertToTicket } = require('../services/alertIngest');

const router = express.Router();
const HANDLERS = ['Admin', 'Manager', 'Tech'];

// GET /api/alerts?state=firing&source_id=&severity_min_rank=&has_ticket=&q=&limit=&offset=
router.get('/', requireAuth, requireRole(...HANDLERS), async (req, res) => {
  try {
    const where = [];
    const params = [];
    if (req.query.state) {
      params.push(req.query.state);
      where.push(`a.state = $${params.length}`);
    }
    if (req.query.source_id) {
      params.push(Number(req.query.source_id));
      where.push(`a.source_id = $${params.length}`);
    }
    if (req.query.severity_min_rank) {
      params.push(Number(req.query.severity_min_rank));
      where.push(`a.severity_rank <= $${params.length}`);
    }
    if (req.query.has_ticket === 'true') where.push(`a.ticket_id IS NOT NULL`);
    if (req.query.has_ticket === 'false') where.push(`a.ticket_id IS NULL`);
    if (req.query.q) {
      params.push(`%${req.query.q.toLowerCase()}%`);
      where.push(`LOWER(COALESCE(a.title, '')) LIKE $${params.length}`);
    }
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 100));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const sql = `
      SELECT a.id, a.source_id, a.external_event_id, a.external_ref, a.state,
             a.severity, a.severity_rank, a.title, a.title_enc,
             a.description, a.description_enc,
             a.user_email, a.vendor_ref,
             a.first_seen_at, a.last_seen_at, a.recovered_at, a.refire_count,
             a.ticket_id, a.promoted_at, a.next_evaluation_at, a.suppression_reason,
             s.name AS source_name, s.preset AS source_preset,
             t.internal_ref AS ticket_ref, t.internal_status AS ticket_status
        FROM alerts a
        JOIN external_alert_source s ON s.id = a.source_id
   LEFT JOIN tickets t ON t.id = a.ticket_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY a.last_seen_at DESC
       LIMIT ${limit} OFFSET ${offset}`;
    const r = await pool.query(sql, params);
    await decryptRows('alerts', r.rows);
    res.json(r.rows);
  } catch (err) {
    console.error('alerts list:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/alerts/:id — single alert with full payload
router.get('/:id', requireAuth, requireRole(...HANDLERS), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT a.*, s.name AS source_name, s.preset AS source_preset,
              t.internal_ref AS ticket_ref, t.internal_status AS ticket_status
         FROM alerts a
         JOIN external_alert_source s ON s.id = a.source_id
    LEFT JOIN tickets t ON t.id = a.ticket_id
        WHERE a.id = $1`,
      [Number(req.params.id)]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Alert not found' });
    await decryptRow('alerts', r.rows[0]);
    res.json(r.rows[0]);
  } catch (err) {
    console.error('alerts get:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/alerts/:id/promote — manual ticket creation. Idempotent.
router.post('/:id/promote', requireAuth, requireRole(...HANDLERS), async (req, res) => {
  try {
    const alertId = Number(req.params.id);
    const out = await transaction(async (client) => {
      const a = await client.query(`SELECT * FROM alerts WHERE id = $1 FOR UPDATE`, [alertId]);
      if (!a.rows[0]) { const err = new Error('Alert not found'); err.http = 404; throw err; }
      const alertRow = a.rows[0];
      await decryptRow('alerts', alertRow);
      if (alertRow.ticket_id) return { ticket_id: alertRow.ticket_id, alreadyLinked: true };
      const s = await client.query(`SELECT * FROM external_alert_source WHERE id = $1`, [alertRow.source_id]);
      if (!s.rows[0]) { const err = new Error('Source missing'); err.http = 404; throw err; }
      await decryptRow('external_alert_source', s.rows[0]);
      const overrides = {
        project_id: req.body?.project_id || undefined,
        assignee_id: req.body?.assignee_id || undefined,
        priority: req.body?.priority || undefined,
      };
      const ticketId = await promoteAlertToTicket(
        client,
        s.rows[0],
        { ...alertRow, event: {} },
        { id: null, name: 'manual', ticket_overrides: overrides },
        req.session.user.id
      );
      return { ticket_id: ticketId, alreadyLinked: false };
    });
    res.status(out.alreadyLinked ? 200 : 201).json(out);
  } catch (err) {
    if (err.http) return res.status(err.http).json({ error: err.message });
    console.error('alerts promote:', err);
    res.status(500).json({ error: err.message || 'Database error' });
  }
});

// POST /api/alerts/:id/suppress — admin marks firing alert as handled
// without creating a ticket. Stores reason for audit.
router.post('/:id/suppress', requireAuth, requireRole(...HANDLERS), async (req, res) => {
  try {
    const reason = String(req.body?.reason || 'manual').slice(0, 200);
    const r = await pool.query(
      `UPDATE alerts SET state = 'suppressed', suppression_reason = $1, next_evaluation_at = NULL
        WHERE id = $2 AND state = 'firing'
        RETURNING id`,
      [reason, Number(req.params.id)]
    );
    if (!r.rows[0]) return res.status(409).json({ error: 'Alert not in firing state' });
    res.json({ ok: true });
  } catch (err) {
    console.error('alerts suppress:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/alerts/bulk
// Body: { ids: [int], action: 'suppress'|'delete'|'recover', reason?: string }
// Returns: { updated: <count>, ids: [<applied ids>] }
//
// suppress — sets state='suppressed' on firing rows. No-op for others.
// recover  — manually mark firing alert as recovered (e.g. cleanup after
//             a vendor told you it's resolved but the source didn't fire
//             a recovery). Triggers external-resolution on linked tickets
//             via the existing handler path.
// delete   — hard delete. Admin-only. Use to clear noisy backfill rows
//            that should never have come in.
router.post('/bulk', requireAuth, requireRole(...HANDLERS), async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
    const action = String(req.body?.action || '');
    if (!ids.length) return res.status(400).json({ error: 'ids array required' });
    if (ids.length > 2000) return res.status(400).json({ error: 'max 2000 ids per call' });
    if (!['suppress', 'delete', 'recover'].includes(action)) {
      return res.status(400).json({ error: 'action must be suppress | delete | recover' });
    }
    if (action === 'delete' && req.session.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Only Admin can bulk-delete alerts' });
    }
    const reason = String(req.body?.reason || `bulk-${action}`).slice(0, 200);

    let updated = 0;
    let appliedIds = [];
    if (action === 'suppress') {
      const r = await pool.query(
        `UPDATE alerts
            SET state = 'suppressed', suppression_reason = $1, next_evaluation_at = NULL
          WHERE id = ANY($2::bigint[]) AND state = 'firing'
          RETURNING id`,
        [reason, ids]
      );
      updated = r.rowCount;
      appliedIds = r.rows.map((x) => x.id);
    } else if (action === 'recover') {
      const r = await pool.query(
        `UPDATE alerts
            SET state = 'recovered', recovered_at = NOW(), last_seen_at = NOW(),
                next_evaluation_at = NULL
          WHERE id = ANY($1::bigint[]) AND state = 'firing'
          RETURNING id`,
        [ids]
      );
      updated = r.rowCount;
      appliedIds = r.rows.map((x) => x.id);
    } else {
      // delete
      const r = await pool.query(
        `DELETE FROM alerts WHERE id = ANY($1::bigint[]) RETURNING id`,
        [ids]
      );
      updated = r.rowCount;
      appliedIds = r.rows.map((x) => x.id);
    }
    res.json({ updated, ids: appliedIds, action });
  } catch (err) {
    console.error('alerts bulk:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

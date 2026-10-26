// SLA admin + dashboard endpoints.
//
// Admin: CRUD for sla_policies. One default row per priority (project_id
// IS NULL) is seeded by the schema migration; admins can edit those, add
// per-project overrides, or delete overrides to fall back to default.
//
// Dashboard: counts + breach lists for at-a-glance SLA health.

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { decryptRows } = require('../services/fields');
const holidays = require('../services/holidays');

const router = express.Router();

// ─── Policies ────────────────────────────────────────────────────────────

// GET /api/sla/policies — list all policies (defaults + overrides).
// Admin/Manager can read; only Admin can mutate.
router.get('/policies', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT s.id, s.priority, s.project_id, p.name AS project_name, p.prefix AS project_prefix,
             s.response_target_minutes, s.resolve_target_minutes,
             s.warning_threshold_percent, s.business_hours_id,
             bh.name AS business_hours_name, bh.tz AS business_hours_tz, bh.enabled AS business_hours_enabled,
             s.created_at, s.updated_at
        FROM sla_policies s
        LEFT JOIN projects p ON p.id = s.project_id
        LEFT JOIN business_hours_policies bh ON bh.id = s.business_hours_id
       ORDER BY s.project_id NULLS FIRST, s.priority
    `);
    res.json(r.rows);
  } catch (err) {
    console.error('sla policies list:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── Business hours ──────────────────────────────────────────────────────

// GET /api/sla/business-hours — list. Admin/Manager read.
router.get('/business-hours', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT b.*, p.name AS project_name, p.prefix AS project_prefix,
             l.name AS location_name,
             COALESCE((
               SELECT json_agg(json_build_object(
                        'id', h.id, 'kind', h.kind, 'date', to_char(h.holiday_date, 'YYYY-MM-DD'),
                        'name', h.name, 'recurring', h.recurring, 'month', h.month,
                        'weekday', h.weekday, 'nth', h.nth, 'observed', h.observed)
                      ORDER BY COALESCE(EXTRACT(MONTH FROM h.holiday_date)::int, h.month), h.id)
                 FROM business_hours_holidays h WHERE h.business_hours_id = b.id
             ), '[]'::json) AS holidays
        FROM business_hours_policies b
        LEFT JOIN projects p ON p.id = b.project_id
        LEFT JOIN locations l ON l.id = b.location_id
       ORDER BY (b.project_id IS NULL AND b.location_id IS NULL) DESC,
                b.project_id NULLS LAST, b.location_id NULLS LAST, b.name
    `);
    // Readable rule + the next date it's taken, judged in the policy's tz.
    for (const b of r.rows) {
      const today = localToday(b.tz);
      b.holidays = b.holidays.map((h) => ({
        ...h,
        rule: holidays.describeRule(h),
        next: holidays.nextOccurrence(h, today),
      }));
    }
    res.json(r.rows);
  } catch (err) {
    console.error('business-hours list:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

function validateBh(body) {
  const { name, project_id, location_id, tz, days, start_time, end_time, enabled } = body || {};
  if (!name || typeof name !== 'string') return 'name required';
  if (project_id != null && (!Number.isInteger(project_id) || project_id <= 0)) return 'project_id must be positive integer or null';
  if (location_id != null && (!Number.isInteger(location_id) || location_id <= 0)) return 'location_id must be positive integer or null';
  if (project_id != null && location_id != null) return 'scope to a project or a location, not both';
  if (!tz || typeof tz !== 'string') return 'tz required (IANA name)';
  if (!Array.isArray(days) || !days.length) return 'days must be a non-empty array (0=Sun..6=Sat)';
  if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return 'days entries must be 0–6';
  if (!/^\d{1,2}:\d{2}$/.test(String(start_time || ''))) return 'start_time must be HH:MM';
  if (!/^\d{1,2}:\d{2}$/.test(String(end_time || ''))) return 'end_time must be HH:MM';
  if (enabled != null && typeof enabled !== 'boolean') return 'enabled must be boolean';
  return null;
}

router.post('/business-hours', requireAuth, requireRole('Admin'), async (req, res) => {
  const err = validateBh(req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { name, project_id, location_id, tz, days, start_time, end_time, enabled } = req.body;
    const r = await pool.query(
      `INSERT INTO business_hours_policies (name, project_id, location_id, tz, days, start_time, end_time, enabled)
       VALUES ($1, $2, $3, $4, $5::int[], $6, $7, COALESCE($8, TRUE))
       RETURNING *`,
      [name.trim(), project_id || null, location_id || null, tz, days, start_time, end_time, enabled]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'business hours already exist for this scope' });
    console.error('business-hours create:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

router.patch('/business-hours/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const body = req.body || {};
    const sets = [];
    const values = [];
    let p = 1;
    for (const k of ['name', 'tz', 'start_time', 'end_time', 'enabled']) {
      if (Object.prototype.hasOwnProperty.call(body, k)) {
        sets.push(`${k} = $${p++}`);
        values.push(body[k]);
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'days')) {
      if (!Array.isArray(body.days) || body.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
        return res.status(400).json({ error: 'days must be array of 0–6 ints' });
      }
      sets.push(`days = $${p++}::int[]`);
      values.push(body.days);
    }
    if (!sets.length) return res.status(400).json({ error: 'no updatable fields supplied' });
    sets.push('updated_at = NOW()');
    values.push(id);
    const r = await pool.query(
      `UPDATE business_hours_policies SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`,
      values
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
  } catch (e) {
    console.error('business-hours patch:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

router.delete('/business-hours/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const r = await pool.query(`SELECT project_id, location_id FROM business_hours_policies WHERE id = $1`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    if (r.rows[0].project_id == null && r.rows[0].location_id == null) {
      return res.status(400).json({ error: 'cannot delete org default; disable it instead' });
    }
    await pool.query(`DELETE FROM business_hours_policies WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('business-hours delete:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── Holidays (closed days on a business-hours policy) ───────────────────

function localToday(tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// POST /api/sla/business-hours/:id/holidays
//   { kind: 'date', date: 'YYYY-MM-DD', recurring?, name?, observed? }
//   { kind: 'nth_weekday', month: 1-12, weekday: 0-6, nth: 1-5 | -1, name?, observed? }
router.post('/business-hours/:id/holidays', requireAuth, requireRole('Admin'), async (req, res) => {
  const b = req.body || {};
  const kind = b.kind || 'date';
  if (!['date', 'nth_weekday'].includes(kind)) return res.status(400).json({ error: "kind must be 'date' or 'nth_weekday'" });
  if (kind === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || '')) || Number.isNaN(Date.parse(`${b.date}T00:00:00Z`)))) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }
  const rule = kind === 'date'
    ? { kind, date: b.date, recurring: !!b.recurring }
    : { kind, month: b.month, weekday: b.weekday, nth: b.nth };
  if (!holidays.validRule(rule)) {
    return res.status(400).json({ error: 'nth_weekday needs month 1–12, weekday 0–6 (Sun–Sat) and nth 1–5 or -1 (last)' });
  }
  for (const k of ['recurring', 'observed']) {
    if (b[k] != null && typeof b[k] !== 'boolean') return res.status(400).json({ error: `${k} must be boolean` });
  }
  try {
    const r = await pool.query(
      `INSERT INTO business_hours_holidays
         (business_hours_id, kind, holiday_date, recurring, month, weekday, nth, observed, name)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9)
       RETURNING id, kind, to_char(holiday_date, 'YYYY-MM-DD') AS date, recurring,
                 month, weekday, nth, observed, name`,
      [
        Number(req.params.id), kind,
        kind === 'date' ? b.date : null,
        kind === 'date' ? !!b.recurring : false,
        kind === 'nth_weekday' ? b.month : null,
        kind === 'nth_weekday' ? b.weekday : null,
        kind === 'nth_weekday' ? b.nth : null,
        !!b.observed,
        b.name ? String(b.name).trim().slice(0, 120) : null,
      ]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'that holiday is already on this schedule' });
    if (e.code === '23503') return res.status(404).json({ error: 'business hours not found' });
    console.error('holiday create:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

router.delete('/business-hours/:id/holidays/:holidayId', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM business_hours_holidays WHERE id = $1 AND business_hours_id = $2`,
      [Number(req.params.holidayId), Number(req.params.id)]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('holiday delete:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── Outbound webhooks (Slack / Teams / PagerDuty / generic) ─────────────

const slaWebhooks = require('../services/slaWebhooks');

const WEBHOOK_COLUMNS = `w.id, w.name, w.kind, w.target_hint, (w.secret_enc IS NOT NULL) AS has_secret,
  w.project_id, p.name AS project_name, p.prefix AS project_prefix,
  w.events, w.max_priority, w.enabled, w.last_sent_at, w.last_ok, w.last_error,
  w.created_at, w.updated_at`;

function validateWebhook(b, { create }) {
  if (create || b.name !== undefined) {
    if (!b.name || typeof b.name !== 'string' || !b.name.trim()) return 'name required';
  }
  if (create && !slaWebhooks.KINDS.includes(b.kind)) return `kind must be one of ${slaWebhooks.KINDS.join(', ')}`;
  if (b.project_id != null && (!Number.isInteger(b.project_id) || b.project_id <= 0)) return 'project_id must be positive integer or null';
  if (b.events !== undefined) {
    if (!Array.isArray(b.events) || !b.events.length || b.events.some((e) => !slaWebhooks.EVENTS.includes(e))) {
      return `events must be a non-empty subset of ${slaWebhooks.EVENTS.join(', ')}`;
    }
  }
  if (b.max_priority !== undefined && (!Number.isInteger(b.max_priority) || b.max_priority < 1 || b.max_priority > 5)) {
    return 'max_priority must be 1–5';
  }
  if (b.enabled !== undefined && typeof b.enabled !== 'boolean') return 'enabled must be boolean';
  return null;
}

async function webhookRow(id) {
  const r = await pool.query(
    `SELECT ${WEBHOOK_COLUMNS} FROM sla_webhooks w LEFT JOIN projects p ON p.id = w.project_id WHERE w.id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

router.get('/webhooks', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${WEBHOOK_COLUMNS} FROM sla_webhooks w LEFT JOIN projects p ON p.id = w.project_id
        ORDER BY w.project_id NULLS FIRST, w.name, w.id`
    );
    res.json(r.rows);
  } catch (e) {
    console.error('sla webhooks list:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST — { name, kind, target, secret?, project_id?, events?, max_priority?, enabled? }
router.post('/webhooks', requireAuth, requireRole('Admin'), async (req, res) => {
  const b = req.body || {};
  const err = validateWebhook(b, { create: true }) || slaWebhooks.validateTarget(b.kind, b.target);
  if (err) return res.status(400).json({ error: err });
  try {
    const targetEnc = await slaWebhooks.sealTarget(b.target);
    const secretEnc = b.kind === 'generic' && b.secret ? await slaWebhooks.sealSecret(b.secret) : null;
    const r = await pool.query(
      `INSERT INTO sla_webhooks (name, kind, target_enc, target_hint, secret_enc, project_id, events, max_priority, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::text[], ARRAY['breach_response','breach_resolve']::text[]),
               COALESCE($8, 5), COALESCE($9, TRUE))
       RETURNING id`,
      [b.name.trim(), b.kind, targetEnc, slaWebhooks.maskTarget(b.kind, b.target.trim()), secretEnc,
       b.project_id || null, b.events || null, b.max_priority ?? null, b.enabled ?? null]
    );
    res.status(201).json(await webhookRow(r.rows[0].id));
  } catch (e) {
    if (e.httpStatus) return res.status(e.httpStatus).json({ error: e.message });
    console.error('sla webhook create:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH — any of the POST fields except kind. target / secret replace the
// stored value when present; secret: '' clears it.
router.patch('/webhooks/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  const b = req.body || {};
  const err = validateWebhook(b, { create: false });
  if (err) return res.status(400).json({ error: err });
  try {
    const cur = await pool.query(`SELECT kind FROM sla_webhooks WHERE id = $1`, [Number(req.params.id)]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'not found' });
    const kind = cur.rows[0].kind;
    const sets = [];
    const values = [];
    const add = (sql, val) => { values.push(val); sets.push(sql.replace('?', `$${values.length}`)); };
    if (b.name !== undefined) add('name = ?', b.name.trim());
    if (b.project_id !== undefined) add('project_id = ?', b.project_id || null);
    if (b.events !== undefined) add('events = ?::text[]', b.events);
    if (b.max_priority !== undefined) add('max_priority = ?', b.max_priority);
    if (b.enabled !== undefined) add('enabled = ?', b.enabled);
    if (b.target !== undefined && String(b.target).trim()) {
      const tErr = slaWebhooks.validateTarget(kind, b.target);
      if (tErr) return res.status(400).json({ error: tErr });
      add('target_enc = ?', await slaWebhooks.sealTarget(b.target));
      add('target_hint = ?', slaWebhooks.maskTarget(kind, String(b.target).trim()));
    }
    if (b.secret !== undefined && kind === 'generic') {
      add('secret_enc = ?', b.secret ? await slaWebhooks.sealSecret(b.secret) : null);
    }
    if (!sets.length) return res.status(400).json({ error: 'no updatable fields supplied' });
    values.push(Number(req.params.id));
    await pool.query(
      `UPDATE sla_webhooks SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${values.length}`,
      values
    );
    res.json(await webhookRow(Number(req.params.id)));
  } catch (e) {
    if (e.httpStatus) return res.status(e.httpStatus).json({ error: e.message });
    console.error('sla webhook patch:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

router.delete('/webhooks/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM sla_webhooks WHERE id = $1`, [Number(req.params.id)]);
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('sla webhook delete:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/sla/webhooks/:id/test — send a sample notification now.
router.post('/webhooks/:id/test', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const result = await slaWebhooks.sendTest(Number(req.params.id));
    if (!result) return res.status(404).json({ error: 'not found' });
    res.json(result);
  } catch (e) {
    console.error('sla webhook test:', e);
    res.status(500).json({ error: e.message || 'Test failed' });
  }
});

// GET /api/sla/webhooks/:id/deliveries — last 25 attempts.
router.get('/webhooks/:id/deliveries', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT d.id, d.event, d.ok, d.http_status, d.error, d.created_at, d.resolved_at,
              d.ticket_id, t.internal_ref AS ticket_ref
         FROM sla_webhook_deliveries d
         LEFT JOIN tickets t ON t.id = d.ticket_id
        WHERE d.webhook_id = $1
        ORDER BY d.created_at DESC LIMIT 25`,
      [Number(req.params.id)]
    );
    res.json(r.rows);
  } catch (e) {
    console.error('sla webhook deliveries:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/sla/policies — create a project override (cannot create org
// default rows here; the migration seeded those).
router.post('/policies', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const { priority, project_id, response_target_minutes, resolve_target_minutes } = req.body || {};
    if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
      return res.status(400).json({ error: 'priority must be 1-5' });
    }
    if (!Number.isInteger(project_id) || project_id <= 0) {
      return res.status(400).json({ error: 'project_id required for override (use PATCH on org defaults)' });
    }
    if (!Number.isInteger(response_target_minutes) || response_target_minutes <= 0) {
      return res.status(400).json({ error: 'response_target_minutes must be positive integer' });
    }
    if (!Number.isInteger(resolve_target_minutes) || resolve_target_minutes <= 0) {
      return res.status(400).json({ error: 'resolve_target_minutes must be positive integer' });
    }
    const r = await pool.query(`
      INSERT INTO sla_policies (priority, project_id, response_target_minutes, resolve_target_minutes)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [priority, project_id, response_target_minutes, resolve_target_minutes]);
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'override already exists for this priority + project' });
    console.error('sla policy create:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/sla/policies/:id — edit response/resolve targets on any row
// (org default or project override).
router.patch('/policies/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const {
      response_target_minutes,
      resolve_target_minutes,
      warning_threshold_percent,
      business_hours_id,
    } = req.body || {};
    const updates = [];
    const values = [];
    if (response_target_minutes !== undefined) {
      if (!Number.isInteger(response_target_minutes) || response_target_minutes <= 0) {
        return res.status(400).json({ error: 'response_target_minutes must be positive integer' });
      }
      values.push(response_target_minutes);
      updates.push(`response_target_minutes = $${values.length}`);
    }
    if (resolve_target_minutes !== undefined) {
      if (!Number.isInteger(resolve_target_minutes) || resolve_target_minutes <= 0) {
        return res.status(400).json({ error: 'resolve_target_minutes must be positive integer' });
      }
      values.push(resolve_target_minutes);
      updates.push(`resolve_target_minutes = $${values.length}`);
    }
    if (warning_threshold_percent !== undefined) {
      if (!Number.isInteger(warning_threshold_percent) || warning_threshold_percent < 0 || warning_threshold_percent > 99) {
        return res.status(400).json({ error: 'warning_threshold_percent must be 0–99' });
      }
      values.push(warning_threshold_percent);
      updates.push(`warning_threshold_percent = $${values.length}`);
    }
    if (business_hours_id !== undefined) {
      if (business_hours_id !== null && (!Number.isInteger(business_hours_id) || business_hours_id <= 0)) {
        return res.status(400).json({ error: 'business_hours_id must be positive integer or null' });
      }
      values.push(business_hours_id);
      updates.push(`business_hours_id = $${values.length}`);
    }
    if (!updates.length) return res.status(400).json({ error: 'no updatable fields supplied' });
    updates.push('updated_at = NOW()');
    values.push(id);
    const r = await pool.query(`
      UPDATE sla_policies SET ${updates.join(', ')}
        WHERE id = $${values.length}
        RETURNING *
    `, values);
    if (!r.rows[0]) return res.status(404).json({ error: 'policy not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('sla policy patch:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/sla/policies/:id — only project-override rows can be
// deleted. Org defaults are protected (delete one and tickets in that
// priority lose SLA tracking entirely).
router.delete('/policies/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const r = await pool.query(`SELECT project_id FROM sla_policies WHERE id = $1`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'policy not found' });
    if (r.rows[0].project_id == null) {
      return res.status(400).json({ error: 'cannot delete org-default policy; PATCH it instead' });
    }
    await pool.query(`DELETE FROM sla_policies WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('sla policy delete:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── Dashboard ───────────────────────────────────────────────────────────

// Returns array of project IDs the user can access, or null if
// Admin/Manager (which means "all projects"). Mirrors the helper in
// routes/tickets.js — kept inline so this module stays self-contained.
async function getAccessibleProjectIds(user) {
  if (['Admin', 'Manager'].includes(user.role)) return null;
  const result = await pool.query(
    'SELECT project_id FROM project_members WHERE user_id = $1',
    [user.id]
  );
  return result.rows.map(r => r.project_id);
}

// GET /api/sla/dashboard — counts + breach lists for the dashboard
// SLA card. Open to any authenticated user; project visibility is
// scoped by membership (Admin/Manager see all, Submitter/Viewer see
// only project_members rows). MTD breach counts are grouped per
// project so the user can see where their pain is.
router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const accessible = await getAccessibleProjectIds(req.session.user);
    // Caller-requested project narrow (comma-separated). Intersects
    // with `accessible` so a member can never widen past their scope.
    const requested = String(req.query.project_id || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    let effective = null;
    if (accessible !== null && requested.length) {
      effective = requested.filter((id) => accessible.includes(id));
    } else if (accessible !== null) {
      effective = accessible;
    } else if (requested.length) {
      effective = requested;
    }

    // Empty array case: scoped user with zero project memberships OR
    // requested filter that intersects to zero → no SLA data to show.
    // Return zeroed shape so the frontend can render an empty state
    // without special-casing.
    if (effective !== null && effective.length === 0) {
      return res.json({
        scope: 'project_member',
        live: { breached_response: 0, breached_resolve: 0, open_response: 0, open_resolve: 0 },
        mtd_total: { response: 0, resolve: 0 },
        mtd_by_project: [],
        at_risk: [],
        breached: [],
      });
    }

    // Build a "project_id IN ($scope)" SQL fragment + params. Reuses
    // the same scope across the four queries below.
    const scopeParams = [];
    let scopeWhere = '';
    if (effective !== null) {
      scopeParams.push(effective);
      scopeWhere = `AND project_id = ANY($1)`;
    }

    // Live state across in-scope tickets. Pause-time breakdown joins
    // the live in-progress pause (NOW - sla_paused_at) onto the
    // accumulated totals so an active pause is reflected immediately
    // without waiting for the next status change.
    // `live` = the ticket still has a running/owed SLA obligation: it is NOT
    // terminal (Closed) and NOT in the resolved_pending_close grace window.
    // Without this guard the breach/open counts swept in legacy Closed tickets
    // that never got sla_first_response_at stamped — inflating "Open w/ SLA
    // clock" with hundreds of done tickets. Pause-second accumulators below
    // are intentionally left unguarded (historical totals).
    const live = `(s.is_terminal IS NOT TRUE AND COALESCE(s.semantic_tag,'') <> 'resolved_pending_close')`;
    const counts = await pool.query(`
      SELECT
        SUM(CASE WHEN ${live} AND sla_response_breached = TRUE AND sla_first_response_at IS NULL THEN 1 ELSE 0 END)::int AS breached_response,
        SUM(CASE WHEN ${live} AND sla_resolve_breached = TRUE AND resolved_at IS NULL THEN 1 ELSE 0 END)::int AS breached_resolve,
        SUM(CASE WHEN ${live} AND sla_response_due_at IS NOT NULL AND sla_first_response_at IS NULL AND sla_response_breached = FALSE THEN 1 ELSE 0 END)::int AS open_response,
        SUM(CASE WHEN ${live} AND sla_resolve_due_at  IS NOT NULL AND resolved_at IS NULL              AND sla_resolve_breached  = FALSE THEN 1 ELSE 0 END)::int AS open_resolve,
        -- Distinct tickets with EITHER clock live, so a ticket owing both
        -- response and resolve isn't counted twice (matches ?sla=open list).
        SUM(CASE WHEN ${live} AND (
              (sla_response_due_at IS NOT NULL AND sla_first_response_at IS NULL AND sla_response_breached = FALSE)
           OR (sla_resolve_due_at  IS NOT NULL AND resolved_at IS NULL              AND sla_resolve_breached  = FALSE)
        ) THEN 1 ELSE 0 END)::int AS open_clock,
        -- Distinct currently-breached tickets (a ticket breaching BOTH response
        -- and resolve counts once), so the card matches the ?sla=breached list.
        SUM(CASE WHEN ${live} AND (
              (sla_response_breached = TRUE AND sla_first_response_at IS NULL)
           OR (sla_resolve_breached  = TRUE AND resolved_at IS NULL)
        ) THEN 1 ELSE 0 END)::int AS breached_clock,
        SUM(
          sla_vendor_wait_seconds
          + CASE WHEN sla_pause_kind = 'vendor' AND sla_paused_at IS NOT NULL
                 THEN GREATEST(0, EXTRACT(EPOCH FROM (NOW() - sla_paused_at))::int)
                 ELSE 0 END
        )::bigint AS vendor_wait_seconds,
        SUM(
          sla_internal_hold_seconds
          + CASE WHEN sla_pause_kind = 'internal' AND sla_paused_at IS NOT NULL
                 THEN GREATEST(0, EXTRACT(EPOCH FROM (NOW() - sla_paused_at))::int)
                 ELSE 0 END
        )::bigint AS internal_hold_seconds
      FROM tickets t
      LEFT JOIN statuses s ON s.kind = 'internal' AND s.name = t.internal_status
      WHERE 1=1 ${scopeWhere}
    `, scopeParams);

    // Month-to-date breach totals across all in-scope projects.
    const mtdTotal = await pool.query(`
      SELECT
        SUM(CASE WHEN sla_response_breached_at IS NOT NULL AND sla_response_breached_at >= date_trunc('month', NOW()) THEN 1 ELSE 0 END)::int AS response,
        SUM(CASE WHEN sla_resolve_breached_at  IS NOT NULL AND sla_resolve_breached_at  >= date_trunc('month', NOW()) THEN 1 ELSE 0 END)::int AS resolve
      FROM tickets
      WHERE 1=1 ${scopeWhere}
    `, scopeParams);

    // Per-project MTD breakdown — joined with projects so we have a
    // friendly name + prefix for the UI.
    const mtdByProject = await pool.query(`
      SELECT
        t.project_id,
        p.name    AS project_name,
        p.prefix  AS project_prefix,
        SUM(CASE WHEN t.sla_response_breached_at IS NOT NULL AND t.sla_response_breached_at >= date_trunc('month', NOW()) THEN 1 ELSE 0 END)::int AS breached_response,
        SUM(CASE WHEN t.sla_resolve_breached_at  IS NOT NULL AND t.sla_resolve_breached_at  >= date_trunc('month', NOW()) THEN 1 ELSE 0 END)::int AS breached_resolve
      FROM tickets t
      LEFT JOIN projects p ON p.id = t.project_id
      WHERE 1=1 ${scopeWhere ? 'AND t.project_id = ANY($1)' : ''}
      GROUP BY t.project_id, p.name, p.prefix
      HAVING SUM(CASE WHEN t.sla_response_breached_at >= date_trunc('month', NOW()) THEN 1 ELSE 0 END) > 0
          OR SUM(CASE WHEN t.sla_resolve_breached_at  >= date_trunc('month', NOW()) THEN 1 ELSE 0 END) > 0
      ORDER BY (
        SUM(CASE WHEN t.sla_response_breached_at >= date_trunc('month', NOW()) THEN 1 ELSE 0 END) +
        SUM(CASE WHEN t.sla_resolve_breached_at  >= date_trunc('month', NOW()) THEN 1 ELSE 0 END)
      ) DESC
    `, scopeParams);

    // At-risk + breached samples (capped) for inline drill-down.
    const atRisk = await pool.query(`
      SELECT id, internal_ref, title, title_enc, effective_priority, sla_response_due_at, sla_resolve_due_at,
             sla_first_response_at, resolved_at, sla_paused_at, project_id
        FROM tickets
       WHERE sla_paused_at IS NULL
         AND (
           (sla_response_due_at IS NOT NULL AND sla_first_response_at IS NULL AND sla_response_breached = FALSE
              AND sla_response_due_at < NOW() + INTERVAL '1 hour')
           OR
           (sla_resolve_due_at IS NOT NULL AND resolved_at IS NULL AND sla_resolve_breached = FALSE
              AND sla_resolve_due_at < NOW() + INTERVAL '4 hours')
         )
         ${scopeWhere}
       ORDER BY LEAST(COALESCE(sla_response_due_at, 'infinity'), COALESCE(sla_resolve_due_at, 'infinity')) ASC
       LIMIT 25
    `, scopeParams);
    await decryptRows('tickets', atRisk.rows);

    const breached = await pool.query(`
      SELECT id, internal_ref, title, title_enc, effective_priority, sla_response_due_at, sla_resolve_due_at,
             sla_response_breached, sla_resolve_breached, sla_first_response_at, resolved_at, project_id
        FROM tickets
       WHERE ((sla_response_breached = TRUE AND sla_first_response_at IS NULL)
           OR (sla_resolve_breached  = TRUE AND resolved_at IS NULL))
         ${scopeWhere}
       ORDER BY GREATEST(
           COALESCE(sla_response_due_at, '-infinity'),
           COALESCE(sla_resolve_due_at,  '-infinity')
       ) DESC
       LIMIT 25
    `, scopeParams);
    await decryptRows('tickets', breached.rows);

    // Per-vendor breakdown of live vendor wait. A ticket attributes
    // its entire vendor_wait_seconds to the FIRST vendor contact's
    // company (earliest added_at, tiebreaker by contact id). When the
    // ticket has no vendor contact, the time sits under
    // (unattributed) so the dashboard total still reconciles with
    // the per-vendor sum. Includes the live in-flight pause delta so
    // a currently-paused ticket shows up before the next status flip.
    const vendorWaitByVendor = await pool.query(`
      WITH ticket_vendor AS (
        SELECT t.id AS ticket_id,
               (SELECT c.company_id
                  FROM ticket_contacts tc
                  JOIN contacts c ON c.id = tc.contact_id
                  JOIN companies co ON co.id = c.company_id AND co.kind = 'vendor'
                 WHERE tc.ticket_id = t.id
                 ORDER BY tc.added_at ASC NULLS LAST, c.id ASC
                 LIMIT 1) AS vendor_company_id
          FROM tickets t
         WHERE 1=1 ${scopeWhere ? 'AND t.project_id = ANY($1)' : ''}
      )
      SELECT tv.vendor_company_id,
             co.name AS vendor_name,
             co.name_enc AS vendor_name_enc,
             SUM(
               t.sla_vendor_wait_seconds
               + CASE WHEN t.sla_pause_kind = 'vendor' AND t.sla_paused_at IS NOT NULL
                      THEN GREATEST(0, EXTRACT(EPOCH FROM (NOW() - t.sla_paused_at))::int)
                      ELSE 0 END
             )::bigint AS vendor_wait_seconds,
             COUNT(*) FILTER (
               WHERE t.sla_pause_kind = 'vendor' AND t.sla_paused_at IS NOT NULL
             )::int AS active_paused_tickets
        FROM tickets t
        JOIN ticket_vendor tv ON tv.ticket_id = t.id
        LEFT JOIN companies co ON co.id = tv.vendor_company_id
       WHERE 1=1 ${scopeWhere ? 'AND t.project_id = ANY($1)' : ''}
         AND (
           t.sla_vendor_wait_seconds > 0
           OR (t.sla_pause_kind = 'vendor' AND t.sla_paused_at IS NOT NULL)
         )
       GROUP BY tv.vendor_company_id, co.name, co.name_enc
       ORDER BY vendor_wait_seconds DESC
    `, scopeParams);
    // Decrypt company name column for standard-mode tenants. Vendor
    // names live on companies.name / name_enc; the row-level helper
    // expects the table key, so we pass the rows through with aliased
    // columns rewritten in place.
    for (const row of vendorWaitByVendor.rows) {
      if (row.vendor_name_enc && !row.vendor_name) {
        try {
          const { decrypt } = require('../services/crypto');
          row.vendor_name = await decrypt(row.vendor_name_enc, 'companies.name');
        } catch { /* leave null */ }
      }
      delete row.vendor_name_enc;
    }

    res.json({
      scope: accessible === null ? 'all' : 'project_member',
      live: counts.rows[0],
      mtd_total: mtdTotal.rows[0],
      mtd_by_project: mtdByProject.rows,
      vendor_wait_by_vendor: vendorWaitByVendor.rows,
      at_risk: atRisk.rows,
      breached: breached.rows,
    });
  } catch (err) {
    console.error('sla dashboard:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/sla/time-in-status — aggregated time tickets have spent in
// each status, derived from audit_log status_change rows. Spans are
// (entered_at, next status_change OR NOW()). Initial status (before
// any change) isn't counted — keeps the SQL simple and the signal is
// still meaningful for chokepoint detection.
//
// Resolved-pending-close statuses (semantic_tag='resolved_pending_close')
// are excluded: tickets are *supposed* to sit there for the auto-close
// grace window, so counting that time as time-in-status would tag a
// healthy queue as a chokepoint. (Previously we tried to cap spans by
// joining t.resolved_at, but that column gets rewritten on reopens, so
// prior Resolved spans went uncapped and the bucket dominated the
// chart.)
//
// Query params:
//   project_id — restrict to one project (optional). Otherwise scoped
//                by member visibility same as /dashboard.
//   since      — ISO8601 lower bound for entered_at (optional).
//   until      — ISO8601 upper bound for entered_at (optional).
router.get('/time-in-status', requireAuth, async (req, res) => {
  try {
    const accessible = await getAccessibleProjectIds(req.session.user);
    if (accessible !== null && accessible.length === 0) {
      return res.json({ scope: 'project_member', rows: [] });
    }

    const params = [];
    const where = [
      `al.action = 'status_change'`,
      // Exclude resolved-pending-close statuses (Resolved sits 3 days
      // by design) and terminal statuses (Closed sits forever). Both
      // would dominate the chart for non-chokepoint reasons.
      `al.new_value NOT IN (
         SELECT name FROM statuses
         WHERE kind = 'internal'
           AND (semantic_tag = 'resolved_pending_close' OR is_terminal = TRUE)
       )`,
    ];
    // project_id may be a single value or comma-separated list. When
    // both the caller's accessible scope and a requested list are
    // present, intersect — caller can only narrow within what they're
    // allowed to see.
    const requested = String(req.query.project_id || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    let effective = null;
    if (accessible !== null && requested.length) {
      effective = requested.filter((id) => accessible.includes(id));
      if (effective.length === 0) return res.json({ scope: 'project_member', rows: [] });
    } else if (accessible !== null) {
      effective = accessible;
    } else if (requested.length) {
      effective = requested;
    }
    if (effective) {
      params.push(effective);
      where.push(`t.project_id = ANY($${params.length}::int[])`);
    }
    if (req.query.since) {
      params.push(req.query.since);
      where.push(`al.created_at >= $${params.length}`);
    }
    if (req.query.until) {
      params.push(req.query.until);
      where.push(`al.created_at < $${params.length}`);
    }

    const r = await pool.query(
      `WITH status_history AS (
         SELECT
           al.ticket_id,
           al.new_value AS status,
           al.created_at AS entered_at,
           LEAST(
             LEAD(al.created_at) OVER (PARTITION BY al.ticket_id ORDER BY al.created_at),
             NOW()
           ) AS left_at
         FROM audit_log al
         JOIN tickets t ON t.id = al.ticket_id
         WHERE ${where.join(' AND ')}
       )
       SELECT
         status,
         SUM(EXTRACT(EPOCH FROM (left_at - entered_at)))::bigint AS total_seconds,
         AVG(EXTRACT(EPOCH FROM (left_at - entered_at)))::bigint AS avg_seconds,
         COUNT(*)::int AS entries
       FROM status_history
       WHERE left_at IS NOT NULL AND left_at > entered_at
       GROUP BY status
       ORDER BY total_seconds DESC`,
      params
    );
    res.json({
      scope: accessible === null ? 'all' : 'project_member',
      rows: r.rows,
    });
  } catch (err) {
    console.error('sla time-in-status:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

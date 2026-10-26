// Subscribable scheduled-work calendars (.ics) for Outlook / M365 and
// Google Calendar.
//
// Calendar apps fetch on their own schedule and can't log in, so each
// user has one feed token; the token in the URL is the credential and
// the owner's current role and project membership decide what each feed
// may show. Regenerating the token revokes every old link.
//
//   GET /api/calendar/feed/:token/mine.ics          work assigned to me
//   GET /api/calendar/feed/:token/all.ics           all scheduled work (Admin/Manager/Tech)
//   GET /api/calendar/feed/:token/project/:prefix.ics   one project's work
//   GET /api/calendar/feed/:token/holidays/:id.ics  a business-hours
//       policy's holidays (any active user — the company holiday calendar)
//
// Events: maintenance windows (project + assigned techs) and upcoming
// recurring-ticket runs (project + assignee).
//
// Session routes for the owner: GET /me (links), POST /me/token
// (create or regenerate), DELETE /me/token (revoke).

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { generateToken, hashToken } = require('../auth/tokens');
const { encrypt, decrypt } = require('../services/crypto');
const { decryptRows } = require('../services/fields');
const sched = require('../services/ticketSchedules');
const { buildCalendar } = require('../services/ics');
const holidays = require('../services/holidays');

const router = express.Router();

const STAFF = ['Admin', 'Manager', 'Tech'];
const ALL_PROJECTS = ['Admin', 'Manager'];
const PAST_DAYS = 90;
const SCHEDULE_DAYS = 60;
const MAX_RUNS_PER_SCHEDULE = 40;

const tokenCtx = (userId) => `calendar_feeds.token:${userId}`;

function siteBase() {
  return String(process.env.FRONTEND_URL || '').trim().replace(/\/+$/, '');
}
function siteHost() {
  try { return new URL(siteBase()).host || 'resolvd'; } catch { return 'resolvd'; }
}

// SEQUENCE must rise when an event changes; seconds since 2024 does.
function sequenceFrom(updated) {
  const s = Math.floor((new Date(updated).getTime() - Date.UTC(2024, 0, 1)) / 1000);
  return Number.isFinite(s) && s > 0 ? s : 0;
}

async function visibleProjects(user) {
  if (ALL_PROJECTS.includes(user.role)) {
    const r = await pool.query(
      `SELECT id, prefix, name FROM projects WHERE status = 'active' ORDER BY name`
    );
    return r.rows;
  }
  const r = await pool.query(
    `SELECT p.id, p.prefix, p.name FROM projects p
       JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1
      WHERE p.status = 'active' ORDER BY p.name`,
    [user.id]
  );
  return r.rows;
}

// Enabled business-hours policies that have at least one holiday.
async function holidayCalendars() {
  const r = await pool.query(`
    SELECT b.id, b.name, b.tz, l.name AS location_name, p.name AS project_name
      FROM business_hours_policies b
      LEFT JOIN locations l ON l.id = b.location_id
      LEFT JOIN projects p ON p.id = b.project_id
     WHERE b.enabled = TRUE
       AND EXISTS (SELECT 1 FROM business_hours_holidays h WHERE h.business_hours_id = b.id)
     ORDER BY (b.project_id IS NULL AND b.location_id IS NULL) DESC, b.name
  `);
  return r.rows;
}

function feedLinks(token, user, projects, holidayCals = []) {
  const base = `${siteBase()}/api/calendar/feed/${token}`;
  return {
    mine: `${base}/mine.ics`,
    all: STAFF.includes(user.role) ? `${base}/all.ics` : null,
    projects: projects.map((p) => ({ ...p, url: `${base}/project/${encodeURIComponent(p.prefix)}.ics` })),
    holidays: holidayCals.map((c) => ({ ...c, url: `${base}/holidays/${c.id}.ics` })),
  };
}

// All-day events for a policy's holidays, last year through two years
// ahead. UIDs are stable per rule + date so calendar apps update in place.
async function holidayEvents(bhId) {
  const r = await pool.query(
    `SELECT id, kind, to_char(holiday_date, 'YYYY-MM-DD') AS date, recurring,
            month, weekday, nth, observed, name, created_at
       FROM business_hours_holidays WHERE business_hours_id = $1`,
    [bhId]
  );
  const year = new Date().getUTCFullYear();
  return holidays.occurrences(r.rows, year - 1, year + 2).map((o) => {
    const [y, m, d] = o.date.split('-').map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    const name = o.holiday.name || holidays.describeRule(o.holiday);
    return {
      uid: `holiday-${bhId}-${o.holiday.id}-${o.date}@${siteHost()}`,
      start: o.date,
      end: next,
      allDay: true,
      transparent: true,
      summary: o.date !== o.actual ? `${name} (observed)` : name,
      description: o.date !== o.actual ? `Falls on ${o.actual}; taken ${o.date}.` : undefined,
      categories: ['Holiday'],
      updated: o.holiday.created_at,
    };
  });
}

// ---------- events ----------

// scope: { userId } | { projectId } | {} (all)
async function maintenanceEvents(scope) {
  const where = [`w.ends_at >= NOW() - INTERVAL '${PAST_DAYS} days'`];
  const vals = [];
  if (scope.userId) {
    vals.push(scope.userId);
    where.push(`EXISTS (SELECT 1 FROM maintenance_window_assignees a
                         WHERE a.window_id = w.id AND a.user_id = $${vals.length})`);
  }
  if (scope.projectId) {
    vals.push(scope.projectId);
    where.push(`w.project_id = $${vals.length}`);
  }
  const r = await pool.query(`
    SELECT w.id, w.title, w.description, w.work_notes, w.starts_at, w.ends_at,
           w.updated_at, p.prefix AS project_prefix, p.name AS project_name,
           t.internal_ref AS ticket_ref, t.id AS ticket_id,
           (SELECT STRING_AGG(COALESCE(i.label, 'Item ' || i.id), ', ' ORDER BY i.label)
              FROM maintenance_window_items mi
              JOIN alert_monitored_items i ON i.id = mi.item_id
             WHERE mi.window_id = w.id) AS items,
           (SELECT STRING_AGG(u.display_name, ', ' ORDER BY u.display_name)
              FROM maintenance_window_assignees a
              JOIN users u ON u.id = a.user_id
             WHERE a.window_id = w.id) AS assignees
      FROM maintenance_windows w
      LEFT JOIN projects p ON p.id = w.project_id
      LEFT JOIN tickets t ON t.id = w.ticket_id
     WHERE ${where.join(' AND ')}
     ORDER BY w.starts_at
     LIMIT 1000
  `, vals);
  const base = siteBase();
  const host = siteHost();
  return r.rows.map((w) => {
    const desc = [];
    if (w.project_name) desc.push(`Project: ${w.project_prefix} · ${w.project_name}`);
    if (w.assignees) desc.push(`Assigned: ${w.assignees}`);
    if (w.items) desc.push(`Affects: ${w.items}`);
    if (w.ticket_ref) desc.push(`Ticket: ${w.ticket_ref}${base ? ` (${base}/tickets/${w.ticket_id})` : ''}`);
    if (w.description) desc.push('', w.description);
    if (w.work_notes) desc.push('', 'Work notes:', w.work_notes);
    return {
      uid: `maintenance-${w.id}@${host}`,
      start: w.starts_at,
      end: w.ends_at,
      summary: `Maintenance: ${w.title}${w.project_prefix ? ` [${w.project_prefix}]` : ''}`,
      description: desc.join('\n'),
      url: base ? `${base}/maintenance` : undefined,
      categories: ['Maintenance'],
      updated: w.updated_at,
      sequence: sequenceFrom(w.updated_at),
    };
  });
}

// Upcoming runs of recurring-ticket schedules, expanded from their
// cron within the next SCHEDULE_DAYS. Each run is a 30-minute block at
// the time the ticket is created.
async function scheduleEvents(scope) {
  const where = ['s.enabled = TRUE', 's.next_fire_at IS NOT NULL'];
  const vals = [];
  if (scope.userId) { vals.push(scope.userId); where.push(`s.assigned_to = $${vals.length}`); }
  if (scope.projectId) { vals.push(scope.projectId); where.push(`s.project_id = $${vals.length}`); }
  const r = await pool.query(`
    SELECT s.*, p.prefix AS project_prefix, p.name AS project_name,
           u.display_name AS assignee_name
      FROM ticket_schedules s
      JOIN projects p ON p.id = s.project_id
      LEFT JOIN users u ON u.id = s.assigned_to
     WHERE ${where.join(' AND ')}
  `, vals);
  await decryptRows('ticket_schedules', r.rows);
  const base = siteBase();
  const host = siteHost();
  const horizon = Date.now() + SCHEDULE_DAYS * 86400000;
  const out = [];
  for (const s of r.rows) {
    let cron;
    try { cron = sched.normaliseToCron(s); } catch { continue; }
    const ends = { endKind: s.end_kind, endDate: s.end_date };
    let at = new Date(s.next_fire_at);
    let fires = s.fires_count || 0;
    for (let n = 0; n < MAX_RUNS_PER_SCHEDULE && at && at.getTime() <= horizon; n += 1) {
      if (s.end_kind === 'count' && s.end_count && fires >= s.end_count) break;
      const desc = [
        `Recurring ticket in ${s.project_prefix} · ${s.project_name}`,
        s.assignee_name ? `Assigned: ${s.assignee_name}` : 'Unassigned',
        `Repeats: ${sched.describeCron(cron)}`,
      ];
      if (s.description) desc.push('', s.description);
      out.push({
        uid: `schedule-${s.id}-${at.getTime()}@${host}`,
        start: at,
        end: new Date(at.getTime() + 30 * 60000),
        summary: `${s.title || s.name} [${s.project_prefix}]`,
        description: desc.join('\n'),
        url: base ? `${base}/admin/ticket-schedules` : undefined,
        categories: ['Scheduled ticket'],
        updated: s.updated_at,
        sequence: sequenceFrom(s.updated_at),
      });
      fires += 1;
      try { at = sched.computeNextFire(cron, s.timezone, at, ends); } catch { at = null; }
    }
  }
  return out;
}

// ---------- public feed ----------

async function ownerFromToken(token) {
  if (!token || token.length > 100) return null;
  const r = await pool.query(
    `SELECT u.id, u.role, u.display_name, u.status
       FROM calendar_feeds f JOIN users u ON u.id = f.user_id
      WHERE f.token_hash = $1`,
    [hashToken(token)]
  );
  const u = r.rows[0];
  if (!u || u.status !== 'active') return null;
  pool.query(`UPDATE calendar_feeds SET last_used_at = NOW() WHERE user_id = $1`, [u.id])
    .catch(() => {});
  return u;
}

function sendIcs(res, filename, body) {
  res.set({
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': `inline; filename="${filename}"`,
    'Cache-Control': 'private, max-age=300',
    'X-Robots-Tag': 'noindex',
  });
  res.send(body);
}

const notFound = (res) => res.status(404).type('text/plain').send('Calendar not found');

router.get('/feed/:token/mine.ics', async (req, res) => {
  try {
    const u = await ownerFromToken(req.params.token);
    if (!u) return notFound(res);
    const events = [
      ...(await maintenanceEvents({ userId: u.id })),
      ...(await scheduleEvents({ userId: u.id })),
    ];
    sendIcs(res, 'my-scheduled-work.ics', buildCalendar({
      name: `Resolvd · ${u.display_name}`,
      description: 'Maintenance and recurring tickets assigned to you',
      events,
    }));
  } catch (err) {
    console.error('calendar mine:', err);
    res.status(500).type('text/plain').send('Calendar error');
  }
});

router.get('/feed/:token/all.ics', async (req, res) => {
  try {
    const u = await ownerFromToken(req.params.token);
    if (!u || !STAFF.includes(u.role)) return notFound(res);
    const events = [...(await maintenanceEvents({})), ...(await scheduleEvents({}))];
    sendIcs(res, 'scheduled-work.ics', buildCalendar({
      name: 'Resolvd · All scheduled work',
      description: 'All maintenance windows and recurring tickets',
      events,
    }));
  } catch (err) {
    console.error('calendar all:', err);
    res.status(500).type('text/plain').send('Calendar error');
  }
});

router.get('/feed/:token/project/:prefix.ics', async (req, res) => {
  try {
    const u = await ownerFromToken(req.params.token);
    if (!u) return notFound(res);
    const prefix = String(req.params.prefix || '').toUpperCase();
    const project = (await visibleProjects(u)).find((p) => p.prefix.toUpperCase() === prefix);
    if (!project) return notFound(res);
    const events = [
      ...(await maintenanceEvents({ projectId: project.id })),
      ...(await scheduleEvents({ projectId: project.id })),
    ];
    sendIcs(res, `${project.prefix.toLowerCase()}-scheduled-work.ics`, buildCalendar({
      name: `Resolvd · ${project.prefix} ${project.name}`,
      description: `Scheduled work for ${project.name}`,
      events,
    }));
  } catch (err) {
    console.error('calendar project:', err);
    res.status(500).type('text/plain').send('Calendar error');
  }
});

router.get('/feed/:token/holidays/:id.ics', async (req, res) => {
  try {
    const u = await ownerFromToken(req.params.token);
    if (!u) return notFound(res);
    const cal = (await holidayCalendars()).find((c) => c.id === Number(req.params.id));
    if (!cal) return notFound(res);
    sendIcs(res, 'holidays.ics', buildCalendar({
      name: `Holidays · ${cal.name}`,
      description: `Company holidays (${cal.location_name || cal.project_name || 'organisation'})`,
      events: await holidayEvents(cal.id),
    }));
  } catch (err) {
    console.error('calendar holidays:', err);
    res.status(500).type('text/plain').send('Calendar error');
  }
});

// ---------- owner management ----------

router.get('/me', requireAuth, async (req, res) => {
  const user = req.session.user;
  try {
    const r = await pool.query(
      `SELECT token_enc, created_at, last_used_at FROM calendar_feeds WHERE user_id = $1`,
      [user.id]
    );
    if (!r.rows[0]) return res.json({ enabled: false });
    const token = await decrypt(r.rows[0].token_enc, tokenCtx(user.id));
    res.json({
      enabled: true,
      created_at: r.rows[0].created_at,
      last_used_at: r.rows[0].last_used_at,
      links: feedLinks(token, user, await visibleProjects(user), await holidayCalendars()),
    });
  } catch (err) {
    console.error('calendar me:', err);
    res.status(500).json({ error: 'Could not load calendar links' });
  }
});

router.post('/me/token', requireAuth, async (req, res) => {
  const user = req.session.user;
  try {
    const token = generateToken();
    await pool.query(
      `INSERT INTO calendar_feeds (user_id, token_hash, token_enc)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE
         SET token_hash = EXCLUDED.token_hash, token_enc = EXCLUDED.token_enc,
             created_at = NOW(), last_used_at = NULL`,
      [user.id, hashToken(token), await encrypt(token, tokenCtx(user.id))]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('calendar token:', err);
    res.status(500).json({ error: 'Could not create calendar link' });
  }
});

router.delete('/me/token', requireAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM calendar_feeds WHERE user_id = $1`, [req.session.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('calendar revoke:', err);
    res.status(500).json({ error: 'Could not revoke calendar link' });
  }
});

module.exports = router;

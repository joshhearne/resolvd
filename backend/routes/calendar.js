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
const { utcFromTzWall } = require('../services/businessHours');

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

// Enabled business-hours policies that have at least one holiday. The
// feed carries holidays only — never the opening hours — so it's titled
// by scope ("Holidays", "Holidays · NYC office"), not by the policy name,
// which usually spells out the hours.
async function holidayCalendars() {
  const r = await pool.query(`
    SELECT b.id, l.name AS location_name, p.name AS project_name
      FROM business_hours_policies b
      LEFT JOIN locations l ON l.id = b.location_id
      LEFT JOIN projects p ON p.id = b.project_id
     WHERE b.enabled = TRUE
       AND EXISTS (SELECT 1 FROM business_hours_holidays h WHERE h.business_hours_id = b.id)
     ORDER BY (b.project_id IS NULL AND b.location_id IS NULL) DESC,
              l.name NULLS FIRST, p.name NULLS FIRST
  `);
  return r.rows.map((c) => {
    const scope = c.location_name || c.project_name;
    return { id: c.id, title: scope ? `Holidays · ${scope}` : 'Holidays' };
  });
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

// A policy's holidays, last year through two years ahead: all-day events
// (spanning several days where the holiday does), and for an early close
// a timed event from the close to the end of the business day. UIDs are
// stable per rule + date so calendar apps update in place.
async function holidayEvents(bhId) {
  const [r, pol] = await Promise.all([
    pool.query(
      `SELECT id, kind, to_char(holiday_date, 'YYYY-MM-DD') AS date, recurring,
              month, weekday, nth, observed, name, span_days,
              to_char(closes_at, 'HH24:MI') AS closes_at, created_at
         FROM business_hours_holidays WHERE business_hours_id = $1`,
      [bhId]
    ),
    pool.query(`SELECT tz, to_char(end_time, 'HH24:MI') AS end_time FROM business_hours_policies WHERE id = $1`, [bhId]),
  ]);
  const tz = pol.rows[0]?.tz || 'UTC';
  const endTime = pol.rows[0]?.end_time || '17:00';
  const year = new Date().getUTCFullYear();
  return holidays.occurrences(r.rows, year - 1, year + 2).map((o) => {
    const [y, m, d] = o.date.split('-').map(Number);
    const name = o.holiday.name || holidays.describeRule(o.holiday);
    const observed = o.date !== o.actual;
    const base = {
      uid: `holiday-${bhId}-${o.holiday.id}-${o.date}@${siteHost()}`,
      transparent: true,
      description: observed ? `Falls on ${o.actual}; taken ${o.date}.` : undefined,
      categories: ['Holiday'],
      updated: o.holiday.created_at,
    };
    if (o.holiday.closes_at) {
      const [ch, cm] = o.holiday.closes_at.split(':').map(Number);
      const [eh, em] = endTime.split(':').map(Number);
      const start = utcFromTzWall(tz, y, m, d, ch, cm);
      let end = utcFromTzWall(tz, y, m, d, eh, em);
      if (end <= start) end = new Date(start.getTime() + 60 * 60000);
      return { ...base, start, end, summary: `${name} (closes ${o.holiday.closes_at})${observed ? ' (observed)' : ''}` };
    }
    const [ly, lm, ld] = o.last.split('-').map(Number);
    return {
      ...base,
      start: o.date,
      end: new Date(Date.UTC(ly, lm - 1, ld + 1)).toISOString().slice(0, 10),
      allDay: true,
      summary: observed ? `${name} (observed)` : name,
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
      name: cal.title,
      description: 'Company holidays',
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

// ---------- in-app calendar (sidebar widget + /calendar page) ----------
//
// GET /api/calendar/events?from=YYYY-MM-DD&to=YYYY-MM-DD&types=a,b
//   → { events: [{ id, type, title, start, end, all_day, link, meta }], types: [...] }
//
// Types and who gets them:
//   maintenance   maintenance windows in projects you can see (staff)
//   scheduled     upcoming recurring-ticket runs in projects you can see (staff)
//   holiday       org-wide business-hours holidays (everyone)
//   license       software license renewals (staff)
//   sla           response / resolve SLA deadlines on open tickets assigned to you
//   due           due dates on open tickets assigned to you
//   followup      follow-ups you scheduled
//   task          your personal tasks' due dates
// `to` is exclusive; the range is capped at CAL_MAX_DAYS.

const CAL_TYPES_ALL = ['maintenance', 'scheduled', 'holiday', 'license', 'sla', 'due', 'followup', 'task'];
const CAL_STAFF_ONLY = new Set(['maintenance', 'scheduled', 'license']);
const CAL_MAX_DAYS = 62;
const OPEN_TICKET_SQL = `t.resolved_at IS NULL AND NOT EXISTS (
  SELECT 1 FROM statuses s WHERE s.kind = 'internal' AND s.name = t.internal_status AND s.is_terminal = TRUE)`;

function calTypesFor(user, requested) {
  const allowed = CAL_TYPES_ALL.filter((t) => STAFF.includes(user.role) || !CAL_STAFF_ONLY.has(t));
  if (!requested) return allowed;
  const want = String(requested).split(',').map((s) => s.trim());
  return allowed.filter((t) => want.includes(t));
}

function parseRange(q) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(q.from || '') || !re.test(q.to || '')) return null;
  const from = new Date(`${q.from}T00:00:00Z`);
  const to = new Date(`${q.to}T00:00:00Z`);
  if (isNaN(from) || isNaN(to) || to <= from) return null;
  if ((to - from) / 86400000 > CAL_MAX_DAYS) return null;
  // Pad a day each side: the client works in local time, the range in UTC.
  return { from: new Date(from.getTime() - 86400000), to: new Date(to.getTime() + 86400000), fromDay: q.from, toDay: q.to };
}

async function calTicketEvents(user, range, types) {
  const out = [];
  const want = (t) => types.includes(t);
  if (want('sla') || want('due')) {
    const r = await pool.query(
      `SELECT t.id, t.internal_ref, t.title, t.title_enc, t.due_at,
              CASE WHEN t.sla_first_response_at IS NULL THEN t.sla_response_due_at END AS response_due,
              t.sla_resolve_due_at AS resolve_due,
              t.sla_response_breached, t.sla_resolve_breached
         FROM tickets t
        WHERE t.assigned_to = $1 AND ${OPEN_TICKET_SQL}
          AND (   (t.sla_first_response_at IS NULL AND t.sla_response_due_at >= $2 AND t.sla_response_due_at < $3)
               OR (t.sla_resolve_due_at >= $2 AND t.sla_resolve_due_at < $3)
               OR (t.due_at >= $2 AND t.due_at < $3))
        LIMIT 1000`,
      [user.id, range.from, range.to]
    );
    await decryptRows('tickets', r.rows);
    const inRange = (d) => d && d >= range.from && d < range.to;
    for (const t of r.rows) {
      const label = `${t.internal_ref}${t.title ? ` · ${t.title}` : ''}`;
      const link = `/tickets/${t.id}`;
      if (want('sla') && inRange(t.response_due)) {
        out.push({ id: `sla-r-${t.id}`, type: 'sla', title: `Response due: ${label}`, start: t.response_due, link,
          meta: { kind: 'response', breached: t.sla_response_breached } });
      }
      if (want('sla') && inRange(t.resolve_due)) {
        out.push({ id: `sla-s-${t.id}`, type: 'sla', title: `Resolve due: ${label}`, start: t.resolve_due, link,
          meta: { kind: 'resolve', breached: t.sla_resolve_breached } });
      }
      if (want('due') && inRange(t.due_at)) {
        out.push({ id: `due-${t.id}`, type: 'due', title: `Due: ${label}`, start: t.due_at, link });
      }
    }
  }
  if (want('followup')) {
    const r = await pool.query(
      `SELECT t.id, t.internal_ref, t.title, t.title_enc, t.followup_at
         FROM tickets t
        WHERE t.followup_user_id = $1 AND t.followup_at >= $2 AND t.followup_at < $3
        LIMIT 500`,
      [user.id, range.from, range.to]
    );
    await decryptRows('tickets', r.rows);
    for (const t of r.rows) {
      out.push({ id: `fu-${t.id}`, type: 'followup', title: `Follow up: ${t.internal_ref}${t.title ? ` · ${t.title}` : ''}`,
        start: t.followup_at, link: `/tickets/${t.id}` });
    }
  }
  return out;
}

async function calTaskEvents(user, range) {
  const r = await pool.query(
    `SELECT id, title, title_enc, next_due_at FROM tasks
      WHERE owner_user_id = $1 AND completed_at IS NULL AND cancelled_at IS NULL
        AND next_due_at >= $2 AND next_due_at < $3
      LIMIT 500`,
    [user.id, range.from, range.to]
  );
  await decryptRows('tasks', r.rows);
  return r.rows.map((t) => ({ id: `task-${t.id}`, type: 'task', title: t.title || 'Task', start: t.next_due_at, link: '/tasks' }));
}

async function calMaintenanceEvents(projectIds, includeUnscoped, range) {
  const r = await pool.query(
    `SELECT w.id, w.title, w.starts_at, w.ends_at, p.prefix AS project_prefix
       FROM maintenance_windows w
       LEFT JOIN projects p ON p.id = w.project_id
      WHERE w.starts_at < $2 AND w.ends_at >= $1
        AND (w.project_id = ANY($3::int[]) OR ($4 AND w.project_id IS NULL))
      ORDER BY w.starts_at LIMIT 500`,
    [range.from, range.to, projectIds, includeUnscoped]
  );
  return r.rows.map((w) => ({
    id: `mw-${w.id}`, type: 'maintenance', title: `${w.title}${w.project_prefix ? ` [${w.project_prefix}]` : ''}`,
    start: w.starts_at, end: w.ends_at, link: '/maintenance',
  }));
}

async function calScheduleEvents(user, projectIds, range) {
  const r = await pool.query(
    `SELECT s.*, p.prefix AS project_prefix FROM ticket_schedules s
       JOIN projects p ON p.id = s.project_id
      WHERE s.enabled = TRUE AND s.next_fire_at IS NOT NULL AND s.next_fire_at < $2
        AND s.project_id = ANY($1::int[])`,
    [projectIds, range.to]
  );
  await decryptRows('ticket_schedules', r.rows);
  const link = ALL_PROJECTS.includes(user.role) ? '/admin/ticket-schedules' : null;
  const out = [];
  for (const s of r.rows) {
    let cron;
    try { cron = sched.normaliseToCron(s); } catch { continue; }
    const ends = { endKind: s.end_kind, endDate: s.end_date };
    let at = new Date(s.next_fire_at);
    let fires = s.fires_count || 0;
    for (let n = 0; n < MAX_RUNS_PER_SCHEDULE && at && at < range.to; n += 1) {
      if (s.end_kind === 'count' && s.end_count && fires >= s.end_count) break;
      if (at >= range.from) {
        out.push({ id: `sch-${s.id}-${at.getTime()}`, type: 'scheduled', title: `${s.title || s.name} [${s.project_prefix}]`, start: at, link });
      }
      fires += 1;
      try { at = sched.computeNextFire(cron, s.timezone, at, ends); } catch { at = null; }
    }
  }
  return out;
}

async function calHolidayEvents(range) {
  // Org-wide policies only (no project / location scope), deduped by
  // date + name so two org-wide policies don't double up.
  const pols = await pool.query(
    `SELECT b.id FROM business_hours_policies b
      WHERE b.enabled = TRUE AND b.project_id IS NULL AND b.location_id IS NULL
        AND EXISTS (SELECT 1 FROM business_hours_holidays h WHERE h.business_hours_id = b.id)`
  );
  const seen = new Set();
  const out = [];
  for (const { id } of pols.rows) {
    for (const ev of await holidayEvents(id)) {
      const startDay = typeof ev.start === 'string' ? ev.start : ev.start.toISOString().slice(0, 10);
      if (startDay < range.fromDay || startDay >= range.toDay) continue;
      const key = `${startDay}|${ev.summary}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: `hol-${id}-${startDay}-${out.length}`, type: 'holiday', title: ev.summary, start: ev.start, end: ev.end, all_day: !!ev.allDay });
    }
  }
  return out;
}

async function calLicenseEvents(range) {
  const r = await pool.query(
    `SELECT id, name, auto_renew, to_char(renewal_date, 'YYYY-MM-DD') AS renewal_date
       FROM software_licenses
      WHERE NOT archived AND renewal_date >= $1::date AND renewal_date < $2::date
      ORDER BY renewal_date LIMIT 500`,
    [range.fromDay, range.toDay]
  );
  return r.rows.map((l) => ({
    id: `lic-${l.id}`, type: 'license', title: `${l.auto_renew ? 'Renews' : 'Expires'}: ${l.name}`,
    start: l.renewal_date, all_day: true, link: '/inventory/licenses?status=renewing',
  }));
}

router.get('/events', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const range = parseRange(req.query);
    if (!range) return res.status(400).json({ error: `from and to must be YYYY-MM-DD dates, to after from, at most ${CAL_MAX_DAYS} days apart` });
    const types = calTypesFor(user, req.query.types);
    const want = (t) => types.includes(t);
    const jobs = [];
    if (want('sla') || want('due') || want('followup')) jobs.push(calTicketEvents(user, range, types));
    if (want('task')) jobs.push(calTaskEvents(user, range));
    if (want('holiday')) jobs.push(calHolidayEvents(range));
    if (want('license')) jobs.push(calLicenseEvents(range));
    if (want('maintenance') || want('scheduled')) {
      const projectIds = (await visibleProjects(user)).map((p) => p.id);
      // Windows with no project are org-wide: every staff member sees them
      // (the staff-only types are already limited to STAFF above).
      if (want('maintenance')) jobs.push(calMaintenanceEvents(projectIds, true, range));
      if (want('scheduled')) jobs.push(calScheduleEvents(user, projectIds, range));
    }
    const events = (await Promise.all(jobs)).flat()
      .map((e) => ({ end: null, all_day: false, link: null, meta: null, ...e }))
      .sort((a, b) => String(a.start instanceof Date ? a.start.toISOString() : a.start)
        .localeCompare(String(b.start instanceof Date ? b.start.toISOString() : b.start)));
    res.json({ events, types: calTypesFor(user, null) });
  } catch (err) {
    console.error('calendar events error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

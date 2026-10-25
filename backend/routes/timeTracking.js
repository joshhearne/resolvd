// Technician time tracking.
//
//   GET    /api/time-tracking/settings            — handlers (policy the UI needs)
//   PATCH  /api/time-tracking/settings            — Admin
//   GET    /api/time-tracking/timers/me           — caller's running/paused timers
//   GET    /api/time-tracking/work-types          — active types (?all=1 for Admin: incl. retired)
//   POST   /api/time-tracking/work-types          — Admin { name, billable?, active?, sort_order? }
//   PATCH  /api/time-tracking/work-types/:id      — Admin
//   DELETE /api/time-tracking/work-types/:id      — Admin (retires it if entries use it)
//   GET    /api/time-tracking/export?from=&to=    — Admin/Manager, CSV of entries ending in [from, to)
//
//   GET    /api/tickets/:id/time                  — entries + totals + caller's timer
//   POST   /api/tickets/:id/timer/start           — { auto?, trigger? } (auto honours settings)
//   POST   /api/tickets/:id/timer/pause
//   POST   /api/tickets/:id/timer/discard
//   POST   /api/tickets/:id/timer/leave           — tech left the ticket; applies discard rule
//   POST   /api/tickets/:id/time                  — { note, any two of started_at / ended_at / minutes, visibility?,
//                                                    from_timer?, work_type_id?, confirm_overlap? }
//   PATCH  /api/tickets/:id/time/:entryId         — { started_at?, ended_at?, minutes?, note?, billable?,
//                                                    work_type_id?, confirm_overlap? }
//
// 409 { code: 'overlap_confirm' | 'overlap_blocked', overlaps } when the
// entry overlaps the tech's other logged time (per overlap_policy).
//   DELETE /api/tickets/:id/time/:entryId
//
// Ticket-scoped routes use the same handler gate as internal notes.

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { isProjectHandler } = require('../services/ticketHelpers');
const tt = require('../services/timeTracking');
const { canChooseVisibility } = require('../services/timeTrackingRules');

const settingsRouter = express.Router();
const ticketRouter = express.Router();

function fail(res, err, label) {
  if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message, ...(err.extra || {}) });
  console.error(`time-tracking ${label}:`, err);
  return res.status(500).json({ error: 'Database error' });
}

async function requireTicketHandler(req, res, next) {
  try {
    const user = req.session.user;
    const ticketId = Number(req.params.id);
    if (!Number.isInteger(ticketId) || ticketId <= 0) {
      return res.status(400).json({ error: 'Invalid ticket id' });
    }
    const t = await pool.query('SELECT id, project_id FROM tickets WHERE id = $1', [ticketId]);
    if (!t.rows[0]) return res.status(404).json({ error: 'Ticket not found' });
    const ok = await isProjectHandler(pool, { userId: user.id, role: user.role, projectId: t.rows[0].project_id });
    if (!ok) return res.status(403).json({ error: 'Forbidden' });
    req.ticketId = ticketId;
    next();
  } catch (err) { fail(res, err, 'access'); }
}

function presentSettings(s, role) {
  return {
    enabled: s.enabled,
    auto_start_on_take: s.auto_start_on_take,
    auto_start_on_open: s.auto_start_on_open,
    discard_untouched: s.discard_untouched,
    warn_after_minutes: s.warn_after_minutes,
    default_visibility: s.default_visibility,
    visibility_choice: s.visibility_choice,
    min_note_chars: s.min_note_chars,
    billable_by_default: s.billable_by_default,
    billing_round_increment: s.billing_round_increment,
    billing_round_mode: s.billing_round_mode,
    billing_session_minimum: s.billing_session_minimum,
    billing_ticket_minimum: s.billing_ticket_minimum,
    overlap_policy: s.overlap_policy,
    billing_reprice: s.billing_reprice,
    edit_lock_days: s.edit_lock_days,
    can_choose_visibility: canChooseVisibility(s, role),
    updated_at: s.updated_at,
  };
}

// Settings are readable by anyone who can be a handler somewhere. Global
// Submitters with an agent flag on a project still need them, so only
// require auth here; nothing in the payload is sensitive.
settingsRouter.get('/settings', requireAuth, async (req, res) => {
  try { res.json(presentSettings(await tt.getSettings(), req.session.user.role)); }
  catch (err) { fail(res, err, 'settings get'); }
});

settingsRouter.patch('/settings', requireAuth, requireRole('Admin'), async (req, res) => {
  try { res.json(presentSettings(await tt.patchSettings(req.body), req.session.user.role)); }
  catch (err) { fail(res, err, 'settings patch'); }
});

settingsRouter.get('/timers/me', requireAuth, async (req, res) => {
  try { res.json(await tt.listUserTimers(req.session.user.id)); }
  catch (err) { fail(res, err, 'timers me'); }
});

settingsRouter.get('/work-types', requireAuth, async (req, res) => {
  try {
    const all = req.query.all === '1' && req.session.user.role === 'Admin';
    res.json(await tt.listWorkTypes({ includeInactive: all }));
  } catch (err) { fail(res, err, 'work-types list'); }
});

settingsRouter.post('/work-types', requireAuth, requireRole('Admin'), async (req, res) => {
  try { res.status(201).json(await tt.createWorkType(req.body)); }
  catch (err) { fail(res, err, 'work-types create'); }
});

settingsRouter.patch('/work-types/:wtId', requireAuth, requireRole('Admin'), async (req, res) => {
  try { res.json(await tt.updateWorkType(Number(req.params.wtId), req.body)); }
  catch (err) { fail(res, err, 'work-types update'); }
});

settingsRouter.delete('/work-types/:wtId', requireAuth, requireRole('Admin'), async (req, res) => {
  try { res.json(await tt.deleteWorkType(Number(req.params.wtId))); }
  catch (err) { fail(res, err, 'work-types delete'); }
});

settingsRouter.get('/export', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const csv = await tt.exportCsv({ from: req.query.from, to: req.query.to });
    const day = (v) => String(v || '').slice(0, 10).replace(/[^0-9-]/g, '');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="time-entries-${day(req.query.from)}-to-${day(req.query.to)}.csv"`);
    res.send(csv);
  } catch (err) { fail(res, err, 'export'); }
});

ticketRouter.get('/:id/time', requireAuth, requireTicketHandler, async (req, res) => {
  try {
    const [list, timer] = await Promise.all([
      tt.listEntries(req.ticketId, req.session.user),
      tt.getTimer(req.session.user.id, req.ticketId),
    ]);
    res.json({ ...list, timer });
  } catch (err) { fail(res, err, 'list'); }
});

ticketRouter.post('/:id/timer/start', requireAuth, requireTicketHandler, async (req, res) => {
  try {
    const auto = req.body?.auto === true;
    res.json(await tt.startTimer({
      userId: req.session.user.id,
      ticketId: req.ticketId,
      auto,
      trigger: auto ? String(req.body?.trigger || 'open') : 'manual',
    }));
  } catch (err) { fail(res, err, 'start'); }
});

ticketRouter.post('/:id/timer/pause', requireAuth, requireTicketHandler, async (req, res) => {
  try { res.json({ timer: await tt.pauseTimer({ userId: req.session.user.id, ticketId: req.ticketId }) }); }
  catch (err) { fail(res, err, 'pause'); }
});

ticketRouter.post('/:id/timer/discard', requireAuth, requireTicketHandler, async (req, res) => {
  try { res.json({ discarded: await tt.discardTimer({ userId: req.session.user.id, ticketId: req.ticketId }) }); }
  catch (err) { fail(res, err, 'discard'); }
});

ticketRouter.post('/:id/timer/leave', requireAuth, requireTicketHandler, async (req, res) => {
  try { res.json(await tt.leaveTicket({ userId: req.session.user.id, ticketId: req.ticketId })); }
  catch (err) { fail(res, err, 'leave'); }
});

ticketRouter.post('/:id/time', requireAuth, requireTicketHandler, async (req, res) => {
  try {
    const b = req.body || {};
    const entry = await tt.logWork({
      user: req.session.user,
      ticketId: req.ticketId,
      minutes: b.minutes,
      startedAt: b.started_at,
      endedAt: b.ended_at,
      note: b.note,
      visibility: b.visibility,
      fromTimer: b.from_timer === true,
      workTypeId: b.work_type_id,
      confirmOverlap: b.confirm_overlap === true,
    });
    res.status(201).json(entry);
  } catch (err) { fail(res, err, 'log'); }
});

ticketRouter.patch('/:id/time/:entryId', requireAuth, requireTicketHandler, async (req, res) => {
  try {
    res.json(await tt.updateEntry({
      user: req.session.user,
      ticketId: req.ticketId,
      entryId: Number(req.params.entryId),
      body: req.body || {},
    }));
  } catch (err) { fail(res, err, 'update'); }
});

ticketRouter.delete('/:id/time/:entryId', requireAuth, requireTicketHandler, async (req, res) => {
  try {
    res.json(await tt.deleteEntry({
      user: req.session.user,
      ticketId: req.ticketId,
      entryId: Number(req.params.entryId),
    }));
  } catch (err) { fail(res, err, 'delete'); }
});

module.exports = { settingsRouter, ticketRouter };

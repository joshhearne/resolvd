// Admin masquerade ("view as user") — lets an Admin see the app exactly
// as another user does (role, project scope, dashboard) and then release
// back to their own account. Built for testing role/visibility changes.
//
// Session shape while masquerading:
//   req.session.user          → the target user (everything downstream
//                                just sees a normal session for them)
//   req.session.impersonator  → the real Admin's session user
//
// Guardrails:
//   - Only a real (non-masquerading) Admin can start; no nesting.
//   - Targets must be active and not Admin (masquerading as another
//     Admin grants nothing new for testing and would expose their
//     personal account surfaces).
//   - Start + release are written to audit_log (ticket-less rows, shown
//     in the admin dashboard activity feed).
//   - Account-sensitive actions (password, MFA, profile, prefs, push,
//     calendar tokens) are refused while masquerading — see
//     blockWhileImpersonating below.
//   - Masquerade auto-expires after MAX_MINUTES; the next request
//     restores the Admin.

const express = require('express');
const { pool } = require('../db/pool');
const { buildSessionUser } = require('../auth/session');
const { auditLog } = require('../services/ticketHelpers');

const router = express.Router();

const MAX_MINUTES = 120;

function saveSession(req) {
  return new Promise((resolve, reject) => req.session.save((e) => (e ? reject(e) : resolve())));
}

async function loadUser(id) {
  const r = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return r.rows[0] || null;
}

// Restore the real Admin into req.session.user. Re-reads the row so a
// role change / disable during the masquerade is honoured.
async function restoreImpersonator(req, reason) {
  const imp = req.session.impersonator;
  const targetId = req.session.user?.id || null;
  delete req.session.impersonator;
  delete req.session.impersonationStartedAt;
  const admin = imp ? await loadUser(imp.id) : null;
  if (!admin || admin.status !== 'active') {
    req.session.user = null;
  } else {
    req.session.user = buildSessionUser(admin);
  }
  if (imp) {
    await auditLog(pool, {
      userId: imp.id,
      action: 'impersonation_end',
      newValue: targetId ? String(targetId) : null,
      note: reason,
    }).catch((err) => console.warn('impersonation audit failed:', err.message));
  }
  await saveSession(req);
  return req.session.user;
}

// Global middleware (mounted before all /api routes): auto-release an
// expired masquerade.
async function expireImpersonation(req, res, next) {
  try {
    const started = req.session?.impersonator && req.session.impersonationStartedAt;
    if (started && Date.now() - started > MAX_MINUTES * 60 * 1000) {
      await restoreImpersonator(req, `Auto-released after ${MAX_MINUTES} minutes`);
    }
  } catch (err) {
    console.error('impersonation expiry:', err);
  }
  next();
}

// Paths an Admin must not drive on someone else's behalf.
const BLOCKED = [
  /^\/auth\/mfa\//,
  /^\/auth\/password\/change/,
  /^\/api\/users\/me\/(profile|prefs|avatar)/,
  /^\/api\/push\//,
  /^\/api\/calendar\/me\/token/,
];

function blockWhileImpersonating(req, res, next) {
  if (!req.session?.impersonator) return next();
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const path = req.originalUrl.split('?')[0];
  if (BLOCKED.some((re) => re.test(path))) {
    return res.status(403).json({
      error: 'Not available while viewing as another user. Release the masquerade first.',
      code: 'impersonation_blocked',
    });
  }
  next();
}

// GET /api/impersonate — current state (for the banner).
router.get('/', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthenticated' });
  const imp = req.session.impersonator;
  res.json(imp ? {
    active: true,
    impersonator: { id: imp.id, displayName: imp.displayName },
    started_at: new Date(req.session.impersonationStartedAt).toISOString(),
    expires_at: new Date(req.session.impersonationStartedAt + MAX_MINUTES * 60 * 1000).toISOString(),
  } : { active: false });
});

// POST /api/impersonate/release — back to the Admin's own session.
router.post('/release', async (req, res) => {
  try {
    if (!req.session?.impersonator) {
      return res.status(400).json({ error: 'Not currently viewing as another user' });
    }
    const user = await restoreImpersonator(req, 'Released');
    if (!user) return res.status(401).json({ error: 'Admin account no longer active' });
    res.json({ ok: true, user });
  } catch (err) {
    console.error('impersonation release:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/impersonate/:userId — start viewing as the target user.
router.post('/:userId', async (req, res) => {
  try {
    const me = req.session?.user;
    if (!me) return res.status(401).json({ error: 'Unauthenticated' });
    if (req.session.impersonator) {
      return res.status(400).json({ error: 'Already viewing as another user. Release first.' });
    }
    if (me.role !== 'Admin') return res.status(403).json({ error: 'Forbidden' });

    const targetId = Number(req.params.userId);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    if (targetId === me.id) return res.status(400).json({ error: 'You are already signed in as yourself' });

    const target = await loadUser(targetId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.status !== 'active') return res.status(400).json({ error: 'Only active users can be viewed as' });
    if (target.role === 'Admin') return res.status(400).json({ error: 'Cannot view as another Admin' });

    req.session.impersonator = me;
    req.session.impersonationStartedAt = Date.now();
    req.session.user = buildSessionUser(target);
    await auditLog(pool, {
      userId: me.id,
      action: 'impersonation_start',
      newValue: String(target.id),
      note: `Viewing as ${target.display_name || target.email} (${target.role})`,
    }).catch((err) => console.warn('impersonation audit failed:', err.message));
    await saveSession(req);
    res.json({ ok: true, user: req.session.user });
  } catch (err) {
    console.error('impersonation start:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
module.exports.expireImpersonation = expireImpersonation;
module.exports.blockWhileImpersonating = blockWhileImpersonating;
module.exports.MAX_MINUTES = MAX_MINUTES;

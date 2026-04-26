// Phase 3: JIT support access endpoints.
//
// Flow:
//   1. Support user (role='Support') logs in normally and hits any read
//      route. The supportAccess middleware blocks them with 403 + a
//      `support_grant_required` code so the UI prompts them to ask the
//      admin for access.
//   2. The support user (or admin on their behalf) calls
//      POST /api/support/grants/request, which creates a row in
//      `pending` status.
//   3. Admin reviews, calls POST /:id/approve with a TTL in days
//      (default 3). The row moves to `active` with expires_at.
//   4. Either side can revoke before expiry. Otherwise the grant
//      simply lapses — `expires_at < NOW()` makes it ineffective and
//      `GET /api/support/grants` reports it as expired.

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { fetchActiveGrant } = require('../middleware/supportAccess');

const router = express.Router();

const DEFAULT_DAYS = 3;
const MAX_DAYS = 14;

function effectiveStatus(row) {
  if (!row) return null;
  if (row.status === 'active' && row.expires_at && new Date(row.expires_at) <= new Date()) {
    return 'expired';
  }
  return row.status;
}

function shape(row) {
  if (!row) return null;
  return { ...row, effective_status: effectiveStatus(row) };
}

// POST /api/support/grants/request — request access (anonymous or any auth)
router.post('/grants/request', async (req, res) => {
  try {
    const { reason, requested_by_email, support_user_id, scope } = req.body || {};
    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: 'reason required' });
    }
    const sessionUser = req.session?.user;
    // If a support principal is logged in, link the grant to them; otherwise
    // an admin can pass support_user_id explicitly when filing on their behalf.
    let supportUserId = null;
    if (sessionUser && sessionUser.role === 'Support') {
      supportUserId = sessionUser.id;
    } else if (support_user_id) {
      const u = await pool.query(`SELECT id FROM users WHERE id = $1 AND role = 'Support'`, [support_user_id]);
      if (!u.rows[0]) return res.status(400).json({ error: 'support_user_id is not a Support user' });
      supportUserId = u.rows[0].id;
    }
    const result = await pool.query(
      `INSERT INTO support_access_grants
         (support_user_id, requested_by_email, reason, scope, status)
       VALUES ($1, $2, $3, COALESCE($4, 'read'), 'pending')
       RETURNING *`,
      [supportUserId, requested_by_email || null, reason.trim(), scope || null]
    );
    res.status(201).json(shape(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/support/grants — admin lists grants (filterable by status)
router.get('/grants', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const { status } = req.query;
    const params = [];
    let where = '';
    if (status) {
      params.push(status);
      where = `WHERE status = $1`;
    }
    const result = await pool.query(`
      SELECT g.*, u.display_name AS support_user_name, u.email AS support_user_email,
             a.display_name AS approved_by_name, r.display_name AS revoked_by_name
        FROM support_access_grants g
        LEFT JOIN users u ON g.support_user_id = u.id
        LEFT JOIN users a ON g.approved_by_user_id = a.id
        LEFT JOIN users r ON g.revoked_by_user_id = r.id
        ${where}
       ORDER BY g.requested_at DESC
       LIMIT 200
    `, params);
    res.json(result.rows.map(shape));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/support/grants/:id/approve — admin grants access
router.post('/grants/:id/approve', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const requestedDays = Number(req.body?.days || DEFAULT_DAYS);
    if (!Number.isFinite(requestedDays) || requestedDays < 1 || requestedDays > MAX_DAYS) {
      return res.status(400).json({ error: `days must be 1..${MAX_DAYS}` });
    }
    const grant = await pool.query(
      `SELECT * FROM support_access_grants WHERE id = $1`,
      [req.params.id]
    );
    if (!grant.rows[0]) return res.status(404).json({ error: 'Not found' });
    if (grant.rows[0].status !== 'pending') {
      return res.status(409).json({ error: `Grant is ${grant.rows[0].status}, cannot approve` });
    }
    if (!grant.rows[0].support_user_id) {
      return res.status(400).json({ error: 'Grant has no support_user_id; reject and re-file' });
    }
    const result = await pool.query(
      `UPDATE support_access_grants
          SET status = 'active',
              approved_by_user_id = $1,
              approved_at = NOW(),
              expires_at = NOW() + ($2 || ' days')::interval
        WHERE id = $3
        RETURNING *`,
      [req.session.user.id, String(requestedDays), req.params.id]
    );
    res.json(shape(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/support/grants/:id/deny — admin rejects pending grant
router.post('/grants/:id/deny', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE support_access_grants
          SET status = 'denied',
              revoked_by_user_id = $1,
              revoked_at = NOW()
        WHERE id = $2 AND status = 'pending'
        RETURNING *`,
      [req.session.user.id, req.params.id]
    );
    if (!result.rows[0]) return res.status(409).json({ error: 'Not pending or not found' });
    res.json(shape(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/support/grants/:id/revoke — admin pulls active grant
router.post('/grants/:id/revoke', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE support_access_grants
          SET status = 'revoked',
              revoked_by_user_id = $1,
              revoked_at = NOW()
        WHERE id = $2 AND status = 'active'
        RETURNING *`,
      [req.session.user.id, req.params.id]
    );
    if (!result.rows[0]) return res.status(409).json({ error: 'Not active or not found' });
    res.json(shape(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/support/grants/me — support user checks own status
router.get('/grants/me', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'Support') {
    return res.json({ active: null });
  }
  try {
    const grant = await fetchActiveGrant(req.session.user.id);
    res.json({ active: shape(grant) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/support/access-log — admin views every recorded support read
router.get('/access-log', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT l.*, u.display_name AS user_name, u.email AS user_email
        FROM support_access_log l
        LEFT JOIN users u ON l.user_id = u.id
       ORDER BY l.created_at DESC
       LIMIT 500
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

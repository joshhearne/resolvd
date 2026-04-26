// Phase 3: JIT support access middleware.
//
// Users with role='Support' can authenticate normally but every request
// is gated by an *active* grant in support_access_grants. A grant is
// "active" when status='active', expires_at > now(), and revoked_at IS NULL.
// Status transitions to logical 'expired' implicitly when the clock passes
// expires_at — we never run a background job; queries enforce the window.

const { pool } = require('../db/pool');

const ACTIVE_GRANT_SQL = `
  SELECT id, expires_at, scope
    FROM support_access_grants
   WHERE support_user_id = $1
     AND status = 'active'
     AND revoked_at IS NULL
     AND expires_at > NOW()
   ORDER BY expires_at DESC
   LIMIT 1
`;

async function fetchActiveGrant(userId) {
  const r = await pool.query(ACTIVE_GRANT_SQL, [userId]);
  return r.rows[0] || null;
}

// Gates any route a support principal touches. Non-support users pass
// through unchanged.
function requireSupportAccessIfSupport(req, res, next) {
  const user = req.session?.user;
  if (!user || user.role !== 'Support') return next();

  fetchActiveGrant(user.id)
    .then(grant => {
      if (!grant) {
        return res.status(403).json({
          error: 'Support access not granted or expired',
          code: 'support_grant_required',
        });
      }
      // Read-only enforcement on non-GET methods when scope === 'read'.
      if (grant.scope === 'read' && req.method !== 'GET') {
        return res.status(403).json({
          error: 'Active grant is read-only',
          code: 'support_grant_readonly',
        });
      }
      req.supportGrant = grant;
      next();
    })
    .catch(err => {
      console.error('supportAccess middleware error:', err);
      res.status(500).json({ error: 'Server error' });
    });
}

// Per-route logger. Call from inside handlers when you want fine-grained
// records (e.g. ticket view, attachment download). The middleware above
// already covers coarse access-vs-no-access.
async function logSupportRead(req, { action, targetTable, targetId } = {}) {
  if (!req.supportGrant) return;
  try {
    await pool.query(
      `INSERT INTO support_access_log
         (grant_id, user_id, action, target_table, target_id, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        req.supportGrant.id,
        req.session.user.id,
        action,
        targetTable || null,
        targetId || null,
        (req.ip || '').slice(0, 64),
        (req.headers['user-agent'] || '').slice(0, 256),
      ]
    );
  } catch (err) {
    console.error('logSupportRead failed:', err.message);
  }
}

module.exports = { requireSupportAccessIfSupport, logSupportRead, fetchActiveGrant };

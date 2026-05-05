const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db/pool');
const { getAuthSettings } = require('../services/authSettings');
const { sendPasswordResetEmail } = require('../services/email');
const entra = require('../auth/providers/entra');
const google = require('../auth/providers/google');
const local = require('../auth/providers/local');
const mfa = require('../auth/mfa');
const { generateToken, hashToken } = require('../auth/tokens');
const {
  upsertProviderUser,
  buildSessionUser,
  mfaRequired,
  loginUser,
  isBootstrap,
} = require('../auth/session');
const { saveAvatarFromBytes, fetchAndSaveAvatarFromUrl } = require('../services/avatar');

const router = express.Router();

const PROVIDERS = { entra, google };

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' },
});

const resetRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many reset requests' },
});

// ─── Public discovery: which login methods are enabled ───────────────────────
router.get('/methods', async (req, res) => {
  try {
    const s = await getAuthSettings();
    const bootstrap = await isBootstrap();
    res.json({
      entra: !!s?.entra_enabled && !!process.env.AZURE_CLIENT_ID,
      google: !!s?.google_enabled && !!process.env.GOOGLE_CLIENT_ID,
      local: !!s?.local_enabled,
      bootstrap,
    });
  } catch (err) {
    console.error('GET /auth/methods error:', err);
    res.status(500).json({ error: 'Failed to load auth methods' });
  }
});

// ─── SSO providers (Entra, Google) ───────────────────────────────────────────
async function handleSsoLogin(providerName, req, res) {
  const provider = PROVIDERS[providerName];
  if (!provider) return res.status(404).json({ error: 'Unknown provider' });
  if (!(await provider.isEnabled())) return res.status(403).json({ error: `${providerName} login disabled` });
  try {
    const url = await provider.getAuthUrl(req);
    res.redirect(url);
  } catch (err) {
    console.error(`${providerName} auth url error:`, err);
    res.status(500).json({ error: 'Failed to initiate login' });
  }
}

async function handleSsoCallback(providerName, req, res) {
  const provider = PROVIDERS[providerName];
  if (!provider) return res.status(404).json({ error: 'Unknown provider' });
  try {
    const profile = await provider.handleCallback(req);
    const user = await upsertProviderUser(profile);
    // Best-effort avatar sync. Failures are silent — login still succeeds.
    if (profile.pictureBytes && profile.pictureMime) {
      await saveAvatarFromBytes(user.id, profile.pictureBytes, profile.pictureMime).catch(() => {});
    } else if (profile.pictureUrl) {
      await fetchAndSaveAvatarFromUrl(user.id, profile.pictureUrl).catch(() => {});
    }
    if (await mfaRequired(user)) {
      await loginUser(req, user, { pendingMfa: true });
      return res.redirect('/mfa-challenge');
    }
    await loginUser(req, user);
    res.redirect('/');
  } catch (err) {
    console.error(`${providerName} callback error:`, err);
    const msg = encodeURIComponent(err.message || 'Authentication failed');
    res.redirect(`/login?error=${msg}`);
  }
}

router.get('/login', (req, res) => handleSsoLogin('entra', req, res));
router.get('/callback', (req, res) => handleSsoCallback('entra', req, res));
router.get('/google/login', (req, res) => handleSsoLogin('google', req, res));
router.get('/google/callback', (req, res) => handleSsoCallback('google', req, res));

// ─── Local username/password ─────────────────────────────────────────────────
router.post('/local/login', loginLimiter, async (req, res) => {
  try {
    if (!(await local.isEnabled())) return res.status(403).json({ error: 'Local login disabled' });
    const { email, password } = req.body || {};
    const user = await local.authenticate({ email, password });
    if (await mfaRequired(user)) {
      await loginUser(req, user, { pendingMfa: true });
      return res.json({ pendingMfa: true });
    }
    await loginUser(req, user);
    res.json({ user: buildSessionUser(user) });
  } catch (err) {
    if (err.code === 'INVALID_CREDENTIALS') return res.status(401).json({ error: 'Invalid email or password' });
    if (err.code === 'ACCOUNT_LOCKED') return res.status(423).json({ error: err.message });
    if (err.code === 'ACCOUNT_DISABLED') return res.status(403).json({ error: err.message });
    if (err.code === 'ACCOUNT_INVITED') return res.status(403).json({ error: err.message });
    if (err.code === 'WRONG_PROVIDER') return res.status(409).json({ error: err.message, provider: err.provider });
    console.error('local login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ─── Local bootstrap: create first Admin when DB has no users ───────────────
router.post('/local/bootstrap', loginLimiter, async (req, res) => {
  try {
    if (!(await isBootstrap())) {
      return res.status(409).json({ error: 'Setup already complete' });
    }
    const { email, password, displayName } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    const trimmedEmail = String(email).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }
    const validation = local.validatePassword(password);
    if (validation) return res.status(400).json({ error: validation });

    const passwordHash = await local.hashPassword(password);
    const name = (displayName && String(displayName).trim()) || trimmedEmail.split('@')[0];

    // Atomic guard: insert only if no users exist. Loses race → 0 rows.
    const r = await pool.query(
      `INSERT INTO users (display_name, email, role, auth_provider, status, password_hash, password_updated_at, last_login, last_login_provider)
         SELECT $1, $2, 'Admin', 'local', 'active', $3, NOW(), NOW(), 'local'
         WHERE NOT EXISTS (SELECT 1 FROM users)
         RETURNING *`,
      [name, trimmedEmail, passwordHash]
    );
    if (!r.rows[0]) {
      return res.status(409).json({ error: 'Setup already complete' });
    }
    const user = r.rows[0];
    await loginUser(req, user);
    res.json({ user: buildSessionUser(user) });
  } catch (err) {
    console.error('local bootstrap error:', err);
    res.status(500).json({ error: 'Bootstrap failed' });
  }
});

// ─── MFA challenge during login ──────────────────────────────────────────────
router.post('/mfa/challenge', async (req, res) => {
  const userId = req.session?.pendingMfaUserId;
  if (!userId) return res.status(400).json({ error: 'No pending MFA challenge' });
  const { token, recoveryCode } = req.body || {};
  try {
    const r = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = r.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    let ok = false;
    if (user.mfa_enabled && token) {
      ok = mfa.verifyToken(user.mfa_secret, token);
    }
    if (!ok && recoveryCode) {
      ok = await mfa.consumeRecoveryCode(user.id, recoveryCode);
    }
    if (!ok) return res.status(401).json({ error: 'Invalid code' });

    await loginUser(req, user);
    res.json({ user: buildSessionUser(user) });
  } catch (err) {
    console.error('mfa challenge error:', err);
    res.status(500).json({ error: 'MFA verification failed' });
  }
});

// ─── MFA enrollment (authenticated user) ─────────────────────────────────────
function requireSessionUser(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthenticated' });
  next();
}

router.post('/mfa/setup', requireSessionUser, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const r = await pool.query('SELECT email, display_name FROM users WHERE id = $1', [userId]);
    const u = r.rows[0];
    const secret = mfa.generateSecret();
    // Store as pending in session — only persist on confirm
    req.session.pendingMfaSecret = secret;
    const qr = await mfa.buildOtpAuth({
      secret,
      accountName: u.email || u.display_name || `user-${userId}`,
      issuer: 'IssueTracker',
    });
    req.session.save(err => {
      if (err) return res.status(500).json({ error: 'Session save failed' });
      res.json({ secret, qrDataUrl: qr.qrDataUrl, otpauth: qr.otpauth });
    });
  } catch (err) {
    console.error('mfa setup error:', err);
    res.status(500).json({ error: 'MFA setup failed' });
  }
});

router.post('/mfa/confirm', requireSessionUser, async (req, res) => {
  try {
    const { token } = req.body || {};
    const secret = req.session.pendingMfaSecret;
    if (!secret) return res.status(400).json({ error: 'No pending MFA setup' });
    if (!mfa.verifyToken(secret, token)) return res.status(401).json({ error: 'Invalid code' });
    const userId = req.session.user.id;
    await pool.query(
      'UPDATE users SET mfa_secret = $1, mfa_enabled = TRUE WHERE id = $2',
      [secret, userId]
    );
    const recoveryCodes = await mfa.generateRecoveryCodes(userId);
    req.session.pendingMfaSecret = null;
    req.session.user.mfaEnabled = true;
    req.session.save(() => res.json({ ok: true, recoveryCodes }));
  } catch (err) {
    console.error('mfa confirm error:', err);
    res.status(500).json({ error: 'MFA confirm failed' });
  }
});

router.post('/mfa/disable', requireSessionUser, async (req, res) => {
  try {
    const { password, token } = req.body || {};
    const userId = req.session.user.id;
    const r = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = r.rows[0];
    // Require either current password (local users) or a valid TOTP code to disable
    let allowed = false;
    if (user.auth_provider === 'local' && password) {
      allowed = await local.verifyPassword(user.password_hash, password);
    } else if (token) {
      allowed = mfa.verifyToken(user.mfa_secret, token);
    }
    if (!allowed) return res.status(401).json({ error: 'Verification required to disable MFA' });

    // Block disable if admin enforces MFA for this role
    const settings = await getAuthSettings();
    const required = (settings?.mfa_required_roles || '').split(',').map(s => s.trim()).filter(Boolean);
    if (required.includes(user.role)) {
      return res.status(403).json({ error: `MFA is required for the ${user.role} role and cannot be disabled` });
    }

    await pool.query('UPDATE users SET mfa_secret = NULL, mfa_enabled = FALSE WHERE id = $1', [userId]);
    await pool.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
    req.session.user.mfaEnabled = false;
    req.session.save(() => res.json({ ok: true }));
  } catch (err) {
    console.error('mfa disable error:', err);
    res.status(500).json({ error: 'MFA disable failed' });
  }
});

router.post('/mfa/recovery/regenerate', requireSessionUser, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const r = await pool.query('SELECT mfa_enabled FROM users WHERE id = $1', [userId]);
    if (!r.rows[0]?.mfa_enabled) return res.status(400).json({ error: 'MFA not enabled' });
    const codes = await mfa.generateRecoveryCodes(userId);
    res.json({ recoveryCodes: codes });
  } catch (err) {
    console.error('recovery regenerate error:', err);
    res.status(500).json({ error: 'Failed to regenerate codes' });
  }
});

// ─── Password reset ──────────────────────────────────────────────────────────
router.post('/password/forgot', resetRequestLimiter, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email required' });
    const r = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]);
    const user = r.rows[0];
    // Always 200 to prevent enumeration
    if (!user || user.auth_provider !== 'local' || user.status !== 'active') {
      return res.json({ ok: true });
    }
    const token = generateToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await pool.query(
      'INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
      [tokenHash, user.id, expiresAt]
    );
    const baseUrl = (process.env.FRONTEND_URL || `${req.protocol}://${req.hostname}`).replace(/\/$/, '');
    await sendPasswordResetEmail({ to: user.email, resetUrl: `${baseUrl}/reset-password/${token}` });
    res.json({ ok: true });
  } catch (err) {
    console.error('password forgot error:', err);
    res.json({ ok: true }); // never leak
  }
});

router.post('/password/reset', async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
    const validation = local.validatePassword(password);
    if (validation) return res.status(400).json({ error: validation });

    const tokenHash = hashToken(token);
    const r = await pool.query(
      `SELECT * FROM password_reset_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()`,
      [tokenHash]
    );
    const row = r.rows[0];
    if (!row) return res.status(400).json({ error: 'Invalid or expired token' });

    const hash = await local.hashPassword(password);
    await pool.query(
      `UPDATE users SET password_hash = $1, password_updated_at = NOW(),
         failed_login_count = 0, locked_until = NULL WHERE id = $2`,
      [hash, row.user_id]
    );
    await pool.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1', [row.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('password reset error:', err);
    res.status(500).json({ error: 'Reset failed' });
  }
});

router.post('/password/change', requireSessionUser, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const validation = local.validatePassword(newPassword);
    if (validation) return res.status(400).json({ error: validation });
    const userId = req.session.user.id;
    const r = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = r.rows[0];
    if (user.auth_provider !== 'local' || !user.password_hash) {
      return res.status(400).json({ error: 'Account does not use password login' });
    }
    if (!(await local.verifyPassword(user.password_hash, currentPassword))) {
      return res.status(401).json({ error: 'Current password incorrect' });
    }
    const hash = await local.hashPassword(newPassword);
    await pool.query(
      'UPDATE users SET password_hash = $1, password_updated_at = NOW() WHERE id = $2',
      [hash, userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('password change error:', err);
    res.status(500).json({ error: 'Change failed' });
  }
});

// ─── Logout ──────────────────────────────────────────────────────────────────
router.get('/logout', (req, res) => {
  const provider = req.session?.user?.authProvider;
  req.session.destroy(() => {
    const base = `${req.protocol}://${req.hostname}/`;
    if (provider === 'entra') {
      return res.redirect(entra.logoutRedirect(base));
    }
    res.redirect('/login');
  });
});

// ─── Current session ─────────────────────────────────────────────────────────
const PREF_DEFAULTS = Object.freeze({
  scope_follows_filter: true,
  ctrl_enter_to_post: true,
  auto_follow_on_comment: true,
  email_on_comment: true,
  email_on_status_change: true,
  email_on_assignment: true,
  push_on_assignment: false,
  push_on_mention: false,
  confirm_before_close: false,
  compact_mode: false,
  phonetic_readback: true,
  default_ticket_sort: 'updated_at_desc',
  // Locale overrides — empty string means "inherit org branding".
  date_style_override: '',
  time_style_override: '',
  timezone_override: '',
});

router.get('/me', async (req, res) => {
  if (!req.session?.user) {
    if (req.session?.pendingMfaUserId) {
      return res.status(401).json({ error: 'MFA challenge pending', pendingMfa: true });
    }
    return res.status(401).json({ error: 'Unauthenticated' });
  }
  try {
    const r = await pool.query('SELECT preferences FROM users WHERE id = $1', [req.session.user.id]);
    const stored = r.rows[0]?.preferences || {};
    res.json({ ...req.session.user, preferences: { ...PREF_DEFAULTS, ...stored } });
  } catch {
    res.json({ ...req.session.user, preferences: { ...PREF_DEFAULTS } });
  }
});

module.exports = router;

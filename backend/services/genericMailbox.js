// Loop-prevention guard for vendor contact emails.
//
// External helpdesks (Zendesk, SuperOps, etc.) commonly auto-reply from
// generic mailboxes (support@, helpdesk@, no-reply@). Adding such an
// address as a Resolvd contact and replying to a comment from there
// kicks off a ping-pong loop. We refuse those local-parts at write time.
//
// Default list is in code; admins can extend via auth_settings.email_blocklist
// (comma-separated additional local-parts).

const { pool } = require('../db/pool');

const DEFAULT_BLOCKLIST = new Set([
  'support', 'helpdesk', 'help', 'tickets', 'service',
  'noreply', 'no-reply', 'do-not-reply', 'donotreply',
  'mailer', 'mailer-daemon', 'postmaster',
  'info', 'contact', 'inquiries', 'enquiries',
  'admin', 'administrator', 'root', 'webmaster',
  'sales', 'billing', 'accounts', 'invoices',
  'marketing', 'newsletter', 'notifications',
  'abuse', 'security',
  'hello', 'hi', 'team',
]);

let cachedExtra = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60_000;

async function loadExtraBlocklist() {
  const now = Date.now();
  if (cachedExtra && (now - cachedAt) < CACHE_TTL_MS) return cachedExtra;
  try {
    const r = await pool.query(`SELECT email_blocklist FROM auth_settings WHERE id = 1`);
    const raw = r.rows[0]?.email_blocklist || '';
    cachedExtra = new Set(
      raw.split(',')
         .map(s => s.trim().toLowerCase())
         .filter(Boolean)
    );
  } catch {
    cachedExtra = new Set();
  }
  cachedAt = now;
  return cachedExtra;
}

function localPart(email) {
  if (typeof email !== 'string') return null;
  const at = email.indexOf('@');
  if (at < 1 || at === email.length - 1) return null;
  return email.slice(0, at).toLowerCase().trim();
}

function isBasicallyValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function checkContactEmail(email) {
  if (!isBasicallyValidEmail(email)) {
    return { ok: false, code: 'invalid_email', message: 'Email address is not valid' };
  }
  const lp = localPart(email);
  if (!lp) {
    return { ok: false, code: 'invalid_email', message: 'Email address is not valid' };
  }
  if (DEFAULT_BLOCKLIST.has(lp)) {
    return {
      ok: false,
      code: 'generic_mailbox',
      message: `"${lp}@" is a generic mailbox. Use a real person's address to avoid auto-reply loops with the vendor's helpdesk.`,
    };
  }
  const extra = await loadExtraBlocklist();
  if (extra.has(lp)) {
    return {
      ok: false,
      code: 'generic_mailbox',
      message: `"${lp}@" is on this workspace's blocked-mailbox list.`,
    };
  }
  return { ok: true };
}

function invalidateCache() {
  cachedExtra = null;
  cachedAt = 0;
}

module.exports = { checkContactEmail, isBasicallyValidEmail, invalidateCache };

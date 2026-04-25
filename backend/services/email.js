const msal = require('@azure/msal-node');
const fetch = require('node-fetch');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const { getAuthSettings } = require('./authSettings');
const { getBranding } = require('./branding');

const FALLBACK_FROM = process.env.MAIL_FROM || 'noreply@localhost';
const APP_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

// ─── Backend: Microsoft Graph ────────────────────────────────────────────────
let _graphTokenCache = null;
async function getGraphAppToken() {
  if (_graphTokenCache && _graphTokenCache.expiresAt > Date.now() + 60000) {
    return _graphTokenCache.token;
  }
  const app = new msal.ConfidentialClientApplication({
    auth: {
      clientId: process.env.AZURE_CLIENT_ID,
      authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
      clientSecret: process.env.AZURE_CLIENT_SECRET,
    },
  });
  const result = await app.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default'],
  });
  _graphTokenCache = { token: result.accessToken, expiresAt: result.expiresOn.getTime() };
  return result.accessToken;
}

async function sendViaGraph({ from, to, subject, html }) {
  const token = await getGraphAppToken();
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: 'HTML', content: html },
          toRecipients: to.map(addr => ({ emailAddress: { address: addr } })),
          from: { emailAddress: { address: from } },
        },
        saveToSentItems: false,
      }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph sendMail ${res.status}: ${text}`);
  }
}

// ─── Backend: Gmail API (Workspace service account or OAuth client) ──────────
// Uses the same OAuth client credentials as login; admin must grant gmail.send
// scope when configuring the Google app, and the from-address mailbox must be
// authorized for impersonation (or use SMTP fallback for consumer accounts).
async function sendViaGmail({ from, to, subject, html }) {
  const settings = await getAuthSettings();
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    throw new Error('Gmail backend requires GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET');
  }
  // Service-account flow if a JSON key is provided via env, otherwise SMTP fallback
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!keyJson) {
    throw new Error('Gmail API backend requires GOOGLE_SERVICE_ACCOUNT_JSON (service account with domain-wide delegation). Use SMTP backend for OAuth-only setups.');
  }
  const key = JSON.parse(keyJson);
  const jwt = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/gmail.send'],
    subject: from,
  });
  await jwt.authorize();
  const gmail = google.gmail({ version: 'v1', auth: jwt });

  const raw = Buffer.from(
    `From: ${from}\r\nTo: ${to.join(', ')}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}`
  ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
}

// ─── Backend: SMTP ───────────────────────────────────────────────────────────
let _smtpTransport = null;
let _smtpKey = '';
function getSmtpTransport(settings) {
  const host = settings.smtp_host || process.env.SMTP_HOST;
  const port = settings.smtp_port || parseInt(process.env.SMTP_PORT || '587', 10);
  const user = settings.smtp_user || process.env.SMTP_USER;
  const pass = settings.smtp_password || process.env.SMTP_PASSWORD;
  const secure = settings.smtp_secure ?? (process.env.SMTP_SECURE === 'true');
  const key = `${host}|${port}|${user}|${secure}`;
  if (_smtpTransport && _smtpKey === key) return _smtpTransport;
  _smtpTransport = nodemailer.createTransport({
    host, port, secure,
    auth: user ? { user, pass } : undefined,
  });
  _smtpKey = key;
  return _smtpTransport;
}

async function sendViaSmtp({ from, to, subject, html }) {
  const settings = await getAuthSettings();
  const transport = getSmtpTransport(settings || {});
  await transport.sendMail({ from, to: to.join(', '), subject, html });
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────
function pickFromAddress(settings, backend) {
  if (backend === 'smtp') return settings?.smtp_from || process.env.SMTP_FROM || FALLBACK_FROM;
  if (backend === 'gmail') return settings?.google_mail_from || FALLBACK_FROM;
  return FALLBACK_FROM; // graph
}

async function sendMail({ to, subject, html }) {
  const addresses = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!addresses.length) return;
  const settings = await getAuthSettings();
  const backend = settings?.email_backend || 'graph';
  const from = pickFromAddress(settings, backend);
  try {
    if (backend === 'smtp') await sendViaSmtp({ from, to: addresses, subject, html });
    else if (backend === 'gmail') await sendViaGmail({ from, to: addresses, subject, html });
    else await sendViaGraph({ from, to: addresses, subject, html });
  } catch (err) {
    console.error(`sendMail (${backend}) error:`, err.message);
  }
}

// ─── Templates ───────────────────────────────────────────────────────────────
function ticketUrl(ticketId) { return `${APP_URL}/tickets/${ticketId}`; }

async function baseHtml(title, body) {
  let siteName = 'Issue Tracker';
  let primary = '#1e40af';
  try {
    const b = await getBranding();
    if (b?.site_name) siteName = b.site_name;
    if (b?.primary_color) primary = b.primary_color;
  } catch (_) {}
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#f9fafb;margin:0;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #e5e7eb;overflow:hidden">
    <div style="background:${primary};padding:16px 24px">
      <span style="color:#fff;font-weight:700;font-size:16px">${siteName}</span>
    </div>
    <div style="padding:24px">
      <h2 style="margin:0 0 16px;font-size:16px;color:#111827">${title}</h2>
      ${body}
    </div>
    <div style="padding:12px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af">
      <a href="${APP_URL}" style="color:#1d4ed8">${APP_URL}</a>
    </div>
  </div>
</body></html>`;
}

async function notifyStatusChange(pool, { ticket, oldStatus, newStatus, actorId }) {
  const emails = await getFollowerEmails(pool, ticket.id, actorId);
  if (!emails.length) return;
  const isClosed = newStatus === 'Closed';
  const subject = isClosed
    ? `[${ticket.mot_ref}] Ticket closed`
    : `[${ticket.mot_ref}] Status updated: ${oldStatus} → ${newStatus}`;
  const body = `
    <p style="color:#374151;font-size:14px;margin:0 0 12px">
      ${isClosed
        ? `Ticket <strong>${ticket.mot_ref}</strong> has been closed.`
        : `Status for <strong>${ticket.mot_ref}</strong> has been updated from <strong>${oldStatus}</strong> to <strong>${newStatus}</strong>.`}
    </p>
    <p style="color:#374151;font-size:14px;margin:0 0 16px"><strong>${ticket.title}</strong></p>
    <a href="${ticketUrl(ticket.id)}" style="display:inline-block;background:#1e40af;color:#fff;text-decoration:none;padding:8px 16px;border-radius:6px;font-size:14px;font-weight:600">View Ticket</a>`;
  await sendMail({ to: emails, subject, html: await baseHtml(subject, body) });
}

async function notifyPendingReview(pool, { ticket, actorId }) {
  const admins = await pool.query(
    `SELECT email FROM users WHERE role = 'Admin' AND id != $1 AND email IS NOT NULL AND email != ''`,
    [actorId]
  );
  const emails = admins.rows.map(r => r.email).filter(Boolean);
  if (!emails.length) return;
  const subject = `[${ticket.mot_ref}] Needs review — action required`;
  const body = `
    <p style="color:#374151;font-size:14px;margin:0 0 12px">
      Ticket <strong>${ticket.mot_ref}</strong> has been flagged for review and requires your attention.
    </p>
    <p style="color:#374151;font-size:14px;margin:0 0 16px"><strong>${ticket.title}</strong></p>
    <a href="${ticketUrl(ticket.id)}" style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;padding:8px 16px;border-radius:6px;font-size:14px;font-weight:600">Review Ticket</a>`;
  await sendMail({ to: emails, subject, html: await baseHtml(subject, body) });
}

async function notifyNewComment(pool, { ticket, comment, actorId, actorName }) {
  const emails = await getFollowerEmails(pool, ticket.id, actorId);
  if (!emails.length) return;
  const subject = `[${ticket.mot_ref}] New comment added`;
  const preview = comment.length > 300 ? comment.slice(0, 300) + '…' : comment;
  const body = `
    <p style="color:#374151;font-size:14px;margin:0 0 12px">
      <strong>${actorName || 'Someone'}</strong> added a comment on <strong>${ticket.mot_ref}</strong>:
    </p>
    <blockquote style="border-left:3px solid #e5e7eb;margin:0 0 16px;padding:8px 16px;color:#6b7280;font-size:14px;white-space:pre-wrap">${preview}</blockquote>
    <a href="${ticketUrl(ticket.id)}" style="display:inline-block;background:#1e40af;color:#fff;text-decoration:none;padding:8px 16px;border-radius:6px;font-size:14px;font-weight:600">View Ticket</a>`;
  await sendMail({ to: emails, subject, html: await baseHtml(subject, body) });
}

async function sendInviteEmail({ to, inviteUrl, invitedByName, role }) {
  const subject = `You've been invited to the issue tracker`;
  const body = `
    <p style="color:#374151;font-size:14px;margin:0 0 12px">
      <strong>${invitedByName || 'An administrator'}</strong> invited you to join as <strong>${role}</strong>.
    </p>
    <p style="color:#374151;font-size:14px;margin:0 0 16px">
      Click the link below to accept and set up your account. The link expires soon.
    </p>
    <a href="${inviteUrl}" style="display:inline-block;background:#1e40af;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:600">Accept Invite</a>
    <p style="color:#9ca3af;font-size:12px;margin:16px 0 0;word-break:break-all">${inviteUrl}</p>`;
  await sendMail({ to, subject, html: await baseHtml(subject, body) });
}

async function sendPasswordResetEmail({ to, resetUrl }) {
  const subject = `Password reset request`;
  const body = `
    <p style="color:#374151;font-size:14px;margin:0 0 12px">
      A password reset was requested for your account. If this wasn't you, ignore this email.
    </p>
    <a href="${resetUrl}" style="display:inline-block;background:#1e40af;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:600">Reset Password</a>
    <p style="color:#9ca3af;font-size:12px;margin:16px 0 0;word-break:break-all">${resetUrl}</p>`;
  await sendMail({ to, subject, html: await baseHtml(subject, body) });
}

async function getFollowerEmails(pool, ticketId, excludeUserId) {
  const result = await pool.query(`
    SELECT DISTINCT u.email
    FROM users u
    WHERE u.email IS NOT NULL AND u.email != ''
      AND u.id != $2
      AND (
        u.id IN (SELECT user_id FROM ticket_followers WHERE ticket_id = $1)
        OR u.id IN (SELECT submitted_by FROM tickets WHERE id = $1 AND submitted_by IS NOT NULL)
      )
  `, [ticketId, excludeUserId || 0]);
  return result.rows.map(r => r.email);
}

module.exports = {
  sendMail,
  notifyStatusChange,
  notifyPendingReview,
  notifyNewComment,
  sendInviteEmail,
  sendPasswordResetEmail,
};

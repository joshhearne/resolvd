const msal = require('@azure/msal-node');
const fetch = require('node-fetch');

const MAIL_FROM = process.env.MAIL_FROM || 'noreply@motorhomesoftexas.com';
const APP_URL = (process.env.FRONTEND_URL || 'https://issues.gomotx.com').replace(/\/$/, '');

let _tokenCache = null;

async function getAppToken() {
  if (_tokenCache && _tokenCache.expiresAt > Date.now() + 60000) {
    return _tokenCache.token;
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
  _tokenCache = { token: result.accessToken, expiresAt: result.expiresOn.getTime() };
  return result.accessToken;
}

function ticketUrl(ticketId) {
  return `${APP_URL}/tickets/${ticketId}`;
}

function baseHtml(title, body) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#f9fafb;margin:0;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #e5e7eb;overflow:hidden">
    <div style="background:#1e40af;padding:16px 24px">
      <span style="color:#fff;font-weight:700;font-size:16px">MOT Operations</span>
    </div>
    <div style="padding:24px">
      <h2 style="margin:0 0 16px;font-size:16px;color:#111827">${title}</h2>
      ${body}
    </div>
    <div style="padding:12px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af">
      You received this because you follow this ticket or submitted it. <a href="${APP_URL}" style="color:#1d4ed8">Manage notifications</a>
    </div>
  </div>
</body>
</html>`;
}

async function sendMail({ to, subject, html }) {
  const addresses = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!addresses.length) return;

  try {
    const token = await getAppToken();
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAIL_FROM)}/sendMail`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            subject,
            body: { contentType: 'HTML', content: html },
            toRecipients: addresses.map(addr => ({ emailAddress: { address: addr } })),
            from: { emailAddress: { address: MAIL_FROM, name: 'MOT Operations' } },
          },
          saveToSentItems: false,
        }),
      }
    );
    if (!res.ok) {
      const text = await res.text();
      console.error(`sendMail failed ${res.status}:`, text);
    }
  } catch (err) {
    console.error('sendMail error:', err.message);
  }
}

// ─── Notification helpers ────────────────────────────────────────────────────

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

  await sendMail({ to: emails, subject, html: baseHtml(subject, body) });
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

  await sendMail({ to: emails, subject, html: baseHtml(subject, body) });
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

  await sendMail({ to: emails, subject, html: baseHtml(subject, body) });
}

// Returns emails of all followers + submitter, excluding actorId
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

module.exports = { sendMail, notifyStatusChange, notifyPendingReview, notifyNewComment };

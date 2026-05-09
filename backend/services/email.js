const msal = require('@azure/msal-node');
const fetch = require('node-fetch');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const { getAuthSettings } = require('./authSettings');
const { getBranding } = require('./branding');

const FALLBACK_FROM = process.env.MAIL_FROM || 'noreply@localhost';

// Wraps a display name in RFC 5322-quoted form when needed and returns
// `"Display Name" <addr>`. Falls back to bare address when no name.
function formatAddress(address, displayName) {
  if (!address) return '';
  if (!displayName) return address;
  // Always quote — safe regardless of special chars in the name.
  const escaped = String(displayName).replace(/[\\"]/g, '\\$&');
  return `"${escaped}" <${address}>`;
}

// ─── MIME helper (Gmail raw send) ────────────────────────────────────────────
function buildRawMimeEmail({ from, fromName, to, subject, html, headers, replyTo, attachments }) {
  const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const toStr = Array.isArray(to) ? to.join(', ') : to;
  const fromHeader = fromName ? formatAddress(from, fromName) : from;
  const lines = [`From: ${fromHeader}`, `To: ${toStr}`, `Subject: ${subject}`, 'MIME-Version: 1.0'];
  if (replyTo) lines.push(`Reply-To: ${replyTo}`);
  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      if (/^[a-z0-9-]+$/i.test(k)) lines.push(`${k}: ${String(v).replace(/[\r\n]/g, ' ')}`);
    }
  }
  if (!attachments?.length) {
    lines.push('Content-Type: text/html; charset=UTF-8', '', html);
  } else {
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, '',
      `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', '', html);
    for (const att of attachments) {
      lines.push(`--${boundary}`,
        `Content-Type: ${att.mimetype}`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${att.filename}"`,
        '', att.data.toString('base64'));
    }
    lines.push(`--${boundary}--`);
  }
  return Buffer.from(lines.join('\r\n'))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

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

async function sendViaGraph({ from, fromName, to, subject, html, headers, replyTo, attachments }) {
  const token = await getGraphAppToken();
  const message = {
    subject,
    body: { contentType: 'HTML', content: html },
    toRecipients: to.map(addr => ({ emailAddress: { address: addr } })),
    from: { emailAddress: fromName ? { name: fromName, address: from } : { address: from } },
  };
  if (replyTo) message.replyTo = [{ emailAddress: { address: replyTo } }];
  if (headers && Object.keys(headers).length) {
    message.internetMessageHeaders = Object.entries(headers)
      .filter(([k]) => /^x-/i.test(k))
      .map(([name, value]) => ({ name, value: String(value) }));
  }
  if (attachments?.length) {
    message.attachments = attachments.map(a => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: a.filename, contentType: a.mimetype,
      contentBytes: a.data.toString('base64'),
    }));
  }
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, saveToSentItems: false }),
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
async function sendViaGmail({ from, fromName, to, subject, html, headers, replyTo, attachments }) {
  const settings = await getAuthSettings();
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    throw new Error('Gmail backend requires GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET');
  }
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
  const raw = buildRawMimeEmail({ from, fromName, to, subject, html, headers, replyTo, attachments });
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

async function sendViaSmtp({ from, fromName, to, subject, html, headers, replyTo, attachments }) {
  const settings = await getAuthSettings();
  const transport = getSmtpTransport(settings || {});
  await transport.sendMail({
    from: fromName ? formatAddress(from, fromName) : from,
    to: to.join(', '), subject, html,
    replyTo: replyTo || undefined,
    headers: headers || undefined,
    attachments: attachments?.map(a => ({ filename: a.filename, content: a.data, contentType: a.mimetype })),
  });
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────
function pickFromAddress(settings, backend) {
  if (backend === 'smtp') return settings?.smtp_from || process.env.SMTP_FROM || FALLBACK_FROM;
  if (backend === 'gmail') return settings?.google_mail_from || FALLBACK_FROM;
  return FALLBACK_FROM; // graph
}

// senderName, when given, becomes the display-name portion of the From
// header — e.g. `"Josh Hearne (Resolvd)" <resolvd@motorhomesoftexas.com>`.
// The address itself is always the connected mailbox; we no longer spoof
// From with the submitter's address. This guarantees vendor replies land
// in the system inbox instead of a personal mailbox.
async function sendMail({ to, subject, html, headers, replyTo, senderName, attachments, projectId }) {
  const addresses = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!addresses.length) return;

  // Prefer a project-scoped account when projectId is given (lets each
  // project have its own dedicated outbound identity, e.g. helpdesk
  // tickets go from helpdesk@…). Falls through to the global active
  // account when no scope match. Then falls through again to the legacy
  // env-backed dispatch for installs that haven't migrated to OAuth.
  try {
    const eb = require('./emailBackends');
    let chosen = null;
    if (projectId) {
      const scopes = require('./emailScopes');
      const scoped = await scopes.resolveOutboundAccount(projectId);
      if (scoped) {
        const { decryptRow } = require('./fields');
        const acct = { ...scoped };
        await decryptRow('email_backend_accounts', acct);
        chosen = acct;
      }
    }
    if (!chosen) chosen = await eb.getActiveAccount();
    if (chosen) {
      return await sendMailViaAccount(chosen, { to: addresses, subject, html, headers, replyTo, senderName, attachments });
    }
  } catch (err) {
    console.error('sendMail: account lookup failed, falling back to legacy:', err.message);
  }

  const settings = await getAuthSettings();
  const backend = settings?.email_backend || 'graph';
  const from = pickFromAddress(settings, backend);
  const opts = { from, fromName: senderName || null, to: addresses, subject, html, headers, replyTo, attachments };
  try {
    if (backend === 'smtp') await sendViaSmtp(opts);
    else if (backend === 'gmail') await sendViaGmail(opts);
    else await sendViaGraph(opts);
  } catch (err) {
    console.error(`sendMail (${backend}) error:`, err.message);
  }
}

// sendMailViaAccount: dispatch a message through a specific
// email_backend_accounts row. Refreshes the OAuth access token if it's
// near expiry. Used by both the active-account fast path above and by
// the admin "test send" endpoint.
async function sendMailViaAccount(rawAccount, { to, subject, html, headers, replyTo, senderName, attachments }, req) {
  const eb = require('./emailBackends');
  // Decrypt secrets if not already decrypted (recordTest etc. might have
  // bypassed the helper).
  let account = rawAccount;
  if (rawAccount.oauth_access_token_enc || rawAccount.oauth_refresh_token_enc || rawAccount.smtp_password_enc) {
    const { decryptRow } = require('./fields');
    account = { ...rawAccount };
    await decryptRow('email_backend_accounts', account);
  }
  if (account.provider === 'graph_user' || account.provider === 'gmail_user') {
    account = await eb.refreshIfNeeded(account, req);
  }
  const addresses = Array.isArray(to) ? to : [to];
  // From is always the connected mailbox. When senderName is given (vendor
  // outbound from a specific human actor), it rides as the display name —
  // recipient sees `"Josh Hearne (Resolvd)" <resolvd@…>` and replies still
  // route back to the monitored inbox. No Exchange Send-As perm required.
  const effectiveFrom = account.from_address;
  // Default Reply-To to the connected mailbox so even legacy paths that
  // didn't pass replyTo still send vendor replies back to us.
  const effectiveReplyTo = replyTo || account.from_address;
  const opts = {
    from: effectiveFrom,
    fromName: senderName || null,
    to: addresses,
    subject,
    html,
    headers,
    replyTo: effectiveReplyTo,
    attachments,
  };
  if (account.provider === 'smtp') {
    return await sendViaSmtpAccount(account, opts);
  }
  if (account.provider === 'graph_user') {
    return await sendViaGraphUser(account, opts);
  }
  if (account.provider === 'gmail_user') {
    return await sendViaGmailUser(account, opts);
  }
  throw new Error(`Unsupported provider: ${account.provider}`);
}

async function sendViaSmtpAccount(account, { from, fromName, to, subject, html, headers, replyTo, attachments }) {
  const transport = nodemailer.createTransport({
    host: account.smtp_host,
    port: account.smtp_port || 587,
    secure: !!account.smtp_secure,
    auth: account.smtp_user ? { user: account.smtp_user, pass: account.smtp_password } : undefined,
  });
  await transport.sendMail({
    from: fromName ? formatAddress(from, fromName) : from,
    to: to.join(', '), subject, html,
    replyTo: replyTo || undefined,
    headers: headers || undefined,
    attachments: attachments?.map(a => ({ filename: a.filename, content: a.data, contentType: a.mimetype })),
  });
}

async function sendViaGraphUser(account, { from, fromName, to, subject, html, headers, replyTo, attachments }) {
  // Delegated /me/sendMail uses the user's own access token; no app-level
  // Mail.Send permission required. The address must match the
  // authenticated user — we always pass account.from_address — so no
  // Send-As / Send-on-Behalf-Of permission is required. The display name
  // is the only place the actor's identity appears.
  const message = {
    subject,
    body: { contentType: 'HTML', content: html },
    toRecipients: to.map(addr => ({ emailAddress: { address: addr } })),
  };
  if (from) {
    message.from = {
      emailAddress: fromName ? { name: fromName, address: from } : { address: from },
    };
  }
  if (replyTo) message.replyTo = [{ emailAddress: { address: replyTo } }];
  if (headers && Object.keys(headers).length) {
    message.internetMessageHeaders = Object.entries(headers)
      .filter(([k]) => /^x-/i.test(k))
      .map(([name, value]) => ({ name, value: String(value) }));
  }
  if (attachments?.length) {
    message.attachments = attachments.map(a => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: a.filename, contentType: a.mimetype,
      contentBytes: a.data.toString('base64'),
    }));
  }
  const r = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${account.oauth_access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message, saveToSentItems: true }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Graph /me/sendMail ${r.status}: ${text}`);
  }
}

async function sendViaGmailUser(account, { from, fromName, to, subject, html, headers, replyTo, attachments }) {
  const raw = buildRawMimeEmail({ from, fromName, to, subject, html, headers, replyTo, attachments });
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${account.oauth_access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Gmail send ${r.status}: ${text}`);
  }
}

// ─── Templates ───────────────────────────────────────────────────────────────
async function baseHtml(title, body) {
  let siteName = 'Resolvd';
  let primary = '#16a34a';
  try {
    const b = await getBranding();
    if (b?.site_name) siteName = b.site_name;
    if (b?.accent_override_enabled && b?.primary_color) primary = b.primary_color;
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

module.exports = {
  sendMail,
  sendMailViaAccount,
  baseHtml,
  sendInviteEmail,
  sendPasswordResetEmail,
};

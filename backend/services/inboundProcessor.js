// Decides whether an inbound email should auto-create a ticket or sit in
// the unmatched queue for an admin to match by hand.
//
// Auto-create rule: subject must start with "#PREFIX " (matching a
// project's prefix) AND the sender must be an active internal user with
// role Admin / Manager / Submitter. Anything else falls through to the
// existing manual-match flow so the admin queue is the single source of
// truth for ambiguous mail.
//
// CC handling: addresses that already correspond to active vendor
// contacts in the project get auto-attached to the new ticket. Unknown
// CCs are recorded on the queue row's reject_reason for admin review —
// we never auto-create contact rows from inbound mail (admin curation
// rule).
//
// Signature/quote stripping: best-effort regex pass that cuts the body
// at the first commonly-recognised boundary (RFC 3676 "-- ", "On <date>
// wrote:", Outlook quoted header, "Sent from my X"). Lossy but worth it
// for ticket descriptions.

const path = require('path');
const fsp = require('fs').promises;
const { randomUUID } = require('crypto');
const { pool } = require('../db/pool');
const { nextMotRef, computePriority } = require('../db/schema');
const { buildWritePatch, decryptRow, getMode } = require('./fields');
const { encrypt } = require('./crypto');
const blindIndex = require('./blindIndex');
const { hashWhole } = blindIndex;
const { sendVendorEmail } = require('./vendorOutbound');
const tpl = require('./emailTemplate');
const { sendMail } = require('./email');
const { getBranding } = require('./branding');

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';
const APP_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
const AUTHORIZED_SUBMIT_ROLES = new Set(['Admin', 'Manager', 'Submitter']);

const SUBJECT_PREFIX_RE = /^\s*#([A-Z][A-Z0-9]+)\b\s*[-:]?\s*(.*)$/;

// Pre-compiled in priority order. The earliest match wins.
const SIGNATURE_BOUNDARIES = [
  /^\s*-- ?\s*$/m,                                    // RFC 3676 sig delim
  /^On .+ (wrote|said):\s*$/mi,                       // quoted reply preface
  /^From:\s*\S+@\S+/m,                                // Outlook quoted header
  /^Sent from my .+$/mi,                              // mobile sigs
  /^Get Outlook for .+$/mi,                           // outlook mobile
  /^_{4,}\s*$/m,                                       // ____ separator
  /^-{4,}\s*$/m,                                       // ---- separator
];

function stripSignature(body) {
  if (!body) return '';
  const text = String(body).replace(/\r\n/g, '\n');
  let cutAt = text.length;
  for (const re of SIGNATURE_BOUNDARIES) {
    const m = re.exec(text);
    if (m && m.index < cutAt) cutAt = m.index;
  }
  // Also strip a long run of consecutive quoted lines (5+) at the end —
  // catches inline-quoted history without an explicit "On X wrote:".
  const quotedTail = /(?:^>.*\n){5,}\s*$/m.exec(text);
  if (quotedTail && quotedTail.index < cutAt) cutAt = quotedTail.index;
  return text.slice(0, cutAt).trim();
}

function parseSubjectPrefix(subject) {
  if (!subject) return null;
  const m = SUBJECT_PREFIX_RE.exec(subject);
  if (!m) return null;
  const prefix = m[1].toUpperCase();
  const title = (m[2] || '').trim();
  if (!title) return null;
  return { prefix, title };
}

async function findProjectByPrefix(prefix) {
  const r = await pool.query(
    `SELECT id, name, prefix, has_external_vendor, status
       FROM projects WHERE prefix = $1`,
    [prefix]
  );
  return r.rows[0] || null;
}

async function findInternalSubmitter(email) {
  if (!email) return null;
  const r = await pool.query(
    `SELECT id, role, status, email, display_name
       FROM users
      WHERE LOWER(email) = LOWER($1) AND status = 'active'
      LIMIT 1`,
    [String(email).trim()]
  );
  const u = r.rows[0];
  if (!u) return null;
  if (!AUTHORIZED_SUBMIT_ROLES.has(u.role)) return null;
  return u;
}

// Resolve a CC address to an existing active contact under the given
// project. Never creates new contacts — admin curates that explicitly.
async function findContactInProject(email, projectId) {
  const blind = hashWhole(email);
  if (!blind) {
    // No master key configured — fall back to plaintext lookup.
    const r = await pool.query(
      `SELECT c.id, c.company_id
         FROM contacts c
         JOIN companies co ON co.id = c.company_id
        WHERE LOWER(c.email) = LOWER($1)
          AND co.project_id = $2 AND c.is_active = TRUE
        LIMIT 1`,
      [email, projectId]
    );
    return r.rows[0] || null;
  }
  const r = await pool.query(
    `SELECT c.id, c.company_id
       FROM contacts c
       JOIN companies co ON co.id = c.company_id
      WHERE c.email_blind_idx = $1
        AND co.project_id = $2 AND c.is_active = TRUE
      LIMIT 1`,
    [blind, projectId]
  );
  return r.rows[0] || null;
}

async function persistAttachment({ ticketId, userId, filename, mimetype, contentBuffer }) {
  const ext = filename.includes('.') ? path.extname(filename) : '';
  const onDiskName = `${randomUUID()}${ext}`;
  const filePath = path.join(UPLOADS_DIR, onDiskName);
  const mode = await getMode(pool);
  const encryptedAtRest = mode === 'standard';
  const onDisk = encryptedAtRest
    ? await encrypt(contentBuffer, `attachments.file:${onDiskName}`)
    : contentBuffer;
  await fsp.writeFile(filePath, onDisk);
  const patch = await buildWritePatch(pool, 'attachments', { original_name: filename });
  const cols = ['ticket_id', 'user_id', 'filename', 'mimetype', 'size', 'encrypted_at_rest', ...patch.cols];
  const values = [ticketId, userId, onDiskName, mimetype || 'application/octet-stream',
    contentBuffer.length, encryptedAtRest, ...patch.values];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  await pool.query(
    `INSERT INTO attachments (${cols.join(', ')}) VALUES (${placeholders})`,
    values
  );
}

// Attempt to auto-create a ticket from a parsed inbound email. Returns
// { ok: true, ticket } on success, { ok: false, reason } when the email
// shouldn't auto-create (caller falls through to the unmatched queue).
async function tryAutoCreate({ subject, body, fromAddress, ccAddresses, attachments, queueRowId }) {
  const parsed = parseSubjectPrefix(subject);
  if (!parsed) return { ok: false, reason: 'no_prefix' };

  const project = await findProjectByPrefix(parsed.prefix);
  if (!project) return { ok: false, reason: `project_prefix_not_found:${parsed.prefix}` };
  if (project.status !== 'active') return { ok: false, reason: `project_archived:${parsed.prefix}` };

  const submitter = await findInternalSubmitter(fromAddress);
  if (!submitter) return { ok: false, reason: `sender_not_authorized:${fromAddress}` };

  const cleanedDescription = stripSignature(body) || '(no description)';

  // Build INSERT — mirrors POST /api/tickets
  const ticket = await (async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const motRef = await nextMotRef(c, project.id);
      const computed = computePriority(2, 2);
      const sensitivePatch = await buildWritePatch(c, 'tickets', {
        title: parsed.title,
        description: cleanedDescription,
      });
      const mode = await getMode(c);
      const baseCols = ['project_id', 'mot_ref', 'submitted_by',
        'impact', 'urgency', 'computed_priority', 'effective_priority',
        'title_blind_idx', 'source_inbound_email_id'];
      const baseValues = [
        project.id, motRef, submitter.id,
        2, 2, computed, computed,
        mode === 'standard' ? blindIndex.buildIndex(parsed.title) : null,
        queueRowId || null,
      ];
      const cols = [...baseCols, ...sensitivePatch.cols];
      const values = [...baseValues, ...sensitivePatch.values];
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const r = await c.query(
        `INSERT INTO tickets (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
        values
      );
      // Audit + auto-follow.
      await c.query(
        `INSERT INTO audit_log (ticket_id, user_id, action, new_value, note)
         VALUES ($1, $2, 'ticket_created', $3, $4)`,
        [r.rows[0].id, submitter.id, motRef, 'Created via inbound email']
      );
      await c.query(
        `INSERT INTO ticket_followers (ticket_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [r.rows[0].id, submitter.id]
      );
      await c.query('COMMIT');
      return r.rows[0];
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  })();

  // Attachments (best effort — ticket exists either way)
  for (const att of (attachments || [])) {
    try {
      const buf = Buffer.from(att.content_base64 || '', 'base64');
      if (buf.length === 0) continue;
      await persistAttachment({
        ticketId: ticket.id,
        userId: submitter.id,
        filename: att.filename || 'attachment.bin',
        mimetype: att.mimetype,
        contentBuffer: buf,
      });
    } catch (e) {
      console.error(`inbound attachment "${att?.filename}" failed:`, e.message);
    }
  }

  // CC fan-out: attach existing project contacts only. Track unknown
  // CCs on the queue row's reject_reason so the admin sees a hint.
  const attachedContactIds = [];
  const unknownCcs = [];
  if (project.has_external_vendor) {
    for (const cc of (ccAddresses || [])) {
      const lc = String(cc).toLowerCase().trim();
      if (!lc || lc === fromAddress.toLowerCase()) continue;
      // Don't attach internal users as "contacts" — they're followers.
      const internal = await pool.query(
        `SELECT 1 FROM users WHERE LOWER(email) = $1 LIMIT 1`,
        [lc]
      );
      if (internal.rows[0]) continue;
      const contact = await findContactInProject(lc, project.id);
      if (contact) {
        await pool.query(
          `INSERT INTO ticket_contacts (ticket_id, contact_id, added_by_user_id)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [ticket.id, contact.id, submitter.id]
        );
        attachedContactIds.push(contact.id);
      } else {
        unknownCcs.push(lc);
      }
    }
  }

  return {
    ok: true,
    ticket,
    submitter,
    project,
    attachedContactIds,
    unknownCcs,
  };
}

// Send the originator a confirmation email using the
// ticket_created_via_email template. To: sender only — not the CCs.
async function sendCreationConfirmation({ submitter, ticket, project }) {
  const tplRow = await tpl.loadTemplate('ticket_created_via_email', 'submitter');
  if (!tplRow) return;
  const branding = await getBranding().catch(() => null);
  const ctx = {
    site: { name: branding?.site_name || 'Resolvd', url: APP_URL },
    actor: submitter,
    ticket: {
      ...ticket,
      url: `${APP_URL}/tickets/${ticket.id}`,
    },
    company: { name: project?.name },
  };
  // Decrypt sensitive fields on ticket so template tags resolve.
  await decryptRow('tickets', ctx.ticket).catch(() => {});
  const rendered = await tpl.render(tplRow, ctx);
  if (!rendered) return;
  await sendMail({
    to: submitter.email,
    subject: rendered.subject,
    html: tplRow.is_html ? rendered.body : `<pre style="font-family:system-ui,-apple-system,sans-serif;white-space:pre-wrap;font-size:14px;color:#111827">${rendered.body.replace(/[&<>]/g, c => c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;')}</pre>`,
    headers: {
      'X-Resolvd-Ticket': ticket.mot_ref,
      'X-Resolvd-No-Reply': '0', // this one IS reply-able; vendor outbound flips it back to 1
      'In-Reply-To': `<${ticket.mot_ref}@resolvd>`,
    },
  });
}

module.exports = {
  parseSubjectPrefix,
  stripSignature,
  findProjectByPrefix,
  findInternalSubmitter,
  tryAutoCreate,
  sendCreationConfirmation,
};

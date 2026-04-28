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
const { nextInternalRef, computePriority } = require('../db/schema');
const { buildWritePatch, decryptRow, getMode } = require('./fields');
const { encrypt } = require('./crypto');
const blindIndex = require('./blindIndex');
const { hashWhole } = blindIndex;
const { sendVendorEmail } = require('./vendorOutbound');
const { applyReplyToResolvedTicket } = require('./autoResolve');
const tpl = require('./emailTemplate');
const { sendMail } = require('./email');
const { getBranding } = require('./branding');
const { notifyManagersAndAdmins } = require('./notifications');

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';
const APP_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
const AUTHORIZED_SUBMIT_ROLES = new Set(['Admin', 'Manager', 'Submitter']);

const SUBJECT_PREFIX_RE = /^\s*#([A-Za-z][A-Za-z0-9]+)\b\s*[-:]?\s*(.*)$/;

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

// Find a company in the given project by its domain — used to suggest a
// vendor when an unmatched CC address shares a known company's domain.
async function findCompanyByDomain(domain, projectId) {
  if (!domain) return null;
  const r = await pool.query(
    `SELECT id, name FROM companies
      WHERE LOWER(domain) = LOWER($1) AND project_id = $2 AND is_archived = FALSE
      LIMIT 1`,
    [domain, projectId]
  );
  return r.rows[0] || null;
}

// Dedup decision for an inbound auto-create. Two cases:
//
//   exact   — same project, same submitter, OPEN ticket created in the
//             last 7 days, with an identical title (case-insensitive).
//             Resolution: append this email's body as a new comment on
//             that ticket; do NOT create a new ticket.
//
//   similar — same project, OPEN ticket created in the last 24h whose
//             title shares ≥80% of its meaningful tokens with the new
//             email's title. Resolution: bail out of auto-create and
//             leave the row in the unmatched queue with reject_reason
//             "possible_dup:TICKET_REF" so an admin can decide whether
//             to merge or create new.
//
// Encrypted mode (standard) uses the existing title_blind_idx HMAC
// array — exact match by Postgres array equality, similar by overlap
// (`&&`) and ratio computed in JS. Off-mode falls back to plaintext
// LOWER() comparison and JS tokenisation. No new columns required.
const SIMILARITY_THRESHOLD = 0.8;

async function findDuplicateOrSimilar({ projectId, submitterId, title }) {
  const tokens = blindIndex.tokenize(title);
  if (tokens.length === 0) return null;
  const mode = await getMode(pool);
  const normalized = String(title).trim().toLowerCase();

  // Case 1: exact title match from same submitter on an open ticket in
  // the last 7 days. Resolution = reuse + comment-append.
  let exact;
  if (mode === 'standard') {
    const idx = blindIndex.buildIndex(title);
    exact = await pool.query(`
      SELECT id, internal_ref FROM tickets
       WHERE project_id = $1 AND submitted_by = $2
         AND internal_status NOT IN ('Closed')
         AND created_at >= NOW() - INTERVAL '7 days'
         AND title_blind_idx = $3::text[]
       ORDER BY created_at DESC LIMIT 1
    `, [projectId, submitterId, idx]);
  } else {
    exact = await pool.query(`
      SELECT id, internal_ref FROM tickets
       WHERE project_id = $1 AND submitted_by = $2
         AND internal_status NOT IN ('Closed')
         AND created_at >= NOW() - INTERVAL '7 days'
         AND LOWER(title) = $3
       ORDER BY created_at DESC LIMIT 1
    `, [projectId, submitterId, normalized]);
  }
  if (exact.rows[0]) {
    return { kind: 'exact', ticketId: exact.rows[0].id, ticketRef: exact.rows[0].internal_ref };
  }

  // Case 2: meaningful overlap with any open ticket in the project from
  // the last 24h. Threshold = SIMILARITY_THRESHOLD of the smaller token
  // set. Resolution = defer to manual queue.
  if (tokens.length < 2) return null;
  let candidates;
  if (mode === 'standard') {
    const hashes = blindIndex.hashQuery(title);
    if (hashes.length < 2) return null;
    candidates = await pool.query(`
      SELECT id, internal_ref, title_blind_idx,
             cardinality(title_blind_idx) AS token_count
        FROM tickets
       WHERE project_id = $1
         AND internal_status NOT IN ('Closed')
         AND created_at >= NOW() - INTERVAL '24 hours'
         AND title_blind_idx && $2::text[]
    `, [projectId, hashes]);
  } else {
    candidates = await pool.query(`
      SELECT id, internal_ref, title FROM tickets
       WHERE project_id = $1
         AND internal_status NOT IN ('Closed')
         AND created_at >= NOW() - INTERVAL '24 hours'
    `, [projectId]);
  }

  const newTokenSet = new Set(tokens);
  let bestMatch = null;
  let bestScore = 0;
  for (const c of candidates.rows) {
    let score;
    if (mode === 'standard') {
      const newHashes = blindIndex.hashQuery(title);
      const candHashSet = new Set(c.title_blind_idx || []);
      let shared = 0;
      for (const h of newHashes) if (candHashSet.has(h)) shared++;
      const denom = Math.min(newHashes.length, c.token_count || newHashes.length);
      score = denom ? shared / denom : 0;
    } else {
      const candTokens = new Set(blindIndex.tokenize(c.title || ''));
      let shared = 0;
      for (const t of newTokenSet) if (candTokens.has(t)) shared++;
      const denom = Math.min(newTokenSet.size, candTokens.size || newTokenSet.size);
      score = denom ? shared / denom : 0;
    }
    if (score >= SIMILARITY_THRESHOLD && score > bestScore) {
      bestScore = score;
      bestMatch = { ticketId: c.id, ticketRef: c.internal_ref };
    }
  }
  return bestMatch ? { kind: 'similar', ...bestMatch, score: bestScore } : null;
}

// Append a comment to an existing ticket from the inbound flow. The
// comment is internal-only (is_external_visible=FALSE) and attributes
// the originating user. Used by the dedup "exact" branch when reusing
// an existing ticket instead of creating a new one.
async function appendCommentToTicket({ ticketId, submitter, body, queueRowId }) {
  const trimmed = (body || '').trim() || '(no body)';
  const patch = await buildWritePatch(pool, 'comments', { body: trimmed });
  const cols = ['ticket_id', 'user_id', 'is_external_visible', 'is_internal',
    'source_inbound_email_id', ...patch.cols];
  const values = [ticketId, submitter.id, false, true, queueRowId || null, ...patch.values];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  await pool.query(
    `INSERT INTO comments (${cols.join(', ')}) VALUES (${placeholders})`,
    values
  );
  await pool.query(`UPDATE tickets SET updated_at = NOW() WHERE id = $1`, [ticketId]);
  await pool.query(
    `INSERT INTO audit_log (ticket_id, user_id, action, note)
     VALUES ($1, $2, 'comment_appended_via_email', 'Email-to-ticket dedup matched this open ticket')`,
    [ticketId, submitter.id]
  );
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

  // Dedup: same-submitter exact-title open ticket in last 7d → append
  // body as comment instead of creating a new ticket. Strong-overlap
  // match in the same project last 24h → defer to manual queue.
  const dup = await findDuplicateOrSimilar({
    projectId: project.id, submitterId: submitter.id, title: parsed.title,
  });
  if (dup?.kind === 'exact') {
    await appendCommentToTicket({
      ticketId: dup.ticketId, submitter, body: cleanedDescription, queueRowId,
    });
    // Persist any attachments onto the EXISTING ticket so the email's
    // payload still reaches the right place.
    for (const att of (attachments || [])) {
      try {
        const buf = Buffer.from(att.content_base64 || '', 'base64');
        if (buf.length === 0) continue;
        await persistAttachment({
          ticketId: dup.ticketId, userId: submitter.id,
          filename: att.filename || 'attachment.bin',
          mimetype: att.mimetype, contentBuffer: buf,
        });
      } catch (e) {
        console.error(`inbound attachment "${att?.filename}" (reuse) failed:`, e.message);
      }
    }
    return {
      ok: true, kind: 'reused',
      ticket: { id: dup.ticketId, internal_ref: dup.ticketRef },
      submitter, project,
      attachedContactIds: [], unknownCcs: [],
    };
  }
  if (dup?.kind === 'similar') {
    return { ok: false, reason: `possible_dup:${dup.ticketRef}` };
  }

  // Build INSERT — mirrors POST /api/tickets
  const ticket = await (async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const internalRef = await nextInternalRef(c, project.id);
      const computed = computePriority(2, 2);
      const sensitivePatch = await buildWritePatch(c, 'tickets', {
        title: parsed.title,
        description: cleanedDescription,
      });
      const mode = await getMode(c);
      const baseCols = ['project_id', 'internal_ref', 'submitted_by',
        'impact', 'urgency', 'computed_priority', 'effective_priority',
        'title_blind_idx', 'source_inbound_email_id'];
      const baseValues = [
        project.id, internalRef, submitter.id,
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
        [r.rows[0].id, submitter.id, internalRef, 'Created via inbound email']
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

  // CC fan-out: auto-follow internal users, attach known vendor contacts,
  // fire admin notifications for unmatched external addresses.
  const attachedContactIds = [];
  const unknownCcs = [];
  for (const cc of (ccAddresses || [])) {
    const lc = String(cc).toLowerCase().trim();
    if (!lc || lc === fromAddress.toLowerCase()) continue;

    // Internal user → add as follower, not a contact row.
    const internalRow = await pool.query(
      `SELECT id FROM users WHERE LOWER(email) = $1 AND status = 'active' LIMIT 1`,
      [lc]
    );
    if (internalRow.rows[0]) {
      await pool.query(
        `INSERT INTO ticket_followers (ticket_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [ticket.id, internalRow.rows[0].id]
      );
      continue;
    }

    if (!project.has_external_vendor) continue;

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
      const domain = lc.includes('@') ? lc.split('@')[1] : null;
      const company = domain ? await findCompanyByDomain(domain, project.id) : null;
      try {
        await notifyManagersAndAdmins(null, {
          type: 'unmatched_cc',
          title: `Unmatched CC on ${ticket.internal_ref}`,
          body: `${lc} was CC'd on a new ticket but is not a known contact.${company ? ` Possible match: ${company.name}.` : ''}`,
          data: {
            ticket_id: ticket.id,
            ticket_ref: ticket.internal_ref,
            email: lc,
            domain,
            suggested_company_id: company?.id || null,
            suggested_company_name: company?.name || null,
            project_id: project.id,
          },
        });
      } catch (e) {
        console.error('Failed to create unmatched_cc notification:', e.message);
      }
    }
  }

  return {
    ok: true,
    kind: 'created',
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
      'X-Resolvd-Ticket': ticket.internal_ref,
      'X-Resolvd-No-Reply': '0', // this one IS reply-able; vendor outbound flips it back to 1
      'In-Reply-To': `<${ticket.internal_ref}@resolvd>`,
    },
  });
}

// Auto-reply handler. Runs when inbound has a [PREFIX-N] candidate ref
// and the sender is a known active contact on that ticket. Appends the
// reply as an external-visible comment, then — if the ticket is sitting
// in a resolved_pending_close status — runs gratitude detection. A real
// reply auto-reopens; "thanks" leaves the auto-close timer running.
async function tryAutoReply({ candidateRef, body, fromAddress, queueRowId }) {
  if (!candidateRef) return { ok: false, reason: 'no_ref' };

  const t = await pool.query(
    `SELECT id, internal_ref, project_id, internal_status, submitted_by
       FROM tickets WHERE internal_ref = $1`,
    [candidateRef]
  );
  if (!t.rows[0]) return { ok: false, reason: `ticket_not_found:${candidateRef}` };
  const ticket = t.rows[0];

  // Sender must be an active contact attached to this ticket.
  const blind = hashWhole(fromAddress);
  let contactRow;
  if (blind) {
    contactRow = await pool.query(`
      SELECT c.id, c.name, c.email, u.id AS submitter_id
        FROM ticket_contacts tc
        JOIN contacts c ON c.id = tc.contact_id
   LEFT JOIN users u ON u.id = $2
       WHERE tc.ticket_id = $1
         AND c.is_active = TRUE
         AND c.email_blind_idx = $3
       LIMIT 1
    `, [ticket.id, ticket.submitted_by, blind]);
  } else {
    contactRow = await pool.query(`
      SELECT c.id, c.name, c.email, u.id AS submitter_id
        FROM ticket_contacts tc
        JOIN contacts c ON c.id = tc.contact_id
   LEFT JOIN users u ON u.id = $2
       WHERE tc.ticket_id = $1
         AND c.is_active = TRUE
         AND LOWER(c.email) = LOWER($3)
       LIMIT 1
    `, [ticket.id, ticket.submitted_by, fromAddress]);
  }
  if (!contactRow.rows[0]) return { ok: false, reason: 'sender_not_on_ticket' };

  const cleanedBody = stripSignature(body) || '(no body)';

  // Append as an external-visible, non-system comment on behalf of the
  // submitter (we don't author comments as contact records).
  const patch = await buildWritePatch(pool, 'comments', { body: cleanedBody });
  const cols = ['ticket_id', 'user_id', 'is_external_visible', 'is_internal',
    'source_inbound_email_id', ...patch.cols];
  const values = [ticket.id, ticket.submitted_by, true, false, queueRowId || null, ...patch.values];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  await pool.query(
    `INSERT INTO comments (${cols.join(', ')}) VALUES (${placeholders})`,
    values
  );
  await pool.query(`UPDATE tickets SET updated_at = NOW() WHERE id = $1`, [ticket.id]);
  await pool.query(
    `INSERT INTO audit_log (ticket_id, user_id, action, note)
     VALUES ($1, $2, 'comment_appended_via_email', $3)`,
    [ticket.id, ticket.submitted_by, `Vendor reply from ${fromAddress}`]
  );

  const reopen = await applyReplyToResolvedTicket({
    ticketId: ticket.id, replyBody: cleanedBody, actorUserId: ticket.submitted_by,
  });

  return {
    ok: true,
    ticket: { id: ticket.id, internal_ref: ticket.internal_ref },
    reopen,
  };
}

module.exports = {
  parseSubjectPrefix,
  stripSignature,
  findProjectByPrefix,
  findInternalSubmitter,
  tryAutoCreate,
  tryAutoReply,
  sendCreationConfirmation,
};

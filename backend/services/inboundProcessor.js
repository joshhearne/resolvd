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
const {
  applyReplyToResolvedTicket,
  applyReplyToWaitingTicket,
  applyCommentToTerminalTicket,
  getReplyRoutingSettings,
  detectOutOfOffice,
} = require('./autoResolve');
const tpl = require('./emailTemplate');
const { sendMail } = require('./email');
const { getBranding } = require('./branding');
const { notifyManagersAndAdmins } = require('./notifications');
const { fanoutNewTicket, fanoutAssignment } = require('./notificationFanout');
const { autoProvisionSubmitter } = require('./userAutoProvision');
const dedupOmit = require('./dedupOmit');
const sla = require('./sla');
const assignmentPolicies = require('./assignmentPolicies');

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';
const APP_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
const AUTHORIZED_SUBMIT_ROLES = new Set(['Admin', 'Manager', 'Submitter']);

const SUBJECT_PREFIX_RE = /^\s*#([A-Za-z][A-Za-z0-9]+)\b\s*[-:]?\s*(.*)$/;

// Pre-compiled in priority order. Earliest match in the body wins.
const SIGNATURE_BOUNDARIES = [
  /^\s*-- ?\s*$/m,                                    // RFC 3676 sig delim
  /^On .+ (wrote|said):\s*$/mi,                       // quoted reply preface
  // Outlook's quoted-header block. The flattened single-line form
  // ("From: Display Name addr@dom Sent: ... To: ... Subject: ...") shows
  // up after stripHtml collapses Outlook's nested <div>s. Matches a
  // From: line that *eventually* contains an email address — covers both
  // "From: addr@dom" and "From: Display <addr@dom>" / "From: Display addr@dom".
  /^\s*From:\s+.+?\S+@\S+/m,
  /^Sent from my .+$/mi,                              // mobile sigs
  /^Get Outlook for .+$/mi,                           // outlook mobile
  /^_{4,}\s*$/m,                                       // ____ separator
  /^-{4,}\s*$/m,                                       // ---- separator
  // Boilerplate confidentiality footers ("CONFIDENTIALITY NOTICE",
  // "PRIVILEGED AND CONFIDENTIAL", "This email and any attachments…").
  // Vendor sigs frequently sit just above these so cutting here drops
  // both the legalese and the trailing signature block.
  /^\s*CONFIDENTIALITY\s+NOTICE\b/im,
  /^\s*PRIVILEGED\s+AND\s+CONFIDENTIAL\b/im,
  /^\s*This\s+(?:e-?mail|message)\s+(?:and\s+any\s+attachments?\s+)?(?:is|are)\s+(?:confidential|intended)\b/im,
  /^\s*This\s+communication\s+(?:is|may\s+be)\s+confidential\b/im,
  /^\s*The\s+information\s+(?:contained\s+)?in\s+this\s+(?:e-?mail|message)\s+is\s+(?:confidential|privileged)\b/im,
];

// Closing salutations sit on a line of their own, optionally followed by
// 1-2 TitleCase name words on the same line ("Thanks, Debbie Lincoln").
// Matched line is treated as the start of the signature block — the body
// above it is the meat of the reply, everything from this line down (sig
// name, title, company, phone, etc.) gets sliced off. Length-bounded
// (~80 chars) so a mid-paragraph "Thanks for your help with that, I'll
// circle back next week" doesn't trigger.
const CLOSING_SALUTATION_RE = /^[ \t]*(?:Thanks(?:\s+(?:a\s+lot|again|so\s+much|kindly))?|Thank\s+you(?:\s+(?:so\s+much|very\s+much|kindly))?|Many\s+thanks|Best(?:\s+(?:regards|wishes))?|Kind(?:est)?\s+regards|Warm(?:est)?\s+regards|Regards|Sincerely(?:\s+yours)?|Yours(?:\s+(?:truly|sincerely|faithfully))?|Cordially|Respectfully|Cheers|Take\s+care|Talk\s+(?:soon|later|to\s+you\s+soon)|Speak\s+soon)[ \t]*[,!.…]?[ \t]*(?:[A-Z][\w'’-]+(?:\s+[A-Z][\w'’-]+){0,2})?[ \t]*[,!.]?[ \t]*$/m;

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build per-call boundaries from contact hints. The matched vendor
// contact's plaintext name on its own line and any line containing the
// contact's email address are common signature anchors that the static
// list can't know ahead of time.
function contactBoundaries({ name, email } = {}) {
  const out = [];
  if (name && name.trim()) {
    const n = escapeRegex(name.trim());
    out.push(new RegExp(`^\\s*${n}\\s*$`, 'mi'));
  }
  if (email && email.trim()) {
    const e = escapeRegex(email.trim());
    // Match the email line only when it looks like a signature line —
    // short (<=80 chars) and not part of a sentence ending in a period
    // BEFORE the address. This prevents the Microsoft external-sender
    // banner ("You don't often get email from <addr>. Learn why…")
    // from being mistaken for the contact's sig and consuming the
    // entire reply.
    out.push(new RegExp(`^(?!.*\\. *${e})[^\\n]{0,80}${e}[^\\n]{0,20}$`, 'mi'));
  }
  return out;
}

// Microsoft 365 and other mail security stacks routinely prepend a
// "this address rarely emails you" safety notice to inbound vendor
// replies. The banner sits ABOVE the actual reply and contains the
// sender's email, so without stripping it the contact-email signature
// boundary matches at the top of the body and wipes out the entire
// reply. Patterns are anchored to line-level so a legitimate sentence
// quoting the same words isn't clobbered. Match the surrounding blank
// lines too so we don't leave a leading gap after removal.
const EXTERNAL_SAFETY_BANNERS = [
  /^[ \t]*You don't often get email from [^\n]*\n+/im,
  /^[ \t]*Learn why this is important[^\n]*\n+/im,
  /^[ \t]*\[EXTERNAL\][^\n]*\n+/im,
  /^[ \t]*\*+\s*EXTERNAL EMAIL[^\n]*\n+/im,
  /^[ \t]*CAUTION:[ \t]*This (?:e-?mail|message) originated from outside[^\n]*\n+/im,
  /^[ \t]*This email originated from outside (?:of|the) (?:our|your) (?:organi[sz]ation|company)[^\n]*\n+/im,
  // Mimecast / Inky-style "external sender" wrappers.
  /^[ \t]*--+\s*External (?:Email|Sender)\s*--+[^\n]*\n+/im,
];
function stripExternalBanners(text) {
  let out = String(text || '');
  for (const re of EXTERNAL_SAFETY_BANNERS) {
    out = out.replace(re, '');
  }
  return out;
}

// Resolvd's outbound vendor emails carry a visible "Type your reply
// above this line" marker so vendors know where to write. The inbound
// parser cuts at the first occurrence to drop quoted history, banners,
// and signatures in one shot. Marker phrasing must match
// vendorOutbound.replyMarkerHtml — keep these in sync.
// Anchored to the start of a line so leading dashes/whitespace get
// included in the cut. `[-=]{0,5}` lets the optional bookend dashes ride
// along (e.g. `--- Type your reply above this line --- ticket FOO-1`).
const REPLY_MARKER_RE = /(?:\r?\n|^)[ \t]*[-=]{0,5}[ \t]*Type your reply above this line\b/i;

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

// Collapses consecutive identical paragraphs (whitespace-normalized,
// case-insensitive). Catches mail clients / gateways that echo the
// user's content (e.g. some plain-text/HTML alternative duplications)
// without changing legitimate replies that happen to repeat themselves
// across non-adjacent paragraphs.
function dedupeParagraphs(text) {
  const blocks = text.split(/\n{2,}/);
  const kept = [];
  let lastNorm = null;
  for (const b of blocks) {
    const norm = b.trim().replace(/\s+/g, ' ').toLowerCase();
    if (norm && norm === lastNorm) continue;
    kept.push(b);
    lastNorm = norm;
  }
  return kept.join('\n\n');
}

// Top-level reply extractor. Takes the EARLIEST cut among reply-marker,
// signature boundaries, and quoted-tail heuristics. Final pass collapses
// duplicate paragraphs from any mail-client/gateway echo.
//
// `contactHints` (optional) lets a vendor-reply caller pass the matched
// contact's plaintext name + email. We then add per-call boundaries so
// signatures like "Debbie Lincoln\n…\nE: debbie@vendor.com" cut cleanly
// even without an explicit "-- " delim.
function extractFreshReply(body, contactHints) {
  if (!body) return '';
  // Pre-strip external-sender safety banners (M365 / Mimecast / Inky)
  // so their boilerplate doesn't masquerade as a signature line and
  // gobble the actual reply.
  const text = stripExternalBanners(String(body).replace(/\r\n/g, '\n'));
  let cutAt = text.length;
  const markerMatch = REPLY_MARKER_RE.exec(text);
  if (markerMatch && markerMatch.index < cutAt) cutAt = markerMatch.index;
  const boundaries = contactHints
    ? [...SIGNATURE_BOUNDARIES, ...contactBoundaries(contactHints)]
    : SIGNATURE_BOUNDARIES;
  for (const re of boundaries) {
    const m = re.exec(text);
    if (m && m.index < cutAt) cutAt = m.index;
  }
  // Closing salutation cut: only honored when at least one non-blank
  // line of content sits above it AND the matched line is short enough
  // to actually be a sign-off (not a sentence that happens to start with
  // "Thanks for…"). Guards against blanking one-line replies.
  const closingMatch = CLOSING_SALUTATION_RE.exec(text);
  if (closingMatch) {
    const lineEnd = text.indexOf('\n', closingMatch.index);
    const matchedLine = text.slice(closingMatch.index, lineEnd === -1 ? text.length : lineEnd);
    const above = text.slice(0, closingMatch.index);
    const hasContentAbove = /\S/.test(above);
    if (hasContentAbove && matchedLine.length <= 80 && closingMatch.index < cutAt) {
      cutAt = closingMatch.index;
    }
  }
  const quotedTail = /(?:^>.*\n){5,}\s*$/m.exec(text);
  if (quotedTail && quotedTail.index < cutAt) cutAt = quotedTail.index;
  return dedupeParagraphs(text.slice(0, cutAt).trim()).trim();
}

// Detects an agent-forwarded email and unwraps it. Looks for the common
// client markers (Gmail / Apple Mail / Outlook) followed by a From:
// header. Returns null when the body doesn't look like a forward, or
// when the marker is present but no From: address can be extracted.
// We don't try to handle every quoted variant — only the form an agent
// produces by clicking Forward in a standard mail client.
const FORWARD_MARKER_RE = /(?:^|\n)[ \t>]*[-_=*]*[ \t]*(?:Begin\s+forwarded\s+message:|[- ]{0,8}Forwarded\s+message[- ]{0,8}|-{2,}\s*Original\s+Message\s*-{2,})[ \t]*[-_=*]*[ \t]*(?:\r?\n)/i;
// Outlook "forward" produces no marker — just a flat 4-line header block
// (From / Sent / To / Subject) at the start of the body. Match the
// sequence directly so the forward path fires for Outlook clients too.
const OUTLOOK_FORWARD_RE = /^[ \t>]*From:[ \t]+.+\r?\n[ \t>]*Sent:[ \t]+.+\r?\n[ \t>]*To:[ \t]+.+\r?\n[ \t>]*Subject:[ \t]+.+/im;
const FROM_HEADER_RE = /^[ \t>]*From:[ \t]*(.+)$/im;
const SUBJECT_HEADER_RE = /^[ \t>]*Subject:[ \t]*(.+)$/im;
const EMAIL_ADDR_RE = /([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/;

function detectForward(body) {
  if (!body) return null;
  let after;
  const markerMatch = FORWARD_MARKER_RE.exec(body);
  if (markerMatch) {
    after = body.slice(markerMatch.index + markerMatch[0].length);
  } else {
    const outlookMatch = OUTLOOK_FORWARD_RE.exec(body);
    if (!outlookMatch) return null;
    after = body.slice(outlookMatch.index);
  }
  // Grab the next ~25 lines — header block of the wrapped message.
  const headerSlice = after.split(/\r?\n/).slice(0, 25).join('\n');
  const fromMatch = FROM_HEADER_RE.exec(headerSlice);
  if (!fromMatch) return null;
  const fromLine = fromMatch[1].trim();
  const addrMatch = EMAIL_ADDR_RE.exec(fromLine);
  if (!addrMatch) return null;
  const innerEmail = addrMatch[1].toLowerCase();
  // Name = whatever precedes the address (Common forms: "Name <addr>",
  // "Name (addr)", or bare addr).
  let innerName = fromLine.replace(addrMatch[0], '').replace(/[<>()]/g, '').trim();
  innerName = innerName.replace(/^"+|"+$/g, '').trim() || null;
  const subjMatch = SUBJECT_HEADER_RE.exec(headerSlice);
  const innerSubject = subjMatch ? subjMatch[1].trim() : null;
  // Inner body = everything after the header block. The header block
  // is a contiguous run of "Header: value" lines from the marker; the
  // first blank line ends it.
  const headerEndIdx = after.search(/\r?\n\r?\n/);
  const innerBody = headerEndIdx >= 0 ? after.slice(headerEndIdx).replace(/^\r?\n\r?\n/, '') : after;
  return {
    innerEmail,
    innerName,
    innerSubject,
    innerBody: innerBody.trim() || null,
  };
}

// Inky "User Report via Inky Phish Fence" detector. When a user clicks
// Report in Inky, Inky relays the report to the ticketing mailbox. The
// outer From is Inky's own sending address (no longer the spoofed user),
// so the real reporter — the person the ticket's requester should be —
// lives in the body's "Reported by:" line. We also lift a few fields to
// build a unique, human-readable title (the subject is a constant, which
// the dedup-omit rule keeps from collapsing reports together).
//
// Returns null when the body isn't an Inky report. Detection is anchored
// on the Inky markers so a normal email that happens to contain one of
// these labels doesn't get hijacked.
const INKY_REPORTED_BY_RE = /^[ \t>]*Reported by:[ \t]*<?([^\s<>]+@[^\s<>]+?)>?[ \t]*$/mi;
const INKY_RESULT_RE = /^[ \t>]*INKY result:[ \t]*(.+?)[ \t]*$/mi;
const INKY_LABEL_RE = /^[ \t>]*User label:[ \t]*(.+?)[ \t]*$/mi;
const INKY_ORIGINAL_FROM_RE = /^[ \t>]*Original message from:[ \t]*<?([^\s<>]+@[^\s<>]+?)>?[ \t]*$/mi;
const INKY_MESSAGE_ID_RE = /^[ \t>]*Message-ID:[ \t]*<?([^\s<>]+)>?[ \t]*$/mi;

// Inbound HTML bodies arrive with single "\n" line breaks (converted from
// <br>), but the ticket markdown renderer (react-markdown + GFM, no
// remark-breaks) soft-wraps a single newline into a space — so a
// structured report (one "Label: value" per line) collapses into a wall
// of text. Convert single newlines to markdown hard breaks (two trailing
// spaces) so the line structure survives rendering. Blank-line paragraph
// breaks are left untouched.
function markdownHardBreaks(text) {
  return String(text).replace(/([^\n])\n(?!\n)/g, '$1  \n');
}

function detectInkyReport(subject, body) {
  if (!body) return null;
  const text = String(body);
  const reportedBy = INKY_REPORTED_BY_RE.exec(text);
  if (!reportedBy) return null;
  // Require a second Inky marker so the "Reported by:" line alone (which a
  // human could conceivably type) can't trigger the override.
  const hasMarker = /Inky Phish Fence/i.test(subject || '')
    || INKY_RESULT_RE.test(text)
    || /\bvia Inky\b/i.test(text);
  if (!hasMarker) return null;

  const level = (INKY_RESULT_RE.exec(text)?.[1] || '').trim() || 'unknown';
  const label = (INKY_LABEL_RE.exec(text)?.[1] || '').trim() || 'none';
  const originalFrom = (INKY_ORIGINAL_FROM_RE.exec(text)?.[1] || '').trim() || null;
  // rid: the reported message's Message-ID gives a stable per-report id.
  const rid = (INKY_MESSAGE_ID_RE.exec(text)?.[1] || '').trim() || 'n/a';
  return {
    reporterEmail: reportedBy[1].trim().toLowerCase(),
    level,
    label,
    originalFrom,
    rid,
  };
}

async function findUserByEmail(email) {
  if (!email) return null;
  const r = await pool.query(
    `SELECT id, role, status, email, display_name
       FROM users
      WHERE LOWER(email) = LOWER($1) AND status = 'active'
      LIMIT 1`,
    [String(email).trim()]
  );
  return r.rows[0] || null;
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
    `SELECT id, name, prefix, has_external_vendor, status, default_assignee_id
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

// Resolve an inbound sender to an authorized submitter, auto-provisioning
// a Submitter role when the address is wholly unknown. Existing users in
// non-submit roles (Viewer/Vendor) are left alone — we don't silently
// elevate them. Returns null when neither an existing authorized user nor
// a provisioned one is available.
async function resolveOrProvisionSubmitter(email, source = 'inbound_email') {
  const existing = await findInternalSubmitter(email);
  if (existing) return existing;
  const anyExisting = await pool.query(
    `SELECT 1 FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [email]
  );
  if (anyExisting.rows.length > 0) return null;
  const provisioned = await autoProvisionSubmitter({ email, source });
  if (provisioned && AUTHORIZED_SUBMIT_ROLES.has(provisioned.role)) return provisioned;
  return null;
}

// Resolve a CC address to an existing active contact under the given
// project. Never creates new contacts — admin curates that explicitly.
// Matches by blind index when populated OR plaintext email; either path
// alone misses rows depending on encryption mode + backfill state.
async function findContactInProject(email, projectId) {
  const blind = hashWhole(email);
  const r = await pool.query(
    `SELECT c.id, c.company_id
       FROM contacts c
       JOIN companies co ON co.id = c.company_id
      WHERE co.project_id = $2 AND c.is_active = TRUE
        AND (
          ($1::text IS NOT NULL AND c.email_blind_idx = $1)
          OR LOWER(c.email) = LOWER($3)
        )
      LIMIT 1`,
    [blind, projectId, email]
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
// an existing ticket instead of creating a new one. Returns the new
// comment id so callers can link attachments to it.
async function appendCommentToTicket({ ticketId, submitter, body, queueRowId }) {
  const trimmed = (body || '').trim() || '(no body)';
  const patch = await buildWritePatch(pool, 'comments', { body: trimmed });
  const cols = ['ticket_id', 'user_id', 'is_external_visible', 'is_internal',
    'source_inbound_email_id', ...patch.cols];
  const values = [ticketId, submitter.id, false, true, queueRowId || null, ...patch.values];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const ins = await pool.query(
    `INSERT INTO comments (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`,
    values
  );
  await pool.query(`UPDATE tickets SET updated_at = NOW() WHERE id = $1`, [ticketId]);
  await pool.query(
    `INSERT INTO audit_log (ticket_id, user_id, action, note)
     VALUES ($1, $2, 'comment_appended_via_email', 'Email-to-ticket dedup matched this open ticket')`,
    [ticketId, submitter.id]
  );
  return ins.rows[0].id;
}

// Persist a single inbound attachment to disk + DB. When commentId is
// supplied, the row is linked to that comment so the UI can render the
// file inline under the parent comment (mirrors user-uploaded files
// posted via the comment composer). Pass null for ticket-level files
// (e.g. inbound that auto-created a ticket — description owns them).
async function persistAttachment({ ticketId, userId, commentId = null, filename, mimetype, contentBuffer }) {
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
  const cols = ['ticket_id', 'user_id', 'comment_id', 'filename', 'mimetype', 'size', 'encrypted_at_rest', ...patch.cols];
  const values = [ticketId, userId, commentId, onDiskName, mimetype || 'application/octet-stream',
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
async function tryAutoCreate({ subject, body, fromAddress, ccAddresses, attachments, queueRowId, emailBackendAccountId }) {
  // Forward attribution: if the body wraps a forwarded message and the
  // outer sender is a known internal user (the agent who forwarded),
  // re-aim the create flow at the inner sender as submitter. Forwarder
  // is captured here and used as the auto-assignee after insert. The
  // inner sender is auto-provisioned as a Submitter when unknown, so
  // external customers a staffer forwards on behalf of become the
  // requestor rather than the staffer. Falls back to the agent as
  // submitter only when the inner address exists in an unauthorized
  // role (Viewer/Vendor) — we don't silently elevate those.
  let forwarderUser = null;
  let effectiveFrom = fromAddress;
  let effectiveBody = body;
  let preResolvedSubmitter = null;

  // Inky phish-report attribution: the outer From is Inky's relay address,
  // not the person who reported. Re-aim the submitter at the "Reported by:"
  // address so the reporting staffer becomes the ticket requester, and
  // synthesize a unique title (the Inky subject is constant). Takes
  // precedence over generic forward-unwrap. Falls through to normal
  // handling if the reporter isn't an authorized submitter.
  const inky = detectInkyReport(subject, body);
  let inkyTitle = null;
  if (inky) {
    const reporter = await resolveOrProvisionSubmitter(inky.reporterEmail, 'inbound_inky_report');
    if (reporter) {
      preResolvedSubmitter = reporter;
      effectiveFrom = inky.reporterEmail;
      // Inky's own subject already carries the detail in the desired shape
      // ("… (threat level: caution, user label: safe, rid: 9128624)") with
      // the real numeric Inky report id — prefer it verbatim. Only the
      // older bare-subject variant ("User Report via Inky Phish Fence")
      // needs us to synthesize a title from the body fields.
      const subj = (subject || '').trim();
      inkyTitle = /\(threat level:/i.test(subj)
        ? subj
        : `User Report via Inky Phish Fence (threat level: ${inky.level}, user label: ${inky.label}, rid: ${inky.rid})`;
    }
  }

  const forward = !inky && detectForward(body);
  if (forward) {
    const outerUser = await findUserByEmail(fromAddress);
    if (outerUser) {
      const innerCandidate = await resolveOrProvisionSubmitter(
        forward.innerEmail, 'inbound_email_forward'
      );
      if (innerCandidate) {
        forwarderUser = outerUser;
        effectiveFrom = forward.innerEmail;
        effectiveBody = forward.innerBody || body;
        preResolvedSubmitter = innerCandidate;
      }
    }
  }

  const parsed = parseSubjectPrefix(subject);

  // Routing precedence:
  //   1. Explicit #PREFIX in subject — pick the matching project (current behavior).
  //   2. No #PREFIX, but the receiving mailbox is scoped to exactly ONE
  //      approved project — use that project (helpdesk pattern).
  //   3. Otherwise → no_prefix, falls to manual queue.
  let project = null;
  let titleFromSubject = null;
  if (parsed) {
    project = await findProjectByPrefix(parsed.prefix);
    if (!project) return { ok: false, reason: `project_prefix_not_found:${parsed.prefix}` };
    if (project.status !== 'active') return { ok: false, reason: `project_archived:${parsed.prefix}` };
    titleFromSubject = parsed.title;
  } else if (emailBackendAccountId) {
    const scopes = require('./emailScopes');
    const scoped = await scopes.resolveInboundProject(emailBackendAccountId);
    if (!scoped) return { ok: false, reason: 'no_prefix' };
    project = scoped;
    titleFromSubject = (subject || '').trim() || '(no subject)';
  } else {
    return { ok: false, reason: 'no_prefix' };
  }

  // Inky reports carry a constant subject; replace it with the synthesized
  // per-report title so the ticket is identifiable in lists.
  if (inkyTitle) titleFromSubject = inkyTitle;

  const submitter = preResolvedSubmitter || await resolveOrProvisionSubmitter(effectiveFrom);
  if (!submitter) return { ok: false, reason: `sender_not_authorized:${effectiveFrom}` };

  // Inky reports are structured (label/value per line) — preserve their
  // line breaks through the soft-wrapping markdown renderer.
  const cleanedDescription = inky
    ? markdownHardBreaks(extractFreshReply(effectiveBody) || '(no description)')
    : (extractFreshReply(effectiveBody) || '(no description)');

  // Dedup: same-submitter exact-title open ticket in last 7d → append
  // body as comment instead of creating a new ticket. Strong-overlap
  // match in the same project last 24h → defer to manual queue.
  // A matching dedup-omit rule (admin-configured, e.g. Inky reports)
  // skips this entirely so automated/reporter mail with a fixed subject
  // always gets its own ticket.
  const omitted = await dedupOmit.isDedupOmitted({
    title: titleFromSubject, body: cleanedDescription,
  });
  const dup = omitted ? null : await findDuplicateOrSimilar({
    projectId: project.id, submitterId: submitter.id, title: titleFromSubject,
  });
  if (dup?.kind === 'exact') {
    const appendedCommentId = await appendCommentToTicket({
      ticketId: dup.ticketId, submitter, body: cleanedDescription, queueRowId,
    });
    // Persist any attachments onto the EXISTING ticket so the email's
    // payload still reaches the right place. Link to the appended
    // comment so the UI renders them inline under that comment (same
    // shape as user-uploaded files via the composer).
    for (const att of (attachments || [])) {
      try {
        const buf = Buffer.from(att.content_base64 || '', 'base64');
        if (buf.length === 0) continue;
        await persistAttachment({
          ticketId: dup.ticketId, userId: submitter.id,
          commentId: appendedCommentId,
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
        title: titleFromSubject,
        description: cleanedDescription,
      });
      const mode = await getMode(c);
      const baseCols = ['project_id', 'internal_ref', 'submitted_by',
        'impact', 'urgency', 'computed_priority', 'effective_priority',
        'title_blind_idx', 'source_inbound_email_id'];
      const baseValues = [
        project.id, internalRef, submitter.id,
        2, 2, computed, computed,
        mode === 'standard' ? blindIndex.buildIndex(titleFromSubject) : null,
        queueRowId || null,
      ];
      // Forwarded-from-agent path: agent inherits the ticket as assignee.
      if (forwarderUser) {
        baseCols.push('assigned_to');
        baseValues.push(forwarderUser.id);
      }
      const cols = [...baseCols, ...sensitivePatch.cols];
      const values = [...baseValues, ...sensitivePatch.values];
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const r = await c.query(
        `INSERT INTO tickets (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
        values
      );
      const t = r.rows[0];

      // Stamp SLA due/warn timestamps with business-hours math. Mirrors
      // the REST POST /api/tickets path so inbound-created tickets get
      // the same clock semantics as form-created ones.
      await sla.applyPolicyOnCreate(c, {
        ticketId: t.id,
        priority: t.effective_priority || computed,
        projectId: t.project_id,
        createdAt: t.created_at,
      });

      // Auto-assignment. Forwarder path already pinned assigned_to to the
      // forwarding agent — leave it. Otherwise run policy → fall back to
      // project default_assignee_id.
      if (!t.assigned_to) {
        const policyPick = await assignmentPolicies.applyOnCreate(c, {
          priority: t.effective_priority || computed,
          projectId: t.project_id,
        });
        const finalAssignee = policyPick || project.default_assignee_id || null;
        if (finalAssignee) {
          await c.query(
            `UPDATE tickets SET assigned_to = $1 WHERE id = $2`,
            [finalAssignee, t.id]
          );
          t.assigned_to = finalAssignee;
        }
      }

      // Audit + auto-follow.
      const creationNote = forwarderUser
        ? `Created via forward from ${forwarderUser.email} on behalf of ${submitter.email}`
        : 'Created via inbound email';
      await c.query(
        `INSERT INTO audit_log (ticket_id, user_id, action, new_value, note)
         VALUES ($1, $2, 'ticket_created', $3, $4)`,
        [t.id, submitter.id, internalRef, creationNote]
      );
      if (forwarderUser) {
        await c.query(
          `INSERT INTO audit_log (ticket_id, user_id, action, new_value, note)
           VALUES ($1, $2, 'assigned', $3, $4)`,
          [t.id, forwarderUser.id, String(forwarderUser.id), 'Auto-assigned to forwarding agent']
        );
        await c.query(
          `INSERT INTO ticket_followers (ticket_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [t.id, forwarderUser.id]
        );
      } else if (t.assigned_to) {
        await c.query(
          `INSERT INTO audit_log (ticket_id, user_id, action, new_value, note)
           VALUES ($1, $2, 'assigned', $3, $4)`,
          [t.id, submitter.id, String(t.assigned_to), 'Auto-assigned by policy']
        );
        await c.query(
          `INSERT INTO ticket_followers (ticket_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [t.id, t.assigned_to]
        );
      }
      await c.query(
        `INSERT INTO ticket_followers (ticket_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [t.id, submitter.id]
      );
      await c.query('COMMIT');
      return t;
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

  // Notify the auto-assignee (policy pick / project default / forwarding
  // agent). fanoutNewTicket excludes the assignee on the assumption an
  // assignment fanout covers them — on the inbound path that's us.
  if (ticket.assigned_to && ticket.assigned_to !== submitter.id) {
    fanoutAssignment(pool, {
      ticket,
      assigneeId: ticket.assigned_to,
      actorId: submitter.id,
      actorName: submitter.display_name || submitter.email,
    }).catch(err => console.error('fanoutAssignment (inbound) failed:', err.message));
  }

  // Broadcast to opted-in Admins/Managers. Inbound has no acting user
  // session — pass the submitter as both actor and submitter; fanout
  // de-dups recipients (admin/manager who is also the submitter is
  // excluded) so they don't get notified about their own ticket.
  fanoutNewTicket(pool, {
    ticket,
    actorId: submitter.id,
    actorName: submitter.display_name || submitter.email,
    submitterId: submitter.id,
  }).catch(err => console.error('fanoutNewTicket (inbound) failed:', err.message));

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

// Resolve an inbound sender to either a vendor contact attached to the
// ticket OR an internal user with a meaningful relationship to it
// (submitter/assignee/follower). Returns one of:
//   { kind: 'contact', contact }   — known vendor contact on the ticket
//   { kind: 'user', user }         — known internal participant
//   null                           — sender has no claim on this ticket
async function resolveReplySender({ ticketId, submitterId, fromAddress }) {
  const blind = hashWhole(fromAddress);
  const contactRow = await pool.query(`
    SELECT c.id, c.name, c.name_enc, c.email, c.email_enc,
           co.name AS company_name, co.name_enc AS company_name_enc
      FROM ticket_contacts tc
      JOIN contacts c ON c.id = tc.contact_id
      LEFT JOIN companies co ON co.id = c.company_id
     WHERE tc.ticket_id = $1
       AND c.is_active = TRUE
       AND (
         ($2::text IS NOT NULL AND c.email_blind_idx = $2)
         OR LOWER(c.email) = LOWER($3)
       )
     LIMIT 1
  `, [ticketId, blind, fromAddress]);
  if (contactRow.rows[0]) {
    const contact = contactRow.rows[0];
    await decryptRow('contacts', contact, {
      aliases: { company_name: 'companies.name' },
    }).catch(() => {});
    return { kind: 'contact', contact };
  }

  // Internal user path: any active user who is the submitter, assignee,
  // or a current follower of the ticket can drive an email-reply append.
  // Resolves the Ryan-style case: CC'd internal user replies (or auto-
  // replies) on a ticket they were never added as a vendor contact for.
  const userRow = await pool.query(`
    SELECT u.id, u.email, u.display_name, u.role
      FROM users u
     WHERE u.status = 'active'
       AND LOWER(u.email) = LOWER($1)
       AND (
         u.id = $2
         OR EXISTS (SELECT 1 FROM tickets WHERE id = $3 AND assigned_to = u.id)
         OR EXISTS (SELECT 1 FROM ticket_followers WHERE ticket_id = $3 AND user_id = u.id)
       )
     LIMIT 1
  `, [fromAddress, submitterId, ticketId]);
  if (userRow.rows[0]) {
    return { kind: 'user', user: userRow.rows[0] };
  }

  return null;
}

// Auto-reply handler. Runs when inbound carries a [PREFIX-N] reference.
// Authors the inbound as a comment on that ticket and (unless suppressed)
// auto-reopens / auto-resumes based on the ticket's current state.
//
// Sender resolution accepts either a vendor contact attached to the
// ticket OR an internal participant (submitter, assignee, follower).
// Anything else falls through to the caller's auto-create path.
//
// Staleness: if the ticket hasn't been touched in `reply_stale_days`
// (admin-configurable in auto_resolve_settings), the reply is refused
// with reason 'too_stale:REF/DAYS' so the caller can treat it as a
// brand-new ticket. Prevents a year-old closed ticket from being
// resurrected by an unrelated reply that happens to quote its ref.
//
// OOO suppression: when subject + body look like an out-of-office
// auto-reply AND admin has suppress_ooo_replies enabled, the comment
// is recorded as muted, no status transition runs, and the caller is
// told not to fan out follower notifications. An audit_log entry is
// stamped so admins can see the OOO landed and was silenced.
async function tryAutoReply({ candidateRef, subject, body, fromAddress, queueRowId, attachments }) {
  if (!candidateRef) return { ok: false, reason: 'no_ref' };

  const t = await pool.query(`
    SELECT t.id, t.internal_ref, t.project_id, t.internal_status,
           t.submitted_by, t.title, t.title_enc, t.updated_at,
           s.is_terminal
      FROM tickets t
 LEFT JOIN statuses s ON s.kind = 'internal' AND s.name = t.internal_status
     WHERE t.internal_ref = $1
  `, [candidateRef]);
  if (!t.rows[0]) return { ok: false, reason: `ticket_not_found:${candidateRef}` };
  const ticket = t.rows[0];

  const routing = await getReplyRoutingSettings();
  const staleDays = routing.stale_days;
  const ageMs = Date.now() - new Date(ticket.updated_at).getTime();
  const ageDays = ageMs / (24 * 3600 * 1000);
  if (ageDays > staleDays) {
    return { ok: false, reason: `too_stale:${ticket.internal_ref}:${Math.floor(ageDays)}d>${staleDays}d` };
  }

  // OOO bounceback detection runs BEFORE the sender-claim check. An OOO
  // from a CC'd watcher who isn't formally a contact/follower of the
  // ticket has no business spawning a new ticket — the ref in their
  // subject points at the right thread. Land it there as a passive
  // muted comment with all notifications/status changes suppressed.
  const ooo = routing.suppress_ooo && detectOutOfOffice({ subject, body });

  const sender = await resolveReplySender({
    ticketId: ticket.id, submitterId: ticket.submitted_by, fromAddress,
  });
  if (!sender && !ooo) return { ok: false, reason: 'sender_not_on_ticket' };

  await decryptRow('tickets', ticket).catch(() => {});

  const contactName = sender?.kind === 'contact'
    ? (sender.contact.name && sender.contact.name.trim()) || null
    : (sender?.user?.display_name || null);
  const contactEmail = sender?.kind === 'contact'
    ? ((sender.contact.email && sender.contact.email.trim()) || fromAddress)
    : (sender?.user?.email || fromAddress);
  const cleanedBody = extractFreshReply(body, {
    name: contactName, email: contactEmail,
  }) || '(no body)';

  const oooSuppressed = !!ooo;

  // Comment author. Vendor contact replies are stamped to the submitter
  // (we don't write comments under a contact id). Internal user replies
  // are authored under that user so the UI attributes them correctly.
  // OOO-without-sender path also stamps to the submitter — the email had
  // no claim on the ticket, we're just recording the bounce-back.
  const authorUserId = sender?.kind === 'user' ? sender.user.id : ticket.submitted_by;
  const vendorContactId = sender?.kind === 'contact' ? sender.contact.id : null;

  const patch = await buildWritePatch(pool, 'comments', { body: cleanedBody });
  // OOO comments are noise by design — the muted-digest is there to
  // catch genuinely-silenced vendor replies a follower might want to
  // unmute, not to surface "I'm out until Friday" auto-responders.
  // Pre-stamp digested_at so the digest job skips them on every run
  // without needing a dedicated is_ooo flag. The comment still lands
  // in the thread, still mutes, still audits — just doesn't ride the
  // daily summary.
  const cols = ['ticket_id', 'user_id', 'is_external_visible', 'is_internal',
    'is_muted', 'vendor_contact_id', 'source_inbound_email_id', 'digested_at',
    ...patch.cols];
  const values = [
    ticket.id, authorUserId,
    sender?.kind === 'contact' && !oooSuppressed, // external-visible only for non-OOO vendor replies
    sender?.kind !== 'contact' || oooSuppressed,  // internal-only otherwise
    oooSuppressed,
    vendorContactId, queueRowId || null,
    oooSuppressed ? new Date() : null,
    ...patch.values,
  ];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const ins = await pool.query(
    `INSERT INTO comments (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`,
    values
  );
  const commentId = ins.rows[0].id;
  await pool.query(`UPDATE tickets SET updated_at = NOW() WHERE id = $1`, [ticket.id]);
  const auditNote = oooSuppressed
    ? `OOO auto-reply from ${fromAddress} — comment muted, status + notifications suppressed`
    : (sender?.kind === 'contact'
        ? `Vendor reply from ${fromAddress}`
        : `Internal-user reply from ${fromAddress}`);
  const auditAction = oooSuppressed ? 'ooo_reply_suppressed' : 'comment_appended_via_email';
  await pool.query(
    `INSERT INTO audit_log (ticket_id, user_id, action, note)
     VALUES ($1, $2, $3, $4)`,
    [ticket.id, authorUserId, auditAction, auditNote]
  );

  // Persist any inbound attachments and link them to the reply comment
  // so the UI renders them inline (same shape as user-uploaded files).
  // Best-effort — comment exists either way.
  let attachedCount = 0;
  for (const att of (attachments || [])) {
    try {
      const buf = Buffer.from(att.content_base64 || '', 'base64');
      if (buf.length === 0) continue;
      await persistAttachment({
        ticketId: ticket.id,
        userId: authorUserId,
        commentId,
        filename: att.filename || 'attachment.bin',
        mimetype: att.mimetype,
        contentBuffer: buf,
      });
      attachedCount += 1;
    } catch (e) {
      console.error(`reply attachment "${att?.filename}" failed:`, e.message);
    }
  }

  // OOO path: skip every state-changing helper. Caller also skips fanout.
  let reopen = null;
  let resume = null;
  let reopenTerminal = null;
  if (!oooSuppressed) {
    reopen = await applyReplyToResolvedTicket({
      ticketId: ticket.id, replyBody: cleanedBody, actorUserId: authorUserId,
    });
    // Awaiting-input → in_progress. Skip if resolved-grace already moved it.
    resume = reopen?.reopened
      ? null
      : await applyReplyToWaitingTicket({ ticketId: ticket.id, actorUserId: authorUserId });
    // Fully terminal (Closed) tickets: gratitude filter still applies, but
    // a substantive reply reopens. Mirrors the UI comment path.
    if (!reopen?.reopened && !resume?.resumed && ticket.is_terminal) {
      reopenTerminal = await applyCommentToTerminalTicket({
        ticketId: ticket.id, commentBody: cleanedBody, actorUserId: authorUserId,
      });
    }
  }

  // Display label for follower notifications. Vendor: "Name (Company)" if
  // both known. Internal: display_name or email. Fall back to bare email.
  let actorLabel = contactName || contactEmail;
  if (sender?.kind === 'contact' && contactName && sender.contact.company_name) {
    actorLabel = `${contactName} (${sender.contact.company_name})`;
  } else if (sender?.kind === 'contact' && sender.contact.company_name) {
    actorLabel = sender.contact.company_name;
  }

  return {
    ok: true,
    ticket: {
      id: ticket.id,
      internal_ref: ticket.internal_ref,
      project_id: ticket.project_id,
      title: ticket.title,
    },
    reopen: reopen || reopenTerminal,
    resume,
    cleanedBody,
    actorLabel,
    contactId: vendorContactId,
    actorUserId: sender?.kind === 'user' ? sender.user.id : null,
    commentId,
    attachmentCount: attachedCount,
    oooSuppressed,
    senderKind: sender?.kind || 'unknown',
  };
}

module.exports = {
  parseSubjectPrefix,
  stripSignature,
  extractFreshReply,
  detectInkyReport,
  findProjectByPrefix,
  findInternalSubmitter,
  tryAutoCreate,
  tryAutoReply,
  sendCreationConfirmation,
};

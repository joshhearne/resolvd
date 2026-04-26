// Inbound email queue + admin match flow.
//
// Webhook adapters (Graph subscription, Gmail push, SMTP/Mailgun) post
// JSON to /api/inbound/generic with the X-Inbound-Secret header. Inbound
// messages NEVER auto-create tickets or comments. They land in
// inbound_email_queue with status='unmatched' and an admin matches them
// to a target ticket via /api/inbound/:id/match.
//
// Loop prevention:
//   - Messages carrying X-Resolvd-No-Reply: 1 are dropped on ingest
//     (these are our own outbound bouncing back through a forwarder).
//   - Auto-Submitted: auto-replied is treated as discarded so a vendor
//     helpdesk's "we received your ticket" auto-ack doesn't surface to
//     the admin queue.

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { buildWritePatch, decryptRow, decryptRows } = require('../services/fields');
const { hashWhole } = require('../services/blindIndex');
const { notifyNewComment } = require('../services/email');
const inboundProcessor = require('../services/inboundProcessor');

const router = express.Router();

const TICKET_REF_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/;

function extractCandidateRef(...sources) {
  for (const src of sources) {
    if (!src) continue;
    const m = String(src).match(TICKET_REF_RE);
    if (m) return m[1];
  }
  return null;
}

function isAutoLoop(headers) {
  if (!headers || typeof headers !== 'object') return false;
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === 'x-resolvd-no-reply' && String(v).trim() === '1') return true;
    if (lk === 'auto-submitted' && /auto-(replied|generated)/i.test(String(v))) return true;
    if (lk === 'precedence' && /^bulk$/i.test(String(v).trim())) return true;
  }
  return false;
}

// POST /api/inbound/generic — webhook ingestion
router.post('/generic', async (req, res) => {
  const secret = process.env.INBOUND_WEBHOOK_SECRET;
  if (!secret) {
    return res.status(503).json({ error: 'Inbound webhook not configured (INBOUND_WEBHOOK_SECRET unset)' });
  }
  const provided = req.get('X-Inbound-Secret');
  if (!provided || provided !== secret) {
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }

  try {
    const {
      source = 'generic',
      external_message_id,
      from,
      from_name,
      to,
      cc,
      subject,
      body,
      message_id,
      in_reply_to,
      references,
      headers,
      attachments,
    } = req.body || {};

    if (!from || !body) {
      return res.status(400).json({ error: 'from and body required' });
    }

    if (isAutoLoop(headers || {})) {
      return res.status(202).json({ ok: true, dropped: 'auto_loop' });
    }

    // Idempotency: identical external_message_id → skip insert.
    if (external_message_id) {
      const dup = await pool.query(
        `SELECT id FROM inbound_email_queue WHERE external_message_id = $1`,
        [external_message_id]
      );
      if (dup.rows[0]) return res.status(202).json({ ok: true, duplicate: true, id: dup.rows[0].id });
    }

    const candidateRef = extractCandidateRef(subject, body);
    const fromBlind = hashWhole(from);
    const ccList = Array.isArray(cc) ? cc : (cc ? String(cc).split(',').map(s => s.trim()).filter(Boolean) : []);

    // 1. Persist the raw inbound row first so we always have a record,
    //    regardless of what happens next.
    const patch = await buildWritePatch(pool, 'inbound_email_queue', {
      subject: subject || null,
      body,
    });
    const cols = ['source', 'external_message_id', 'from_addr', 'from_addr_blind_idx',
      'from_name', 'to_addr', 'message_id', 'in_reply_to', 'ref_headers',
      'candidate_ticket_ref', 'raw_headers', ...patch.cols];
    const values = [
      source, external_message_id || null, String(from).toLowerCase().trim(), fromBlind,
      from_name || null, to || null, message_id || null, in_reply_to || null,
      Array.isArray(references) ? references.join(' ') : (references || null),
      candidateRef, JSON.stringify(headers || {}), ...patch.values,
    ];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const result = await pool.query(
      `INSERT INTO inbound_email_queue (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id, candidate_ticket_ref`,
      values
    );
    const queueRowId = result.rows[0].id;

    // 2. If subject carries a #PREFIX, try the auto-create flow. Failures
    //    fall through to leave the row as 'unmatched' for admin attention.
    let autoResult = null;
    try {
      autoResult = await inboundProcessor.tryAutoCreate({
        subject,
        body,
        fromAddress: String(from).toLowerCase().trim(),
        ccAddresses: ccList,
        attachments,
        queueRowId,
      });
    } catch (e) {
      console.error('auto-create attempt failed:', e);
      autoResult = { ok: false, reason: `error:${e.message}` };
    }

    if (autoResult?.ok) {
      // Mark queue row matched to the new ticket; record any unknown CCs
      // on reject_reason so admins can curate later. Reused-ticket case
      // tags the row so an admin browsing the queue knows the email
      // attached to an existing thread instead of opening a new one.
      const noteParts = [];
      if (autoResult.kind === 'reused') noteParts.push(`reused:${autoResult.ticket.mot_ref}`);
      if (autoResult.unknownCcs?.length) noteParts.push(`unknown_cc:${autoResult.unknownCcs.join(',')}`);
      const note = noteParts.length ? noteParts.join(' ') : null;
      await pool.query(
        `UPDATE inbound_email_queue
            SET status = 'matched',
                matched_ticket_id = $1,
                matched_at = NOW(),
                reject_reason = $2
          WHERE id = $3`,
        [autoResult.ticket.id, note, queueRowId]
      );
      // Confirmation goes ONLY to the originator — not the CCs.
      inboundProcessor.sendCreationConfirmation({
        submitter: autoResult.submitter,
        ticket: autoResult.ticket,
        project: autoResult.project,
      }).catch(err => console.error('creation confirmation failed:', err.message));

      return res.status(201).json({
        ok: true, id: queueRowId,
        kind: autoResult.kind,
        ticket_id: autoResult.ticket.id,
        ticket_ref: autoResult.ticket.mot_ref,
        attached_contacts: autoResult.attachedContactIds,
        unknown_ccs: autoResult.unknownCcs,
      });
    }

    // Auto-create declined or unparseable. If a #PREFIX was present but
    // failed (project not found / sender unauthorised), surface that to
    // the admin via reject_reason so they know why it didn't auto-land.
    if (autoResult && autoResult.reason && autoResult.reason !== 'no_prefix') {
      await pool.query(
        `UPDATE inbound_email_queue SET reject_reason = $1 WHERE id = $2`,
        [autoResult.reason, queueRowId]
      );
    }

    res.status(201).json({
      ok: true, id: queueRowId,
      candidate_ref: result.rows[0].candidate_ticket_ref,
      auto_create: autoResult?.reason || 'no_prefix',
    });
  } catch (err) {
    console.error('inbound webhook error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/inbound — admin list (default: unmatched only)
router.get('/', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const status = req.query.status || 'unmatched';
    const r = await pool.query(`
      SELECT q.id, q.received_at, q.source, q.from_addr, q.from_name, q.to_addr,
             q.subject, q.subject_enc, q.candidate_ticket_ref, q.status,
             q.matched_ticket_id, q.matched_at, q.reject_reason,
             c.id AS contact_id, c.name AS contact_name, c.name_enc AS contact_name_enc,
             c.company_id, co.name AS company_name, co.name_enc AS company_name_enc,
             t.mot_ref AS matched_ticket_ref, t.title AS matched_ticket_title,
             t.title_enc AS matched_ticket_title_enc
        FROM inbound_email_queue q
        LEFT JOIN contacts c ON q.from_addr_blind_idx = c.email_blind_idx AND c.is_active = TRUE
        LEFT JOIN companies co ON c.company_id = co.id
        LEFT JOIN tickets t ON q.matched_ticket_id = t.id
       WHERE q.status = $1
       ORDER BY q.received_at DESC
       LIMIT 200
    `, [status]);
    await decryptRows('inbound_email_queue', r.rows, {
      aliases: {
        contact_name: 'contacts.name',
        company_name: 'companies.name',
        matched_ticket_title: 'tickets.title',
      },
    });
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/inbound/:id — admin preview (decrypted)
router.get('/:id', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM inbound_email_queue WHERE id = $1`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    await decryptRow('inbound_email_queue', r.rows[0]);

    // Suggest a contact match if the sender HMAC corresponds to one.
    let suggestedContact = null;
    if (r.rows[0].from_addr_blind_idx) {
      const c = await pool.query(`
        SELECT c.*, co.id AS company_id, co.name AS company_name, co.name_enc AS company_name_enc
          FROM contacts c
          JOIN companies co ON co.id = c.company_id
         WHERE c.email_blind_idx = $1 AND c.is_active = TRUE
         LIMIT 1
      `, [r.rows[0].from_addr_blind_idx]);
      if (c.rows[0]) {
        await decryptRow('contacts', c.rows[0], { aliases: { company_name: 'companies.name' } });
        suggestedContact = c.rows[0];
      }
    }

    res.json({ message: r.rows[0], suggested_contact: suggestedContact });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/inbound/:id/match — turn an unmatched message into a comment
router.post('/:id/match', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const { ticket_id, contact_id } = req.body || {};
    if (!ticket_id) return res.status(400).json({ error: 'ticket_id required' });

    const queue = await pool.query(`SELECT * FROM inbound_email_queue WHERE id = $1`, [req.params.id]);
    if (!queue.rows[0]) return res.status(404).json({ error: 'Not found' });
    if (queue.rows[0].status !== 'unmatched') {
      return res.status(409).json({ error: `Already ${queue.rows[0].status}` });
    }

    const ticket = await pool.query(
      `SELECT id, mot_ref, title, title_enc, auto_mute_vendor_replies FROM tickets WHERE id = $1`,
      [Number(ticket_id)]
    );
    if (!ticket.rows[0]) return res.status(404).json({ error: 'Ticket not found' });
    await decryptRow('tickets', ticket.rows[0]);
    // Ticket-level mute does NOT block the match — the comment still
    // lands in the thread so nothing is lost in a separate bucket. It
    // arrives with is_muted=TRUE; the UI collapses muted comments and
    // Admin/Manager can un-mute the ones they consider relevant.
    const muteByDefault = !!ticket.rows[0].auto_mute_vendor_replies;

    await decryptRow('inbound_email_queue', queue.rows[0]);
    const queueRow = queue.rows[0];

    // Insert as a vendor-visible comment under the matched ticket.
    const attribution = queueRow.from_name
      ? `${queueRow.from_name} <${queueRow.from_addr}>`
      : queueRow.from_addr;
    const commentBody =
      `[from ${attribution}` +
      (queueRow.subject ? ` — “${queueRow.subject}”` : '') + ']\n\n' +
      (queueRow.body || '');

    const patch = await buildWritePatch(pool, 'comments', { body: commentBody });
    const cols = ['ticket_id', 'user_id', 'is_external_visible', 'is_internal',
      'is_muted', 'vendor_contact_id', 'source_inbound_email_id', ...patch.cols];
    const values = [
      Number(ticket_id), null, true, false,
      muteByDefault,
      contact_id ? Number(contact_id) : null,
      queueRow.id,
      ...patch.values,
    ];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const ins = await pool.query(
      `INSERT INTO comments (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`,
      values
    );

    await pool.query(
      `UPDATE inbound_email_queue
          SET status = 'matched',
              matched_ticket_id = $1,
              matched_contact_id = $2,
              matched_at = NOW(),
              matched_by_user_id = $3
        WHERE id = $4`,
      [Number(ticket_id), contact_id ? Number(contact_id) : null, req.session.user.id, queueRow.id]
    );
    await pool.query(`UPDATE tickets SET updated_at = NOW() WHERE id = $1`, [Number(ticket_id)]);

    res.status(201).json({ ok: true, comment_id: ins.rows[0].id, muted: muteByDefault });

    // Followers only get pinged for non-muted comments — the whole point
    // of muting at the ticket level is to silence the noise.
    if (!muteByDefault) {
      notifyNewComment(pool, {
        ticket: ticket.rows[0],
        comment: commentBody,
        actorId: req.session.user.id,
        actorName: queueRow.from_name || queueRow.from_addr,
      }).catch(() => {});
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/inbound/:id/discard — admin marks a queue row as not-applicable
router.post('/:id/discard', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const reason = (req.body?.reason === 'spam') ? 'spam' : 'discarded';
    const r = await pool.query(
      `UPDATE inbound_email_queue
          SET status = $1, matched_by_user_id = $2, matched_at = NOW()
        WHERE id = $3 AND status = 'unmatched'
        RETURNING *`,
      [reason, req.session.user.id, req.params.id]
    );
    if (!r.rows[0]) return res.status(409).json({ error: 'Already handled or not found' });
    res.json({ ok: true, status: r.rows[0].status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

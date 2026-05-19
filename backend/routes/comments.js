const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { fanoutNewComment, fanoutMention } = require('../services/notificationFanout');
const sla = require('../services/sla');
const { buildWritePatch, decryptRow, decryptRows } = require('../services/fields');
const { sendVendorEmail } = require('../services/vendorOutbound');
const { resolveMentions } = require('../services/mentions');
const { applyCommentToTerminalTicket } = require('../services/autoResolve');
const { isProjectHandler } = require('../services/ticketHelpers');

const router = express.Router();

// GET /api/tickets/:id/comments
router.get('/:id/comments', requireAuth, async (req, res) => {
  try {
    // vendor_company_id rides along when a comment came from a vendor
    // contact, so the UI can theme the pill per-vendor (multiple vendors
    // per project gets unique deterministic colors).
    const result = await pool.query(`
      SELECT c.*, u.display_name as user_name, u.email as user_email,
        vc.company_id as vendor_company_id,
        vc.name as vendor_contact_name,
        vc.name_enc as vendor_contact_name_enc,
        vco.name as vendor_company_name,
        vco.name_enc as vendor_company_name_enc
      FROM comments c
      LEFT JOIN users u ON c.user_id = u.id
      LEFT JOIN contacts vc ON vc.id = c.vendor_contact_id
      LEFT JOIN companies vco ON vco.id = vc.company_id
      WHERE c.ticket_id = $1
      ORDER BY c.created_at ASC
    `, [req.params.id]);
    await decryptRows('comments', result.rows, {
      aliases: {
        vendor_contact_name: 'contacts.name',
        vendor_company_name: 'companies.name',
      },
    });

    // AI usage visibility — strip ai_* fields the viewer isn't allowed
    // to see. Vendors never see (they don't reach this endpoint anyway,
    // but defensive). Comment author always sees own. Admin/Manager
    // sees all. Otherwise it depends on branding.ai_disclosure_audience
    // and the comment's snapshotted ai_publish_consent.
    const viewer = req.session.user;
    const aiSettings = await require('../services/aiSettings').getSettings().catch(() => null);
    const audience = aiSettings?.disclosure_audience || 'self_and_admin';
    const isPriv = ['Admin', 'Manager'].includes(viewer.role);
    for (const row of result.rows) {
      if (!row.ai_provider) continue;
      const isAuthor = row.user_id === viewer.id;
      let visible = isPriv || isAuthor;
      if (!visible && audience === 'all_users') visible = true;
      if (!visible && row.ai_publish_consent === true) visible = true;
      if (!visible) {
        row.ai_provider = null;
        row.ai_model = null;
        row.ai_input_tokens = null;
        row.ai_output_tokens = null;
        row.ai_tone = null;
        row.ai_verbosity = null;
        row.ai_eli5 = null;
        row.ai_project_context_used = null;
      }
    }

    // Stamp distributed_at for any comment in this ticket that hasn't
    // been distributed yet AND whose author is someone other than the
    // viewer. Counts UI reads by non-authors as "the original got out".
    // System comments are skipped (no editing, no badge). Vendor inbound
    // (vendor_contact_id) is also skipped — vendor authors are out of
    // the editing workflow.
    if (viewer?.id) {
      try {
        const updated = await pool.query(
          `UPDATE comments SET distributed_at = NOW()
             WHERE ticket_id = $1
               AND distributed_at IS NULL
               AND is_system = FALSE
               AND vendor_contact_id IS NULL
               AND user_id IS NOT NULL
               AND user_id <> $2
             RETURNING id`,
          [req.params.id, viewer.id]
        );
        if (updated.rowCount > 0) {
          const stampedIds = new Set(updated.rows.map((r) => r.id));
          const stampTime = new Date().toISOString();
          for (const row of result.rows) {
            if (stampedIds.has(row.id)) row.distributed_at = stampTime;
          }
        }
      } catch (err) {
        // Tracking is best-effort — never block the comment list on it.
        console.error('comment distribution stamp failed:', err.message);
      }
    }

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/tickets/:id/comments
router.post('/:id/comments', requireAuth, requireRole('Admin', 'Manager', 'Tech', 'Submitter'), async (req, res) => {
  try {
    const { body, is_external_visible, send_as, ai_rewrite_log_id, defer_vendor_email } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: 'Comment body required' });

    const ticket = await pool.query(
      'SELECT id, internal_ref, title, title_enc, submitted_by, project_id FROM tickets WHERE id = $1',
      [req.params.id]
    );
    if (!ticket.rows[0]) return res.status(404).json({ error: 'Ticket not found' });
    await decryptRow('tickets', ticket.rows[0]);

    // Vendor-visible comments require a handler role — global
    // Admin/Manager/Tech, OR a project member with a handler
    // role_override / is_agent=TRUE on this ticket's project. Submitters
    // can log internal comments but not flag content as outbound.
    const wantsExternal = !!is_external_visible;
    if (wantsExternal) {
      const allowed = await isProjectHandler(pool, {
        userId: req.session.user.id,
        role: req.session.user.role,
        projectId: ticket.rows[0].project_id,
      });
      if (!allowed) {
        return res.status(403).json({ error: 'Not authorised to mark comment as vendor-visible' });
      }
    }

    const trimmedBody = body.trim();
    const patch = await buildWritePatch(pool, 'comments', { body: trimmedBody });
    const cols = ['ticket_id', 'user_id', 'is_external_visible', ...patch.cols];
    const values = [Number(req.params.id), req.session.user.id, wantsExternal, ...patch.values];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const insertResult = await pool.query(
      `INSERT INTO comments (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`,
      values
    );
    const newCommentId = insertResult.rows[0].id;

    // Apply the AI rewrite log if the client passed one. Copies provider /
    // model / tokens onto the comment + snapshots publish_usage consent
    // so visibility is locked at apply time. Silently skips on bad
    // log_id — the comment posts either way.
    if (ai_rewrite_log_id) {
      try {
        const aiRewrite = require('../services/aiRewrite');
        const meta = await aiRewrite.applyRewriteLog({
          logId: Number(ai_rewrite_log_id),
          userId: req.session.user.id,
          table: 'comments',
          rowId: newCommentId,
        });
        if (meta) {
          await pool.query(
            `UPDATE comments
                SET ai_provider = $1, ai_model = $2,
                    ai_input_tokens = $3, ai_output_tokens = $4,
                    ai_tone = $5, ai_verbosity = $6, ai_eli5 = $7,
                    ai_publish_consent = $8,
                    ai_project_context_used = $9
              WHERE id = $10`,
            [meta.provider, meta.model, meta.input_tokens, meta.output_tokens,
             meta.tone, meta.verbosity, meta.eli5, meta.publish_consent,
             meta.project_context_used, newCommentId]
          );
        }
      } catch (err) {
        console.error('apply ai_rewrite_log failed:', err.message);
      }
    }

    // Update ticket updated_at
    await pool.query('UPDATE tickets SET updated_at = NOW() WHERE id = $1', [req.params.id]);

    // Auto-follow when the commenter has the preference enabled (default
    // ON). System comments don't trigger this.
    const prefRow = await pool.query(
      'SELECT preferences FROM users WHERE id = $1',
      [req.session.user.id]
    );
    const autoFollow = prefRow.rows[0]?.preferences?.auto_follow_on_comment;
    if (autoFollow !== false) {
      await pool.query(
        `INSERT INTO ticket_followers (ticket_id, user_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [req.params.id, req.session.user.id]
      );
    }

    const comment = await pool.query(`
      SELECT c.*, u.display_name as user_name, u.email as user_email
      FROM comments c
      LEFT JOIN users u ON c.user_id = u.id
      WHERE c.id = $1
    `, [insertResult.rows[0].id]);

    const result = comment.rows[0];
    await decryptRow('comments', result);
    res.status(201).json(result);

    // Auto-reopen if ticket is terminal and comment is substantive.
    if (!result.is_system) {
      applyCommentToTerminalTicket({
        ticketId: ticket.rows[0].id,
        commentBody: trimmedBody,
        actorUserId: req.session.user.id,
      }).catch(err => console.error('auto-reopen check failed:', err.message));
    }

    // SLA first-response stamp: any non-system comment by someone other
    // than the submitter qualifies. Self-replies by the submitter
    // shouldn't tick the response clock.
    if (!result.is_system && req.session.user.id !== ticket.rows[0].submitted_by) {
      sla.markResponded(null, ticket.rows[0].id)
        .catch(err => console.error('sla markResponded failed:', err.message));
    }

    // Vendor-bound outbound fires only when the comment is flagged for
    // external visibility AND there are contacts attached to the ticket.
    // send_as: 'submitter' resolves to ticket.submitted_by; a numeric id
    // resolves to that active user; anything else falls back to the actor.
    if (wantsExternal && !result.is_system) {
      let vendorActorId = req.session.user.id;
      if (send_as === 'submitter' && ticket.rows[0].submitted_by) {
        vendorActorId = ticket.rows[0].submitted_by;
      } else {
        const numeric = Number(send_as);
        if (Number.isInteger(numeric) && numeric > 0) {
          const u = await pool.query(
            `SELECT id FROM users WHERE id = $1 AND status = 'active'`,
            [numeric]
          );
          if (u.rows[0]) vendorActorId = u.rows[0].id;
        }
      }
      // defer_vendor_email = client is about to upload attachments to
      // this comment. The outbound route races the upload otherwise
      // (vendor email leaves before attachments are linked). The
      // attachments POST handler fires sendVendorEmail itself once the
      // files are persisted. Stash the resolved actor on the comment
      // row so the upload handler can re-use it without the client
      // having to re-send send_as.
      if (defer_vendor_email) {
        await pool.query(
          `UPDATE comments SET vendor_actor_id = $1 WHERE id = $2`,
          [vendorActorId, result.id]
        );
      } else {
        sendVendorEmail({
          eventType: 'new_comment',
          ticketId: ticket.rows[0].id,
          actorId: vendorActorId,
          commentId: result.id,
        }).catch(err => console.error('vendor outbound failed:', err.message));
      }
    }

    // Resolve @mentions, then fire the comment fanout (excluding mentioned
    // users — they get a louder mention notification instead) and the
    // mention fanout in parallel. System comments skip both.
    if (!result.is_system) {
      (async () => {
        try {
          const mentioned = await resolveMentions(trimmedBody, {
            excludeUserId: req.session.user.id,
            projectId: ticket.rows[0].project_id,
          });
          const mentionedIds = mentioned.map(m => m.id);
          await Promise.all([
            fanoutNewComment(pool, {
              ticket: ticket.rows[0],
              comment: trimmedBody,
              commentId: insertResult.rows[0].id,
              actorId: req.session.user.id,
              actorName: req.session.user.displayName,
              excludeUserIds: mentionedIds,
            }).catch(err => console.error('comment fanout failed:', err.message)),
            mentioned.length
              ? fanoutMention(pool, {
                  ticket: ticket.rows[0],
                  comment: trimmedBody,
                  commentId: insertResult.rows[0].id,
                  mentionedUsers: mentioned,
                  actorId: req.session.user.id,
                  actorName: req.session.user.displayName,
                }).catch(err => console.error('mention fanout failed:', err.message))
              : null,
          ]);
        } catch (err) {
          console.error('comment+mention fanout failed:', err.message);
        }
      })();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/comments/:id/mute   — Admin/Manager flips is_muted=TRUE
// POST /api/comments/:id/unmute — Admin/Manager flips is_muted=FALSE
async function setMuted(req, res, value) {
  try {
    const r = await pool.query(
      `UPDATE comments SET is_muted = $1
        WHERE id = $2
        RETURNING id, ticket_id, is_muted`,
      [value, req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Comment not found' });
    // Audit on ticket so the timeline shows who un-muted what.
    await pool.query(
      `INSERT INTO audit_log (ticket_id, user_id, action, new_value, note)
       VALUES ($1, $2, $3, $4, $5)`,
      [r.rows[0].ticket_id, req.session.user.id,
       value ? 'comment_muted' : 'comment_unmuted',
       String(r.rows[0].id), null]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
}

router.post('/comments/:id/mute',   requireAuth, requireRole('Admin', 'Manager'),
  (req, res) => setMuted(req, res, true));
router.post('/comments/:id/unmute', requireAuth, requireRole('Admin', 'Manager'),
  (req, res) => setMuted(req, res, false));

// PATCH /api/comments/:id — author or Admin/Manager can edit body.
// System comments and inbound vendor-reply rows are not editable. Editing
// stamps edited_at, scrubs the ai_* snapshot (no longer purely AI), and
// audits on the ticket. Vendor outbound is NOT re-fired — the recipient
// already has the original email; a follow-up comment communicates the
// correction.
router.patch('/comments/:id', requireAuth, async (req, res) => {
  try {
    const newBody = String(req.body?.body || '').trim();
    if (!newBody) return res.status(400).json({ error: 'body required' });

    const existing = await pool.query(
      `SELECT id, ticket_id, user_id, is_system, body, body_enc, source_inbound_email_id
         FROM comments WHERE id = $1`,
      [req.params.id]
    );
    if (!existing.rows[0]) return res.status(404).json({ error: 'Comment not found' });
    const c = existing.rows[0];
    if (c.is_system) return res.status(400).json({ error: 'System comments are not editable' });
    if (c.source_inbound_email_id) {
      return res.status(400).json({ error: 'Inbound vendor replies are not editable' });
    }

    const user = req.session.user;
    const isAuthor = c.user_id === user.id;
    const isPriv = ['Admin', 'Manager'].includes(user.role);
    if (!isAuthor && !isPriv) {
      return res.status(403).json({ error: 'Only the author, Admin, or Manager can edit this comment' });
    }

    // Lock comments once anyone has replied. The thread reading order
    // matters — a stealth edit after a reply could rewrite the context
    // the next comment was responding to. Admins / Managers aren't
    // exempted: the lock is about thread integrity, not permission.
    // System comments are skipped (auto status / merge bookkeeping
    // shouldn't lock human comments).
    const newer = await pool.query(
      `SELECT 1 FROM comments
        WHERE ticket_id = $1
          AND id > $2
          AND is_system = FALSE
        LIMIT 1`,
      [c.ticket_id, c.id]
    );
    if (newer.rows.length) {
      return res.status(409).json({ error: 'Comment locked — a newer reply has been posted on this ticket. Add a follow-up comment with the correction instead.' });
    }

    await decryptRow('comments', c);
    const oldBody = c.body || '';
    if (oldBody === newBody) {
      return res.json({ id: c.id, ticket_id: c.ticket_id, edited_at: null, body: newBody });
    }

    const patch = await buildWritePatch(pool, 'comments', { body: newBody });
    const sets = patch.cols.map((col, i) => `${col} = $${i + 1}`);
    sets.push(`edited_at = NOW()`);
    sets.push(`ai_provider = NULL`);
    sets.push(`ai_model = NULL`);
    sets.push(`ai_input_tokens = NULL`);
    sets.push(`ai_output_tokens = NULL`);
    sets.push(`ai_tone = NULL`);
    sets.push(`ai_verbosity = NULL`);
    sets.push(`ai_eli5 = NULL`);
    sets.push(`ai_publish_consent = NULL`);
    sets.push(`ai_project_context_used = NULL`);

    const values = [...patch.values, req.params.id];
    const result = await pool.query(
      `UPDATE comments SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING id, ticket_id, edited_at`,
      values
    );

    await pool.query(
      `INSERT INTO audit_log (ticket_id, user_id, action, old_value, new_value, note)
       VALUES ($1, $2, 'comment_edited', $3, $4, $5)`,
      [c.ticket_id, user.id, String(c.id), String(c.id), isAuthor ? null : 'edited by handler']
    );

    res.json({ id: result.rows[0].id, ticket_id: result.rows[0].ticket_id, edited_at: result.rows[0].edited_at, body: newBody });
  } catch (err) {
    console.error('comment edit failed:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/comments/:id — Admin only
router.delete('/comments/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM comments WHERE id = $1 RETURNING id, ticket_id`,
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Comment not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

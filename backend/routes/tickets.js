const express = require('express');
const { pool, transaction } = require('../db/pool');
const { nextInternalRef, computePriority } = require('../db/schema');
const { requireAuth, requireRole } = require('../middleware/auth');
const { notifyStatusChange, notifyPendingReview, notifyNewComment, notifyAssignment } = require('../services/email');
const { getMode, buildWritePatch, decryptRow, decryptRows } = require('../services/fields');
const blindIndex = require('../services/blindIndex');
const { logSupportRead } = require('../middleware/supportAccess');
const { sendVendorEmail } = require('../services/vendorOutbound');

const router = express.Router();

// Aliases used in JOIN result rows so decryptRow can also recover ciphertext
// stored under aliased column names (`bt.title AS blocking_ticket_title`).
const TICKET_JOIN_ALIASES = {
  blocking_ticket_title: 'tickets.title',
};

async function auditLog(client, { ticketId, userId, action, oldValue, newValue, note }) {
  const patch = await buildWritePatch(client, 'audit_log', {
    old_value: oldValue ?? null,
    new_value: newValue ?? null,
    note: note ?? null,
  });
  const cols = ['ticket_id', 'user_id', 'action', ...patch.cols];
  const values = [ticketId || null, userId || null, action, ...patch.values];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  await client.query(
    `INSERT INTO audit_log (${cols.join(', ')}) VALUES (${placeholders})`,
    values
  );
}

async function systemComment(client, ticketId, body) {
  const patch = await buildWritePatch(client, 'comments', { body });
  const cols = ['ticket_id', 'user_id', 'is_internal', 'is_system', ...patch.cols];
  const values = [ticketId, null, true, true, ...patch.values];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  await client.query(
    `INSERT INTO comments (${cols.join(', ')}) VALUES (${placeholders})`,
    values
  );
}

// Returns array of project IDs the user can access, or null if Admin (= all)
async function getAccessibleProjectIds(user) {
  if (['Admin','Manager'].includes(user.role)) return null;
  const result = await pool.query(
    'SELECT project_id FROM project_members WHERE user_id = $1',
    [user.id]
  );
  return result.rows.map(r => r.project_id);
}

// GET /api/tickets/counts
router.get('/counts', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const { project_id } = req.query;

    const where = [];
    const params = [];
    let p = 1;

    // Project filter
    if (project_id) {
      where.push(`project_id = $${p++}`);
      params.push(Number(project_id));
    } else {
      const accessibleIds = await getAccessibleProjectIds(user);
      if (accessibleIds !== null) {
        if (accessibleIds.length === 0) {
          return res.json({ total:0, active:0, open:0, in_progress:0, awaiting_mot:0,
            pending_review:0, reopened:0, closed:0, flagged:0, p1:0, p2:0,
            external_unacked:0, external_resolved:0, internal_blocker:0 });
        }
        where.push(`project_id = ANY($${p++})`);
        params.push(accessibleIds);
      }
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const result = await pool.query(`
      SELECT
        COUNT(*)::int as total,
        SUM(CASE WHEN internal_status != 'Closed' THEN 1 ELSE 0 END)::int as active,
        SUM(CASE WHEN internal_status = 'Open' THEN 1 ELSE 0 END)::int as open,
        SUM(CASE WHEN internal_status = 'In Progress' THEN 1 ELSE 0 END)::int as in_progress,
        SUM(CASE WHEN internal_status = 'Awaiting Input' THEN 1 ELSE 0 END)::int as awaiting_mot,
        SUM(CASE WHEN internal_status = 'Pending Review' THEN 1 ELSE 0 END)::int as pending_review,
        SUM(CASE WHEN internal_status = 'Reopened' THEN 1 ELSE 0 END)::int as reopened,
        SUM(CASE WHEN internal_status = 'Closed' THEN 1 ELSE 0 END)::int as closed,
        SUM(CASE WHEN flagged_for_review = TRUE AND internal_status != 'Closed' THEN 1 ELSE 0 END)::int as flagged,
        SUM(CASE WHEN effective_priority = 1 AND internal_status != 'Closed' THEN 1 ELSE 0 END)::int as p1,
        SUM(CASE WHEN effective_priority = 2 AND internal_status != 'Closed' THEN 1 ELSE 0 END)::int as p2,
        SUM(CASE WHEN external_status = 'Unacknowledged' AND internal_status != 'Closed' THEN 1 ELSE 0 END)::int as external_unacked,
        SUM(CASE WHEN external_status = 'Resolved' AND internal_status != 'Closed' THEN 1 ELSE 0 END)::int as external_resolved,
        SUM(CASE WHEN blocker_type = 'internal_input' AND internal_status != 'Closed' THEN 1 ELSE 0 END)::int as internal_blocker
      FROM tickets
      ${whereClause}
    `, params);

    const row = result.rows[0];
    const out = {};
    for (const k of Object.keys(row)) out[k] = row[k] ?? 0;
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/tickets
router.get('/', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const {
      project_id, internal_status, external_status, effective_priority,
      blocker_type, assigned_to, flagged_for_review, q, exclude_closed,
      sort_by = 'updated_at', sort_dir = 'desc',
      page = 1, limit = 50
    } = req.query;

    const where = [];
    const params = [];
    let p = 1;

    // Project access control
    if (project_id) {
      where.push(`t.project_id = $${p++}`);
      params.push(Number(project_id));
    } else {
      const accessibleIds = await getAccessibleProjectIds(user);
      if (accessibleIds !== null) {
        if (accessibleIds.length === 0) {
          return res.json({ tickets: [], total: 0, page: Number(page), limit: Number(limit) });
        }
        where.push(`t.project_id = ANY($${p++})`);
        params.push(accessibleIds);
      }
    }

    // Search: under encrypted mode the title ciphertext is opaque to ILIKE.
    // Use the title_blind_idx HMAC array for word-equality candidate match,
    // then post-filter the decrypted rows for the actual substring match.
    let postFilterTerm = null;
    if (q && q.trim()) {
      const term = `%${q.trim()}%`;
      const mode = await getMode(pool);
      if (mode === 'off') {
        where.push(`(t.title ILIKE $${p} OR t.internal_ref ILIKE $${p+1} OR t.description ILIKE $${p+2} OR t.external_ticket_ref ILIKE $${p+3})`);
        params.push(term, term, term, term);
        p += 4;
      } else {
        const tokenHashes = blindIndex.hashQuery(q);
        const titleClause = tokenHashes.length
          ? `t.title_blind_idx && $${p++}::text[]`
          : null;
        if (tokenHashes.length) params.push(tokenHashes);
        const refClauses = [`t.internal_ref ILIKE $${p++}`, `t.external_ticket_ref ILIKE $${p++}`];
        params.push(term, term);
        const clauses = titleClause ? [titleClause, ...refClauses] : refClauses;
        where.push(`(${clauses.join(' OR ')})`);
        postFilterTerm = q.trim().toLowerCase();
      }
    }
    if (internal_status) { where.push(`t.internal_status = $${p++}`); params.push(internal_status); }
    if (external_status) { where.push(`t.external_status = $${p++}`); params.push(external_status); }
    if (effective_priority) { where.push(`t.effective_priority = $${p++}`); params.push(Number(effective_priority)); }
    if (blocker_type) { where.push(`t.blocker_type = $${p++}`); params.push(blocker_type); }
    if (assigned_to) { where.push(`t.assigned_to = $${p++}`); params.push(Number(assigned_to)); }
    if (flagged_for_review !== undefined && flagged_for_review !== '') {
      where.push(`t.flagged_for_review = $${p++}`);
      params.push(flagged_for_review === 'true');
    }
    if (exclude_closed === '1') { where.push(`t.internal_status != 'Closed'`); }

    const allowed_sorts = ['created_at', 'updated_at', 'effective_priority', 'internal_ref'];
    const col = allowed_sorts.includes(sort_by) ? sort_by : 'updated_at';
    const dir = sort_dir === 'asc' ? 'ASC' : 'DESC';
    const offset = (Number(page) - 1) * Number(limit);
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const tickets = await pool.query(`
      SELECT t.*,
        proj.name as project_name, proj.prefix as project_prefix,
        sub.display_name as submitted_by_name,
        asgn.display_name as assigned_to_name,
        bt.internal_ref as blocking_ticket_ref,
        bt.title as blocking_ticket_title,
        bt.title_enc as blocking_ticket_title_enc
      FROM tickets t
      LEFT JOIN projects proj ON t.project_id = proj.id
      LEFT JOIN users sub ON t.submitted_by = sub.id
      LEFT JOIN users asgn ON t.assigned_to = asgn.id
      LEFT JOIN tickets bt ON t.blocked_by_ticket = bt.id
      ${whereClause}
      ORDER BY t.${col} ${dir}
      LIMIT $${p} OFFSET $${p+1}
    `, [...params, Number(limit), offset]);

    const total = await pool.query(`SELECT COUNT(*) as cnt FROM tickets t ${whereClause}`, params);

    await decryptRows('tickets', tickets.rows, { aliases: TICKET_JOIN_ALIASES });

    let outRows = tickets.rows;
    let outTotal = parseInt(total.rows[0].cnt, 10);
    if (postFilterTerm) {
      outRows = outRows.filter(r =>
        (r.title && r.title.toLowerCase().includes(postFilterTerm)) ||
        (r.description && r.description.toLowerCase().includes(postFilterTerm)) ||
        (r.internal_ref && r.internal_ref.toLowerCase().includes(postFilterTerm)) ||
        (r.external_ticket_ref && r.external_ticket_ref.toLowerCase().includes(postFilterTerm))
      );
      // Total in encrypted mode is approximate — the filter is partly
      // post-fetch, so we report the visible count rather than recompute.
      outTotal = outRows.length;
    }

    res.json({
      tickets: outRows,
      total: outTotal,
      page: Number(page),
      limit: Number(limit),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/tickets
router.post('/', requireAuth, requireRole('Admin', 'Manager', 'Submitter'), async (req, res) => {
  try {
    const user = req.session.user;
    const { project_id, title, description, impact = 2, urgency = 2, external_ticket_ref, assigned_to, contact_ids, submitted_by } = req.body;

    if (!project_id) return res.status(400).json({ error: 'project_id required' });
    if (!title) return res.status(400).json({ error: 'Title required' });

    // Verify project exists and is active
    const proj = await pool.query("SELECT id FROM projects WHERE id = $1 AND status = 'active'", [project_id]);
    if (!proj.rows[0]) return res.status(404).json({ error: 'Project not found or archived' });

    // Non-admins must be project members
    if (user.role !== 'Admin') {
      const member = await pool.query(
        'SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2',
        [project_id, user.id]
      );
      if (!member.rows[0]) return res.status(403).json({ error: 'Not a member of this project' });
    }

    const imp = Number(impact);
    const urg = Number(urgency);
    const computed = computePriority(imp, urg);

    // Submit-on-behalf: Admin/Manager may set submitted_by to any active
    // user. Submitters always file under themselves.
    let effectiveSubmitterId = user.id;
    if (submitted_by && ['Admin', 'Manager'].includes(user.role)) {
      const targetUser = await pool.query(
        `SELECT id FROM users WHERE id = $1 AND status = 'active'`,
        [Number(submitted_by)]
      );
      if (!targetUser.rows[0]) return res.status(400).json({ error: 'submitted_by user not found or inactive' });
      effectiveSubmitterId = targetUser.rows[0].id;
    }

    const ticket = await transaction(async (client) => {
      const internalRef = await nextInternalRef(client, Number(project_id));

      const sensitivePatch = await buildWritePatch(client, 'tickets', {
        title,
        description: description || null,
      });
      const mode = await getMode(client);
      const baseCols = ['project_id', 'internal_ref', 'submitted_by', 'assigned_to',
        'impact', 'urgency', 'computed_priority', 'effective_priority', 'external_ticket_ref',
        'title_blind_idx'];
      const baseValues = [
        Number(project_id), internalRef, effectiveSubmitterId,
        assigned_to ? Number(assigned_to) : null,
        imp, urg, computed, computed,
        external_ticket_ref || null,
        mode === 'standard' ? blindIndex.buildIndex(title) : null,
      ];
      const cols = [...baseCols, ...sensitivePatch.cols];
      const values = [...baseValues, ...sensitivePatch.values];
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');

      const result = await client.query(
        `INSERT INTO tickets (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
        values
      );

      const t = result.rows[0];
      await auditLog(client, { ticketId: t.id, userId: user.id, action: 'ticket_created', newValue: internalRef });
      if (effectiveSubmitterId !== user.id) {
        await auditLog(client, {
          ticketId: t.id, userId: user.id,
          action: 'submitted_on_behalf',
          newValue: String(effectiveSubmitterId),
          note: `Created on behalf of user ${effectiveSubmitterId}`,
        });
      }
      // Auto-follow: submitter watches their own ticket. Also follow the
      // creator when filing on behalf, so they see comments roll in.
      await client.query(
        'INSERT INTO ticket_followers (ticket_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [t.id, effectiveSubmitterId]
      );
      if (effectiveSubmitterId !== user.id) {
        await client.query(
          'INSERT INTO ticket_followers (ticket_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [t.id, user.id]
        );
      }
      // Attach any contacts selected at creation time.
      if (Array.isArray(contact_ids) && contact_ids.length) {
        for (const cid of contact_ids) {
          await client.query(
            `INSERT INTO ticket_contacts (ticket_id, contact_id, added_by_user_id)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [t.id, Number(cid), user.id]
          );
        }
      }
      return t;
    });

    await decryptRow('tickets', ticket);
    res.status(201).json(ticket);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/tickets/similar?title=...&external_ref=...&project_id=...
router.get('/similar', requireAuth, async (req, res) => {
  try {
    const { title = '', external_ref = '', project_id } = req.query;
    const searchText = title.trim();
    const extRef = external_ref.trim();
    if (searchText.length < 4 && !extRef) return res.json([]);

    const user = req.session.user;
    const accessibleIds = await getAccessibleProjectIds(user);

    // params: $1=searchText, $2=extRef, then project filters
    const params = [searchText, extRef];
    let p = 3;
    const where = [`t.internal_status = ANY(ARRAY['Open','In Progress','Awaiting','Pending Review','Reopened'])`];

    if (project_id) {
      where.push(`t.project_id = $${p++}`);
      params.push(Number(project_id));
    } else if (accessibleIds !== null) {
      if (accessibleIds.length === 0) return res.json([]);
      where.push(`t.project_id = ANY($${p++}::int[])`);
      params.push(accessibleIds);
    }

    const whereClause = 'AND ' + where.join(' AND ');

    // Encrypted mode disables Postgres full-text on title/description.
    // Phase 2c will reintroduce title fuzzy match via a HMAC blind index.
    // External-ref exact match still works either way.
    const mode = await getMode(pool);
    let result;
    if (mode === 'off') {
      result = await pool.query(`
        SELECT DISTINCT ON (t.id)
          t.id, t.internal_ref, t.title, t.internal_status, t.effective_priority,
          t.description, t.external_ticket_ref,
          proj.name AS project_name,
          ts_rank(
            to_tsvector('english', t.title || ' ' || COALESCE(t.description, '')),
            plainto_tsquery('english', $1)
          ) AS rank
        FROM tickets t
        LEFT JOIN projects proj ON t.project_id = proj.id
        WHERE (
          ($1 <> '' AND to_tsvector('english', t.title || ' ' || COALESCE(t.description, ''))
            @@ plainto_tsquery('english', $1))
          OR ($2 <> '' AND t.external_ticket_ref IS NOT NULL AND t.external_ticket_ref = $2)
        )
        ${whereClause}
        ORDER BY t.id, rank DESC
        LIMIT 5
      `, params);
    } else {
      // External-ref exact match only.
      if (!extRef) return res.json([]);
      result = await pool.query(`
        SELECT t.id, t.internal_ref, t.title, t.title_enc, t.internal_status, t.effective_priority,
          t.description, t.description_enc, t.external_ticket_ref,
          proj.name AS project_name, 0 AS rank
        FROM tickets t
        LEFT JOIN projects proj ON t.project_id = proj.id
        WHERE t.external_ticket_ref = $2
        ${whereClause}
        LIMIT 5
      `, params);
    }

    await decryptRows('tickets', result.rows);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/tickets/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.*,
        proj.name as project_name, proj.prefix as project_prefix, proj.has_external_vendor as project_has_external_vendor,
        sub.display_name as submitted_by_name, sub.email as submitted_by_email,
        asgn.display_name as assigned_to_name,
        bt.internal_ref as blocking_ticket_ref, bt.title as blocking_ticket_title, bt.title_enc as blocking_ticket_title_enc, bt.internal_status as blocking_ticket_status
      FROM tickets t
      LEFT JOIN projects proj ON t.project_id = proj.id
      LEFT JOIN users sub ON t.submitted_by = sub.id
      LEFT JOIN users asgn ON t.assigned_to = asgn.id
      LEFT JOIN tickets bt ON t.blocked_by_ticket = bt.id
      WHERE t.id = $1
    `, [req.params.id]);

    if (!result.rows[0]) return res.status(404).json({ error: 'Ticket not found' });
    await decryptRow('tickets', result.rows[0], { aliases: TICKET_JOIN_ALIASES });
    await logSupportRead(req, { action: 'ticket.view', targetTable: 'tickets', targetId: result.rows[0].id });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/tickets/:id
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const ticketResult = await pool.query('SELECT * FROM tickets WHERE id = $1', [req.params.id]);
    const ticket = ticketResult.rows[0];
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const isAdmin = ['Admin','Manager'].includes(user.role);
    const isSubmitter = user.role === 'Submitter';
    const updates = {};
    const body = req.body;

    const updated = await transaction(async (client) => {
      if ((isAdmin || isSubmitter) && body.title !== undefined) updates.title = body.title;
      if ((isAdmin || isSubmitter) && body.description !== undefined) updates.description = body.description;
      if ((isAdmin || isSubmitter) && body.assigned_to !== undefined) {
        updates.assigned_to = body.assigned_to ? Number(body.assigned_to) : null;
      }
      // Admin/Manager can reassign the submitter (e.g. correcting an
      // import or filing-on-behalf metadata). Submitters cannot.
      if (isAdmin && body.submitted_by !== undefined && body.submitted_by !== null) {
        const targetId = Number(body.submitted_by);
        if (!Number.isInteger(targetId) || targetId <= 0) {
          return res.status(400).json({ error: 'submitted_by must be a user id' });
        }
        const targetUser = await client.query(
          `SELECT id FROM users WHERE id = $1 AND status = 'active'`,
          [targetId]
        );
        if (!targetUser.rows[0]) return res.status(400).json({ error: 'submitted_by user not found or inactive' });
        if (targetId !== ticket.submitted_by) {
          updates.submitted_by = targetId;
          await auditLog(client, {
            ticketId: ticket.id, userId: user.id,
            action: 'submitter_change',
            oldValue: String(ticket.submitted_by ?? ''),
            newValue: String(targetId),
          });
          // New submitter auto-follows; old submitter stays a follower
          // (we don't unfollow on change — they may still want updates).
          await client.query(
            'INSERT INTO ticket_followers (ticket_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [ticket.id, targetId]
          );
        }
      }

      let imp = ticket.impact, urg = ticket.urgency;
      if ((isAdmin || isSubmitter) && body.impact !== undefined) { imp = Number(body.impact); updates.impact = imp; }
      if ((isAdmin || isSubmitter) && body.urgency !== undefined) { urg = Number(body.urgency); updates.urgency = urg; }
      if (updates.impact !== undefined || updates.urgency !== undefined) {
        updates.computed_priority = computePriority(imp, urg);
        updates.effective_priority = ticket.priority_override ?? updates.computed_priority;
      }

      if (isAdmin && body.priority_override !== undefined) {
        const old = ticket.priority_override;
        const ovr = body.priority_override === null ? null : Number(body.priority_override);
        updates.priority_override = ovr;
        updates.effective_priority = ovr ?? ticket.computed_priority;
        await auditLog(client, { ticketId: ticket.id, userId: user.id, action: 'priority_override', oldValue: String(old), newValue: String(ovr) });
      }

      if (isAdmin && body.internal_status !== undefined) {
        if (ticket.followup_at && body.internal_status !== ticket.internal_status) {
          throw Object.assign(
            new Error('Cannot change status while a follow-up reminder is pending. Cancel it or wait for it to fire.'),
            { httpStatus: 409 }
          );
        }
        const old = ticket.internal_status;
        updates.internal_status = body.internal_status;
        await auditLog(client, { ticketId: ticket.id, userId: user.id, action: 'status_change', oldValue: old, newValue: body.internal_status });
        if (body.internal_status === 'Reopened') {
          await auditLog(client, { ticketId: ticket.id, userId: user.id, action: 'reopened', note: 'Ticket reopened' });
        }
        // Track resolved_at for auto-close grace window. Set when entering
        // a resolved_pending_close-tagged status; clear on any other move.
        const tagRow = await client.query(
          `SELECT semantic_tag FROM statuses WHERE kind='internal' AND name=$1`,
          [body.internal_status]
        );
        const tag = tagRow.rows[0]?.semantic_tag || null;
        if (tag === 'resolved_pending_close') {
          updates.resolved_at = new Date().toISOString();
        } else {
          updates.resolved_at = null;
        }
        // Follow-up timer lives on pending_review states. Defensive
        // clear on any move out of pending_review (the in-flight guard
        // above already blocks transitions while followup_at is set).
        const oldTag = await client.query(
          `SELECT semantic_tag FROM statuses WHERE kind='internal' AND name=$1`,
          [ticket.internal_status]
        );
        if (oldTag.rows[0]?.semantic_tag === 'pending_review' && tag !== 'pending_review') {
          updates.followup_at = null;
          updates.followup_user_id = null;
        }
      }

      if (isAdmin && body.external_status !== undefined) {
        const old = ticket.external_status;
        updates.external_status = body.external_status;
        updates.external_updated_at = new Date().toISOString();
        await auditLog(client, { ticketId: ticket.id, userId: user.id, action: 'external_status_update', oldValue: old, newValue: body.external_status });
        if (body.external_status === 'Resolved') {
          updates.internal_status = 'Pending Review';
          updates.flagged_for_review = true;
          await auditLog(client, { ticketId: ticket.id, userId: user.id, action: 'status_change', oldValue: ticket.internal_status, newValue: 'Pending Review', note: 'External partner marked resolved — flagged for review' });
          await systemComment(client, ticket.id, 'The external partner has marked this issue as Resolved. Please review and confirm the fix, then close or reopen this ticket.');
        }
      }

      if (isAdmin && body.external_ticket_ref !== undefined) updates.external_ticket_ref = body.external_ticket_ref;
      if (isAdmin && body.review_note !== undefined) updates.review_note = body.review_note;
      if (isAdmin && body.flagged_for_review !== undefined) updates.flagged_for_review = !!body.flagged_for_review;
      // Per-ticket "mute the vendor" toggle. Vendor replies still land
      // in the thread, but arrive with is_muted=TRUE (the UI collapses
      // them) and don't ping followers. Admin/Manager can un-mute any
      // single comment they decide is relevant.
      if ((isAdmin || user.role === 'Manager') && body.auto_mute_vendor_replies !== undefined) {
        updates.auto_mute_vendor_replies = !!body.auto_mute_vendor_replies;
        await auditLog(client, {
          ticketId: ticket.id, userId: user.id,
          action: 'auto_mute_vendor_replies_change',
          oldValue: String(ticket.auto_mute_vendor_replies),
          newValue: String(!!body.auto_mute_vendor_replies),
        });
      }

      if (isAdmin && body.blocker_type !== undefined) {
        const oldBlocker = ticket.blocker_type;
        updates.blocker_type = body.blocker_type || null;
        if (body.blocker_type === 'internal') {
          updates.blocked_by_ticket = body.blocked_by_ticket ? Number(body.blocked_by_ticket) : null;
          updates.internal_blocker_note = null;
        } else if (body.blocker_type === 'internal_input') {
          updates.internal_blocker_note = body.internal_blocker_note || null;
          updates.blocked_by_ticket = null;
          if (ticket.internal_status !== 'Awaiting Input') {
            updates.internal_status = 'Awaiting Input';
            await auditLog(client, { ticketId: ticket.id, userId: user.id, action: 'status_change', oldValue: ticket.internal_status, newValue: 'Awaiting Input', note: 'Blocker set: team input required' });
          }
        } else if (!body.blocker_type) {
          updates.blocked_by_ticket = null;
          updates.internal_blocker_note = null;
          if (ticket.internal_status === 'Awaiting Input') {
            updates.internal_status = 'In Progress';
            await auditLog(client, { ticketId: ticket.id, userId: user.id, action: 'status_change', oldValue: 'Awaiting Input', newValue: 'In Progress', note: 'Blocker cleared' });
          }
        }
        await auditLog(client, { ticketId: ticket.id, userId: user.id, action: 'blocker_change', oldValue: oldBlocker, newValue: body.blocker_type || null });
      }

      if (Object.keys(updates).length === 0) return ticket;
      updates.updated_at = new Date().toISOString();

      // Split sensitive vs pass-through fields, then encrypt the sensitive
      // ones via buildWritePatch so writes go to *_enc when mode='standard'.
      const SENSITIVE = new Set(['title', 'description', 'review_note', 'internal_blocker_note']);
      const plainObj = {};
      const passthrough = {};
      for (const [k, v] of Object.entries(updates)) {
        if (SENSITIVE.has(k)) plainObj[k] = v; else passthrough[k] = v;
      }
      const sensitivePatch = await buildWritePatch(client, 'tickets', plainObj);
      const updMode = await getMode(client);
      const extraCols = [];
      const extraVals = [];
      if ('title' in plainObj) {
        extraCols.push('title_blind_idx');
        extraVals.push(updMode === 'standard' ? blindIndex.buildIndex(plainObj.title) : null);
      }
      const finalCols = [...Object.keys(passthrough), ...sensitivePatch.cols, ...extraCols];
      const finalVals = [...Object.values(passthrough), ...sensitivePatch.values, ...extraVals];
      const setClauses = finalCols.map((k, i) => `${k} = $${i + 1}`).join(', ');

      await client.query(
        `UPDATE tickets SET ${setClauses} WHERE id = $${finalCols.length + 1}`,
        [...finalVals, ticket.id]
      );

      const updResult = await client.query(`
        SELECT t.*,
          proj.name as project_name, proj.prefix as project_prefix,
          proj.has_external_vendor as project_has_external_vendor,
          sub.display_name as submitted_by_name,
          asgn.display_name as assigned_to_name,
          bt.internal_ref as blocking_ticket_ref, bt.title as blocking_ticket_title,
          bt.title_enc as blocking_ticket_title_enc, bt.internal_status as blocking_ticket_status
        FROM tickets t
        LEFT JOIN projects proj ON t.project_id = proj.id
        LEFT JOIN users sub ON t.submitted_by = sub.id
        LEFT JOIN users asgn ON t.assigned_to = asgn.id
        LEFT JOIN tickets bt ON t.blocked_by_ticket = bt.id
        WHERE t.id = $1
      `, [ticket.id]);

      const row = updResult.rows[0];
      await decryptRow('tickets', row, { aliases: TICKET_JOIN_ALIASES });
      return row;
    });

    res.json(updated);

    // Fire notifications async (don't block response)
    if (body.internal_status && body.internal_status !== ticket.internal_status) {
      notifyStatusChange(pool, {
        ticket: updated,
        oldStatus: ticket.internal_status,
        newStatus: body.internal_status,
        actorId: user.id,
      }).catch(() => {});
      if (body.internal_status === 'Pending Review') {
        notifyPendingReview(pool, { ticket: updated, actorId: user.id }).catch(() => {});
      }
      // Vendor-bound: 'Closed' uses the ticket_resolved template, every
      // other transition uses status_change. The template renderer
      // falls back to the next-best match if the specific event has
      // no template configured.
      const event = body.internal_status === 'Closed' ? 'ticket_resolved' : 'status_change';
      sendVendorEmail({ eventType: event, ticketId: ticket.id, actorId: user.id })
        .catch(err => console.error('vendor outbound failed:', err.message));
    }
    // external_status → Resolved sets internal_status to Pending Review
    if (body.external_status === 'Resolved' && ticket.internal_status !== 'Pending Review') {
      notifyPendingReview(pool, { ticket: updated, actorId: user.id }).catch(() => {});
    }
    // Email the assignee when assigned_to changes to a new non-null user.
    if (
      body.assigned_to !== undefined &&
      updated.assigned_to &&
      updated.assigned_to !== ticket.assigned_to
    ) {
      notifyAssignment(pool, {
        ticket: updated,
        assigneeId: updated.assigned_to,
        actorId: user.id,
        actorName: user.displayName,
      }).catch(err => console.error('notifyAssignment failed:', err.message));
    }
  } catch (err) {
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/tickets/:id/followup — schedule (or update) a follow-up
// reminder N days from now. Admin/Manager only. Only meaningful while
// ticket sits in a resolved_pending_close state; cleared automatically
// on status change. DELETE clears it.
router.post('/:id/followup', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const days = Math.max(1, Math.floor(Number(req.body?.days || 0)));
    if (!days || !Number.isFinite(days)) return res.status(400).json({ error: 'days must be a positive integer' });
    const r = await pool.query(`
      UPDATE tickets SET followup_at = NOW() + ($1 || ' days')::interval,
                         followup_user_id = $2,
                         updated_at = NOW()
       WHERE id = $3
       RETURNING followup_at, followup_user_id
    `, [days, req.session.user.id, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Ticket not found' });
    await pool.query(
      `INSERT INTO audit_log (ticket_id, user_id, action, note)
       VALUES ($1, $2, 'followup_scheduled', $3)`,
      [req.params.id, req.session.user.id, `Follow-up reminder in ${days} day(s)`]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error('followup schedule error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.delete('/:id/followup', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    await pool.query(
      `UPDATE tickets SET followup_at = NULL, followup_user_id = NULL, updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
    await pool.query(
      `INSERT INTO audit_log (ticket_id, user_id, action, note)
       VALUES ($1, $2, 'followup_cancelled', 'Follow-up reminder cancelled')`,
      [req.params.id, req.session.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('followup cancel error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/tickets/:id/move — relocate a ticket to a different project.
// Re-issues internal_ref from the target project's counter (old ref kept
// in audit log). Detaches vendor contacts (vendor scope = project).
// Auth: Admin/Manager any project; Submitter must be a member of BOTH
// the source and target projects.
router.post('/:id/move', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const targetProjectId = Number(req.body?.project_id);
    if (!Number.isInteger(targetProjectId) || targetProjectId <= 0) {
      return res.status(400).json({ error: 'project_id required' });
    }

    const t = await pool.query(
      `SELECT id, project_id, internal_ref FROM tickets WHERE id = $1`,
      [req.params.id]
    );
    if (!t.rows[0]) return res.status(404).json({ error: 'Ticket not found' });
    const ticket = t.rows[0];
    if (ticket.project_id === targetProjectId) {
      return res.status(400).json({ error: 'Ticket is already in that project' });
    }

    const targetProj = await pool.query(
      `SELECT id, name, prefix, status FROM projects WHERE id = $1`,
      [targetProjectId]
    );
    if (!targetProj.rows[0]) return res.status(404).json({ error: 'Target project not found' });
    if (targetProj.rows[0].status !== 'active') return res.status(400).json({ error: 'Target project is archived' });

    // Permission gate.
    const isPriv = ['Admin', 'Manager'].includes(user.role);
    if (!isPriv) {
      // Submitter (or other role) must belong to BOTH projects.
      const memberships = await pool.query(
        `SELECT project_id FROM project_members
          WHERE user_id = $1 AND project_id = ANY($2::int[])`,
        [user.id, [ticket.project_id, targetProjectId]]
      );
      const ids = new Set(memberships.rows.map(r => r.project_id));
      if (!ids.has(ticket.project_id) || !ids.has(targetProjectId)) {
        return res.status(403).json({ error: 'You must be a member of both the source and target projects' });
      }
    }

    const result = await transaction(async (client) => {
      const newRef = await nextInternalRef(client, targetProjectId);
      await client.query(
        `UPDATE tickets SET project_id = $1, internal_ref = $2, updated_at = NOW() WHERE id = $3`,
        [targetProjectId, newRef, ticket.id]
      );
      // Vendor contacts are project-scoped — drop them on move.
      const detached = await client.query(
        `DELETE FROM ticket_contacts WHERE ticket_id = $1 RETURNING contact_id`,
        [ticket.id]
      );
      await auditLog(client, {
        ticketId: ticket.id, userId: user.id,
        action: 'ticket_moved',
        oldValue: `${ticket.internal_ref} (project ${ticket.project_id})`,
        newValue: `${newRef} (project ${targetProjectId})`,
        note: `Moved to ${targetProj.rows[0].name}; ${detached.rowCount} contact(s) detached`,
      });
      await systemComment(
        client, ticket.id,
        `Ticket moved from project ID ${ticket.project_id} (was ${ticket.internal_ref}) to ${targetProj.rows[0].name} as ${newRef}.`
      );
      return { newRef, detachedCount: detached.rowCount };
    });

    res.json({
      ok: true,
      ticket_id: ticket.id,
      old_ref: ticket.internal_ref,
      new_ref: result.newRef,
      detached_contacts: result.detachedCount,
    });
  } catch (err) {
    console.error('move ticket error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/tickets/:id/notify-vendor — manually fire new_ticket vendor email
router.post('/:id/notify-vendor', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const ticket = await pool.query('SELECT id FROM tickets WHERE id = $1', [req.params.id]);
    if (!ticket.rows[0]) return res.status(404).json({ error: 'Ticket not found' });
    const result = await sendVendorEmail({ eventType: 'new_ticket', ticketId: Number(req.params.id), actorId: req.session.user.id });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send vendor notification' });
  }
});

// POST /api/tickets/:id/merge — Admin merges this ticket (loser) INTO
// the winner ticket (request body: { winner_id }). All comments,
// attachments, audit entries, vendor contacts, and followers are
// reassigned to the winner. Loser is closed with an audit row pointing
// at the winner; winner gets a "Merged in PROJECT-XX" audit row. Both
// tickets must exist in the same project.
router.post('/:id/merge', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const loserId = parseInt(req.params.id, 10);
    const winnerId = parseInt(req.body?.winner_id, 10);
    if (!winnerId || winnerId === loserId) {
      return res.status(400).json({ error: 'winner_id required and distinct from loser' });
    }
    const merged = await transaction(async (client) => {
      const both = await client.query(
        `SELECT id, internal_ref, project_id, internal_status FROM tickets WHERE id = ANY($1::int[])`,
        [[loserId, winnerId]]
      );
      const loser  = both.rows.find(r => r.id === loserId);
      const winner = both.rows.find(r => r.id === winnerId);
      if (!loser || !winner) throw Object.assign(new Error('Ticket not found'), { http: 404 });
      if (loser.project_id !== winner.project_id) {
        throw Object.assign(new Error('Tickets must be in the same project'), { http: 400 });
      }

      // Reassign children. Followers and contacts use ON CONFLICT to
      // collapse duplicates that already exist on the winner.
      await client.query(`UPDATE comments      SET ticket_id = $1 WHERE ticket_id = $2`, [winnerId, loserId]);
      await client.query(`UPDATE attachments   SET ticket_id = $1 WHERE ticket_id = $2`, [winnerId, loserId]);
      await client.query(`UPDATE audit_log     SET ticket_id = $1 WHERE ticket_id = $2`, [winnerId, loserId]);
      await client.query(`
        INSERT INTO ticket_followers (ticket_id, user_id, created_at)
          SELECT $1, user_id, created_at FROM ticket_followers WHERE ticket_id = $2
          ON CONFLICT DO NOTHING
      `, [winnerId, loserId]);
      await client.query(`DELETE FROM ticket_followers WHERE ticket_id = $1`, [loserId]);
      await client.query(`
        INSERT INTO ticket_contacts (ticket_id, contact_id, added_by_user_id, added_at)
          SELECT $1, contact_id, added_by_user_id, added_at FROM ticket_contacts WHERE ticket_id = $2
          ON CONFLICT DO NOTHING
      `, [winnerId, loserId]);
      await client.query(`DELETE FROM ticket_contacts WHERE ticket_id = $1`, [loserId]);

      // Audit on both sides so the timeline records the operation. The
      // loser's audit was reassigned above, but a final entry on the
      // loser still helps if anyone visits its row directly via SQL.
      await client.query(
        `INSERT INTO audit_log (ticket_id, user_id, action, new_value, note)
         VALUES ($1, $2, 'merged_in', $3, $4)`,
        [winnerId, req.session.user.id, loser.internal_ref, `Merged in ${loser.internal_ref}`]
      );
      await client.query(
        `INSERT INTO audit_log (ticket_id, user_id, action, new_value, note)
         VALUES ($1, $2, 'merged_into', $3, $4)`,
        [loserId, req.session.user.id, winner.internal_ref, `Merged into ${winner.internal_ref}`]
      );

      // Close the loser. Plaintext title intentionally untouched so the
      // operation is reversible by manual SQL if absolutely necessary —
      // a "Merged into PROJECT-XX" annotation lives in audit only.
      await client.query(
        `UPDATE tickets SET internal_status = 'Closed', updated_at = NOW() WHERE id = $1`,
        [loserId]
      );
      // Bump winner's updated_at so it sorts to the top.
      await client.query(`UPDATE tickets SET updated_at = NOW() WHERE id = $1`, [winnerId]);

      return { winner_ref: winner.internal_ref, loser_ref: loser.internal_ref };
    });
    res.json({ ok: true, ...merged });
  } catch (err) {
    console.error(err);
    res.status(err.http || 500).json({ error: err.message || 'Database error' });
  }
});

// DELETE /api/tickets/:id
router.delete('/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM tickets WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Ticket not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/tickets/:id/contacts — vendor contacts on a ticket
router.get('/:id/contacts', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*, co.id AS company_id, co.name AS company_name, co.name_enc AS company_name_enc,
             co.domain AS company_domain
        FROM ticket_contacts tc
        JOIN contacts c ON c.id = tc.contact_id
        JOIN companies co ON co.id = c.company_id
       WHERE tc.ticket_id = $1
       ORDER BY tc.added_at ASC
    `, [req.params.id]);
    await decryptRows('contacts', result.rows, {
      aliases: { company_name: 'companies.name' },
    });
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/tickets/:id/contacts — link a contact to a ticket
router.post('/:id/contacts', requireAuth, requireRole('Admin', 'Manager', 'Submitter'), async (req, res) => {
  try {
    const { contact_id } = req.body || {};
    if (!contact_id) return res.status(400).json({ error: 'contact_id required' });
    const ticket = await pool.query(`SELECT id FROM tickets WHERE id = $1`, [req.params.id]);
    if (!ticket.rows[0]) return res.status(404).json({ error: 'Ticket not found' });
    const contact = await pool.query(
      `SELECT id FROM contacts WHERE id = $1 AND is_active = TRUE`,
      [Number(contact_id)]
    );
    if (!contact.rows[0]) return res.status(404).json({ error: 'Contact not found or inactive' });
    await pool.query(
      `INSERT INTO ticket_contacts (ticket_id, contact_id, added_by_user_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [Number(req.params.id), Number(contact_id), req.session.user.id]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/tickets/:id/contacts/:contactId — unlink a contact
router.delete('/:id/contacts/:contactId', requireAuth, requireRole('Admin', 'Manager', 'Submitter'),
  async (req, res) => {
    try {
      const result = await pool.query(
        `DELETE FROM ticket_contacts WHERE ticket_id = $1 AND contact_id = $2 RETURNING ticket_id`,
        [req.params.id, req.params.contactId]
      );
      if (!result.rows[0]) return res.status(404).json({ error: 'Link not found' });
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database error' });
    }
  }
);

// GET /api/tickets/:id/audit
router.get('/:id/audit', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.*, u.display_name as user_name
      FROM audit_log a
      LEFT JOIN users u ON a.user_id = u.id
      WHERE a.ticket_id = $1
      ORDER BY a.created_at ASC
    `, [req.params.id]);
    await decryptRows('audit_log', result.rows);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

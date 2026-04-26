const express = require('express');
const { pool, transaction } = require('../db/pool');
const { nextMotRef, computePriority } = require('../db/schema');
const { requireAuth, requireRole } = require('../middleware/auth');
const { notifyStatusChange, notifyPendingReview, notifyNewComment } = require('../services/email');
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
            coastal_unacked:0, coastal_resolved:0, mot_blocker:0 });
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
        SUM(CASE WHEN coastal_status = 'Unacknowledged' AND internal_status != 'Closed' THEN 1 ELSE 0 END)::int as coastal_unacked,
        SUM(CASE WHEN coastal_status = 'Resolved' AND internal_status != 'Closed' THEN 1 ELSE 0 END)::int as coastal_resolved,
        SUM(CASE WHEN blocker_type = 'mot_input' AND internal_status != 'Closed' THEN 1 ELSE 0 END)::int as mot_blocker
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
      project_id, internal_status, coastal_status, effective_priority,
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
        where.push(`(t.title ILIKE $${p} OR t.mot_ref ILIKE $${p+1} OR t.description ILIKE $${p+2} OR t.coastal_ticket_ref ILIKE $${p+3})`);
        params.push(term, term, term, term);
        p += 4;
      } else {
        const tokenHashes = blindIndex.hashQuery(q);
        const titleClause = tokenHashes.length
          ? `t.title_blind_idx && $${p++}::text[]`
          : null;
        if (tokenHashes.length) params.push(tokenHashes);
        const refClauses = [`t.mot_ref ILIKE $${p++}`, `t.coastal_ticket_ref ILIKE $${p++}`];
        params.push(term, term);
        const clauses = titleClause ? [titleClause, ...refClauses] : refClauses;
        where.push(`(${clauses.join(' OR ')})`);
        postFilterTerm = q.trim().toLowerCase();
      }
    }
    if (internal_status) { where.push(`t.internal_status = $${p++}`); params.push(internal_status); }
    if (coastal_status) { where.push(`t.coastal_status = $${p++}`); params.push(coastal_status); }
    if (effective_priority) { where.push(`t.effective_priority = $${p++}`); params.push(Number(effective_priority)); }
    if (blocker_type) { where.push(`t.blocker_type = $${p++}`); params.push(blocker_type); }
    if (assigned_to) { where.push(`t.assigned_to = $${p++}`); params.push(Number(assigned_to)); }
    if (flagged_for_review !== undefined && flagged_for_review !== '') {
      where.push(`t.flagged_for_review = $${p++}`);
      params.push(flagged_for_review === 'true');
    }
    if (exclude_closed === '1') { where.push(`t.internal_status != 'Closed'`); }

    const allowed_sorts = ['created_at', 'updated_at', 'effective_priority', 'mot_ref'];
    const col = allowed_sorts.includes(sort_by) ? sort_by : 'updated_at';
    const dir = sort_dir === 'asc' ? 'ASC' : 'DESC';
    const offset = (Number(page) - 1) * Number(limit);
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const tickets = await pool.query(`
      SELECT t.*,
        proj.name as project_name, proj.prefix as project_prefix,
        sub.display_name as submitted_by_name,
        asgn.display_name as assigned_to_name,
        bt.mot_ref as blocking_ticket_ref,
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
        (r.mot_ref && r.mot_ref.toLowerCase().includes(postFilterTerm)) ||
        (r.coastal_ticket_ref && r.coastal_ticket_ref.toLowerCase().includes(postFilterTerm))
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
router.post('/', requireAuth, requireRole('Admin', 'Submitter'), async (req, res) => {
  try {
    const user = req.session.user;
    const { project_id, title, description, impact = 2, urgency = 2, coastal_ticket_ref, assigned_to } = req.body;

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

    const ticket = await transaction(async (client) => {
      const mot_ref = await nextMotRef(client, Number(project_id));

      const sensitivePatch = await buildWritePatch(client, 'tickets', {
        title,
        description: description || null,
      });
      const mode = await getMode(client);
      const baseCols = ['project_id', 'mot_ref', 'submitted_by', 'assigned_to',
        'impact', 'urgency', 'computed_priority', 'effective_priority', 'coastal_ticket_ref',
        'title_blind_idx'];
      const baseValues = [
        Number(project_id), mot_ref, user.id,
        assigned_to ? Number(assigned_to) : null,
        imp, urg, computed, computed,
        coastal_ticket_ref || null,
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
      await auditLog(client, { ticketId: t.id, userId: user.id, action: 'ticket_created', newValue: mot_ref });
      // Auto-follow: submitter watches their own ticket
      await client.query(
        'INSERT INTO ticket_followers (ticket_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [t.id, user.id]
      );
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
          t.id, t.mot_ref, t.title, t.internal_status, t.effective_priority,
          t.description, t.coastal_ticket_ref,
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
          OR ($2 <> '' AND t.coastal_ticket_ref IS NOT NULL AND t.coastal_ticket_ref = $2)
        )
        ${whereClause}
        ORDER BY t.id, rank DESC
        LIMIT 5
      `, params);
    } else {
      // External-ref exact match only.
      if (!extRef) return res.json([]);
      result = await pool.query(`
        SELECT t.id, t.mot_ref, t.title, t.title_enc, t.internal_status, t.effective_priority,
          t.description, t.description_enc, t.coastal_ticket_ref,
          proj.name AS project_name, 0 AS rank
        FROM tickets t
        LEFT JOIN projects proj ON t.project_id = proj.id
        WHERE t.coastal_ticket_ref = $2
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
        bt.mot_ref as blocking_ticket_ref, bt.title as blocking_ticket_title, bt.title_enc as blocking_ticket_title_enc, bt.internal_status as blocking_ticket_status
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
        const old = ticket.internal_status;
        updates.internal_status = body.internal_status;
        await auditLog(client, { ticketId: ticket.id, userId: user.id, action: 'status_change', oldValue: old, newValue: body.internal_status });
        if (body.internal_status === 'Reopened') {
          await auditLog(client, { ticketId: ticket.id, userId: user.id, action: 'reopened', note: 'Ticket reopened' });
        }
      }

      if (isAdmin && body.coastal_status !== undefined) {
        const old = ticket.coastal_status;
        updates.coastal_status = body.coastal_status;
        updates.coastal_updated_at = new Date().toISOString();
        await auditLog(client, { ticketId: ticket.id, userId: user.id, action: 'coastal_status_update', oldValue: old, newValue: body.coastal_status });
        if (body.coastal_status === 'Resolved') {
          updates.internal_status = 'Pending Review';
          updates.flagged_for_review = true;
          await auditLog(client, { ticketId: ticket.id, userId: user.id, action: 'status_change', oldValue: ticket.internal_status, newValue: 'Pending Review', note: 'External partner marked resolved — flagged for review' });
          await systemComment(client, ticket.id, 'The external partner has marked this issue as Resolved. Please review and confirm the fix, then close or reopen this ticket.');
        }
      }

      if (isAdmin && body.coastal_ticket_ref !== undefined) updates.coastal_ticket_ref = body.coastal_ticket_ref;
      if (isAdmin && body.review_note !== undefined) updates.review_note = body.review_note;
      if (isAdmin && body.flagged_for_review !== undefined) updates.flagged_for_review = !!body.flagged_for_review;

      if (isAdmin && body.blocker_type !== undefined) {
        const oldBlocker = ticket.blocker_type;
        updates.blocker_type = body.blocker_type || null;
        if (body.blocker_type === 'internal') {
          updates.blocked_by_ticket = body.blocked_by_ticket ? Number(body.blocked_by_ticket) : null;
          updates.mot_blocker_note = null;
        } else if (body.blocker_type === 'mot_input') {
          updates.mot_blocker_note = body.mot_blocker_note || null;
          updates.blocked_by_ticket = null;
          if (ticket.internal_status !== 'Awaiting Input') {
            updates.internal_status = 'Awaiting Input';
            await auditLog(client, { ticketId: ticket.id, userId: user.id, action: 'status_change', oldValue: ticket.internal_status, newValue: 'Awaiting Input', note: 'Blocker set: team input required' });
          }
        } else if (!body.blocker_type) {
          updates.blocked_by_ticket = null;
          updates.mot_blocker_note = null;
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
      const SENSITIVE = new Set(['title', 'description', 'review_note', 'mot_blocker_note']);
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
          sub.display_name as submitted_by_name,
          asgn.display_name as assigned_to_name,
          bt.mot_ref as blocking_ticket_ref, bt.title as blocking_ticket_title,
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
    // coastal_status → Resolved sets internal_status to Pending Review
    if (body.coastal_status === 'Resolved' && ticket.internal_status !== 'Pending Review') {
      notifyPendingReview(pool, { ticket: updated, actorId: user.id }).catch(() => {});
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
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

// Vendor support channels (see services/vendorSupport.js).
//
//   GET    /api/companies/:id/support                 channels + settings (Admin, Manager, Tech)
//   PUT    /api/companies/:id/support/settings        auto-note + match conditions (Admin, Manager)
//   POST   /api/companies/:id/support/channels        add a channel (Admin, Manager)
//   PATCH  /api/vendor-support/channels/:channelId    edit (Admin, Manager)
//   DELETE /api/vendor-support/channels/:channelId    remove (Admin, Manager)
//   GET    /api/tickets/:ticketId/vendor-support      vendors + recommended channels for a ticket (agents)
//   POST   /api/tickets/:ticketId/vendor-support/forward  { channel_id, message } email the ticket to a
//                                                     vendor's support address (agents)
//
// Mounted at /api, so every route names its own middleware (no router.use).

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { decryptRows, buildWritePatch } = require('../services/fields');
const { isBasicallyValidEmail } = require('../services/genericMailbox');
const vendorSupport = require('../services/vendorSupport');
const { auditLog } = require('../services/ticketHelpers');

const router = express.Router();
const AGENTS = ['Admin', 'Manager', 'Tech'];
const EDITORS = ['Admin', 'Manager'];
const KINDS = ['email', 'portal', 'phone'];

const intId = (v) => (/^\d+$/.test(String(v)) ? Number(v) : null);

async function vendorCompany(id) {
  const r = await pool.query(`SELECT id, kind FROM companies WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

// Cleans a channel body. Returns [fields, error]. `partial` for PATCH.
function cleanChannel(b, { partial = false, current = null } = {}) {
  const out = {};
  const kind = b.kind !== undefined ? b.kind : current?.kind;
  if (!partial || b.kind !== undefined) {
    if (!KINDS.includes(kind)) return [null, 'kind must be email, portal or phone'];
    out.kind = kind;
  }
  if (!partial || b.value !== undefined || b.kind !== undefined) {
    const v = String(b.value ?? current?.value ?? '').trim();
    if (!v) return [null, kind === 'email' ? 'email address is required' : kind === 'portal' ? 'portal link is required' : 'phone number is required'];
    if (v.length > 500) return [null, 'value is too long'];
    if (kind === 'email' && !isBasicallyValidEmail(v)) return [null, `"${v}" isn't an email address`];
    if (kind === 'portal') {
      let u;
      try { u = new URL(v); } catch { return [null, 'portal link must be a full https:// address']; }
      if (!/^https?:$/.test(u.protocol)) return [null, 'portal link must start with https://'];
    }
    if (kind === 'phone' && !/^[0-9+().\-\s#*,xX]{3,40}$/.test(v)) return [null, `"${v}" isn't a phone number`];
    out.value = kind === 'email' ? v.toLowerCase() : v;
  }
  if (b.label !== undefined) out.label = String(b.label || '').trim().slice(0, 80) || null;
  if (b.notes !== undefined) out.notes = String(b.notes || '').trim().slice(0, 4000) || null;
  for (const k of ['min_priority', 'max_priority']) {
    if (b[k] === undefined) continue;
    const n = Number(b[k]);
    if (!Number.isInteger(n) || n < 1 || n > 5) return [null, `${k.replace('_', ' ')} must be 1-5`];
    out[k] = n;
  }
  const min = out.min_priority ?? current?.min_priority ?? 1;
  const max = out.max_priority ?? current?.max_priority ?? 5;
  if (min > max) return [null, 'priority range is backwards (P1 is the highest)'];
  if (b.enabled !== undefined) out.enabled = !!b.enabled;
  if (b.sort_order !== undefined && Number.isInteger(Number(b.sort_order))) out.sort_order = Number(b.sort_order);
  return [out];
}

// ── Company side ────────────────────────────────────────────────────────

router.get('/companies/:id/support', requireAuth, requireRole(...AGENTS), async (req, res) => {
  try {
    const id = intId(req.params.id);
    const c = id && await vendorCompany(id);
    if (!c) return res.status(404).json({ error: 'Company not found' });
    const [ch, st, pr, fields] = await Promise.all([
      pool.query(`SELECT * FROM vendor_support_channels WHERE company_id = $1 ORDER BY sort_order, id`, [id]),
      pool.query(`SELECT auto_note, match_regex, match_field_slug, match_field_values FROM vendor_support_settings WHERE company_id = $1`, [id]),
      pool.query(
        `SELECT p.id, p.name, p.prefix, (c.project_id = p.id) AS is_home
           FROM projects p JOIN companies c ON c.id = $1
          WHERE p.id = c.project_id OR EXISTS (SELECT 1 FROM company_projects cp WHERE cp.company_id = $1 AND cp.project_id = p.id)
          ORDER BY is_home DESC, p.name`, [id]),
      pool.query(`SELECT slug, label, type, options FROM custom_field_defs WHERE entity_type = 'ticket' ORDER BY label`),
    ]);
    await decryptRows('vendor_support_channels', ch.rows);
    for (const r of ch.rows) delete r.notes_enc;
    res.json({
      channels: ch.rows,
      settings: st.rows[0] || { auto_note: true, match_regex: null, match_field_slug: null, match_field_values: null },
      projects: pr.rows,
      fields: fields.rows,
    });
  } catch (err) {
    console.error('vendor support get:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.put('/companies/:id/support/settings', requireAuth, requireRole(...EDITORS), async (req, res) => {
  try {
    const id = intId(req.params.id);
    const c = id && await vendorCompany(id);
    if (!c) return res.status(404).json({ error: 'Company not found' });
    if (c.kind !== 'vendor') return res.status(400).json({ error: 'Support channels are for vendor companies' });
    const b = req.body || {};
    const regex = String(b.match_regex || '').trim() || null;
    const rErr = vendorSupport.regexError(regex);
    if (rErr) return res.status(400).json({ error: rErr });
    const slug = String(b.match_field_slug || '').trim() || null;
    if (slug) {
      const f = await pool.query(`SELECT 1 FROM custom_field_defs WHERE entity_type = 'ticket' AND slug = $1`, [slug]);
      if (!f.rowCount) return res.status(400).json({ error: `No ticket form field "${slug}"` });
    }
    const values = Array.isArray(b.match_field_values)
      ? b.match_field_values.map((v) => String(v).trim()).filter(Boolean).slice(0, 50)
      : String(b.match_field_values || '').split(',').map((v) => v.trim()).filter(Boolean).slice(0, 50);
    const r = await pool.query(
      `INSERT INTO vendor_support_settings (company_id, auto_note, match_regex, match_field_slug, match_field_values, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (company_id) DO UPDATE SET auto_note = EXCLUDED.auto_note, match_regex = EXCLUDED.match_regex,
         match_field_slug = EXCLUDED.match_field_slug, match_field_values = EXCLUDED.match_field_values, updated_at = NOW()
       RETURNING auto_note, match_regex, match_field_slug, match_field_values`,
      [id, b.auto_note !== false, regex, slug, slug && values.length ? values : null]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error('vendor support settings:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

async function writeChannel(client, id, fields) {
  const patch = await buildWritePatch(client, 'vendor_support_channels', fields);
  if (id) {
    await client.query(
      `UPDATE vendor_support_channels SET ${patch.cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = NOW()
        WHERE id = $${patch.cols.length + 1}`, [...patch.values, id]);
    return id;
  }
  const r = await client.query(
    `INSERT INTO vendor_support_channels (${patch.cols.join(', ')}) VALUES (${patch.cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    patch.values);
  return r.rows[0].id;
}

async function readChannel(id) {
  const r = await pool.query(`SELECT * FROM vendor_support_channels WHERE id = $1`, [id]);
  await decryptRows('vendor_support_channels', r.rows);
  if (r.rows[0]) delete r.rows[0].notes_enc;
  return r.rows[0] || null;
}

router.post('/companies/:id/support/channels', requireAuth, requireRole(...EDITORS), async (req, res) => {
  try {
    const id = intId(req.params.id);
    const c = id && await vendorCompany(id);
    if (!c) return res.status(404).json({ error: 'Company not found' });
    if (c.kind !== 'vendor') return res.status(400).json({ error: 'Support channels are for vendor companies' });
    const [fields, err] = cleanChannel(req.body || {});
    if (err) return res.status(400).json({ error: err });
    const newId = await writeChannel(pool, null, { company_id: id, ...fields });
    res.status(201).json(await readChannel(newId));
  } catch (err) {
    console.error('vendor channel create:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.patch('/vendor-support/channels/:channelId', requireAuth, requireRole(...EDITORS), async (req, res) => {
  try {
    const id = intId(req.params.channelId);
    const cur = id && await readChannel(id);
    if (!cur) return res.status(404).json({ error: 'Channel not found' });
    const [fields, err] = cleanChannel(req.body || {}, { partial: true, current: cur });
    if (err) return res.status(400).json({ error: err });
    if (Object.keys(fields).length) await writeChannel(pool, id, fields);
    res.json(await readChannel(id));
  } catch (err) {
    console.error('vendor channel update:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.delete('/vendor-support/channels/:channelId', requireAuth, requireRole(...EDITORS), async (req, res) => {
  try {
    const id = intId(req.params.channelId);
    const r = id && await pool.query(`DELETE FROM vendor_support_channels WHERE id = $1 RETURNING id`, [id]);
    if (!r || !r.rowCount) return res.status(404).json({ error: 'Channel not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('vendor channel delete:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Ticket side (server.js guards /api/tickets/:ticketId with requireTicketVisible) ──

router.get('/tickets/:ticketId/vendor-support', requireAuth, requireRole(...AGENTS), async (req, res) => {
  try {
    const id = intId(req.params.ticketId);
    const ev = id && await vendorSupport.evaluateTicket(id);
    if (!ev) return res.status(404).json({ error: 'Ticket not found' });
    res.json({ priority: Number(ev.ticket.effective_priority) || 3, vendors: ev.vendors });
  } catch (err) {
    console.error('ticket vendor support:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.post('/tickets/:ticketId/vendor-support/forward', requireAuth, requireRole(...AGENTS), async (req, res) => {
  try {
    const ticketId = intId(req.params.ticketId);
    const channelId = intId(req.body?.channel_id);
    if (!ticketId || !channelId) return res.status(400).json({ error: 'channel_id is required' });
    const message = String(req.body?.message || '').slice(0, 10000);
    const ev = await vendorSupport.evaluateTicket(ticketId);
    if (!ev) return res.status(404).json({ error: 'Ticket not found' });
    const vendor = ev.vendors.find((v) => v.channels.some((c) => c.id === channelId));
    const channel = vendor?.channels.find((c) => c.id === channelId);
    if (!channel) return res.status(400).json({ error: "That channel isn't offered for this ticket" });
    if (channel.kind !== 'email') return res.status(400).json({ error: 'Only email channels can be forwarded to' });

    const { forwardToSupportAddress } = require('../services/vendorOutbound');
    let sent;
    try {
      sent = await forwardToSupportAddress({
        ticketId, actorId: req.session.user.id, to: channel.value, toName: channel.label,
        companyName: vendor.company.name, message,
      });
    } catch (e) {
      console.error('vendor forward send failed:', e.message);
      return res.status(502).json({ error: `Couldn't send: ${e.message}` });
    }
    const who = req.session.user.displayName || req.session.user.email || 'An agent';
    const body = `**Forwarded to ${vendor.company.name}** (${channel.value}) by ${who}`
      + (sent.attachments ? ` with ${sent.attachments} attachment${sent.attachments === 1 ? '' : 's'}` : '')
      + (message.trim() ? `\n\n> ${message.trim().split(/\r?\n/).join('\n> ')}` : '')
      + `\n\n_Their reply arrives in Admin → Inbound email unless it quotes the ticket ref ${ev.ticket.internal_ref || ''}. Record their ticket number in External ref._`;
    const patch = await buildWritePatch(pool, 'ticket_notes', { ticket_id: ticketId, user_id: req.session.user.id, body });
    await pool.query(
      `INSERT INTO ticket_notes (${patch.cols.join(', ')}) VALUES (${patch.cols.map((_, i) => `$${i + 1}`).join(', ')})`,
      patch.values);
    await auditLog(pool, {
      ticketId, userId: req.session.user.id, action: 'vendor_support_forwarded',
      newValue: channel.value, note: `Forwarded to ${vendor.company.name} support`,
    });
    res.json({ ok: true, to: channel.value, attachments: sent.attachments });
  } catch (err) {
    console.error('vendor forward:', err);
    res.status(500).json({ error: 'Forward failed' });
  }
});

module.exports = router;
module.exports._test = { cleanChannel };

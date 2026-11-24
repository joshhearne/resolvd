// Vendor support: which vendors' helpdesks a ticket could be escalated
// to, which of their channels (email / portal / phone) suit its priority,
// and the agent-only note that suggests them.
//
// A vendor applies to a ticket when the ticket's project is the vendor's
// project (companies.project_id) or one it has been allow-listed into
// (company_projects; how an MSP lets a vendor into a customer project).
// Its settings can narrow that further: a regex over title + description
// and / or a form field value. All conditions that are set must hold.
// Channels are recommended when the ticket's priority falls inside their
// P-range, e.g. phone for P1-P2, email or portal for P3-P5.

const { pool } = require('../db/pool');
const { decryptRow, decryptRows, buildWritePatch } = require('./fields');
const ticketCustomFields = require('./ticketCustomFields');

const REGEX_MAX = 300;
const TEXT_SCAN_MAX = 20000; // characters of title + description the regex sees

const KIND_LABEL = { phone: 'Call', portal: 'Portal', email: 'Email' };

// Returns an error message, or null when the pattern compiles.
function regexError(pattern) {
  if (pattern == null || pattern === '') return null;
  if (typeof pattern !== 'string') return 'match pattern must be text';
  if (pattern.length > REGEX_MAX) return `match pattern must be at most ${REGEX_MAX} characters`;
  try { new RegExp(pattern, 'i'); } catch (e) { return `match pattern isn't a valid regular expression: ${e.message}`; }
  return null;
}

function fieldMatches(values, slug, wanted) {
  if (!slug) return true;
  const f = values.find((v) => v.slug === slug);
  if (!f || f.value == null || f.value === '') return false;
  const want = (wanted || []).map((w) => String(w).trim().toLowerCase()).filter(Boolean);
  const have = Array.isArray(f.value) ? f.value : [f.value];
  const haveLc = have.map((h) => (typeof h === 'boolean' ? (h ? 'yes' : 'no') : String(h).trim().toLowerCase()));
  // No values listed = the field just has to be filled in.
  if (!want.length) return haveLc.some((h) => h && h !== 'no' && h !== 'false');
  return haveLc.some((h) => want.includes(h));
}

// { matched, reasons[] } for one vendor's settings against a ticket.
function evaluateConditions(settings, ticket, fieldValues) {
  const reasons = [];
  if (!settings) return { matched: true, reasons };
  if (settings.match_regex) {
    let re;
    try { re = new RegExp(settings.match_regex, 'i'); } catch { return { matched: false, reasons: ['match pattern is invalid'] }; }
    const text = `${ticket.title || ''}\n${ticket.description || ''}`.slice(0, TEXT_SCAN_MAX);
    if (!re.test(text)) return { matched: false, reasons: ['title / description don\'t match the pattern'] };
    reasons.push('title / description match the pattern');
  }
  if (settings.match_field_slug) {
    if (!fieldMatches(fieldValues, settings.match_field_slug, settings.match_field_values)) {
      return { matched: false, reasons: [`form field "${settings.match_field_slug}" doesn't match`] };
    }
    reasons.push(`form field "${settings.match_field_slug}" matches`);
  }
  return { matched: true, reasons };
}

const inRange = (c, p) => p >= c.min_priority && p <= c.max_priority;

async function loadTicket(client, ticketId) {
  const r = await client.query(
    `SELECT id, internal_ref, project_id, title, title_enc, description, description_enc, effective_priority
       FROM tickets WHERE id = $1`, [ticketId]);
  const t = r.rows[0];
  if (t) await decryptRow('tickets', t);
  return t || null;
}

// Every vendor for the ticket's project with its channels, settings and
// whether the ticket matches. Disabled channels are left out.
async function evaluateTicket(ticketId, { client = pool } = {}) {
  const t = await loadTicket(client, ticketId);
  if (!t) return null;
  const v = await client.query(
    `SELECT c.id, c.name, c.name_enc, c.domain,
            s.auto_note, s.match_regex, s.match_field_slug, s.match_field_values
       FROM companies c
       LEFT JOIN vendor_support_settings s ON s.company_id = c.id
      WHERE c.kind = 'vendor' AND c.is_archived = FALSE
        AND (c.project_id = $1 OR EXISTS (
              SELECT 1 FROM company_projects cp WHERE cp.company_id = c.id AND cp.project_id = $1))`,
    [t.project_id]
  );
  if (!v.rows.length) return { ticket: t, vendors: [] };
  await decryptRows('companies', v.rows);
  const ch = await client.query(
    `SELECT * FROM vendor_support_channels WHERE company_id = ANY($1) AND enabled
      ORDER BY sort_order, id`, [v.rows.map((r) => r.id)]);
  await decryptRows('vendor_support_channels', ch.rows);
  const needFields = v.rows.some((r) => r.match_field_slug);
  const fieldValues = needFields ? await ticketCustomFields.readValues(client, t.id, { reveal: true }) : [];
  const p = Number(t.effective_priority) || 3;

  const vendors = v.rows.map((r) => {
    const settings = r.match_regex || r.match_field_slug || r.auto_note != null ? r : null;
    const { matched, reasons } = evaluateConditions(settings, t, fieldValues);
    const channels = ch.rows.filter((c) => c.company_id === r.id).map((c) => ({
      id: c.id, kind: c.kind, label: c.label, value: c.value, notes: c.notes,
      min_priority: c.min_priority, max_priority: c.max_priority, recommended: inRange(c, p),
    }));
    return {
      company: { id: r.id, name: r.name },
      auto_note: r.auto_note !== false,
      has_conditions: !!(r.match_regex || r.match_field_slug),
      matched, reasons, channels,
    };
  }).filter((x) => x.channels.length);
  vendors.sort((a, b) => Number(b.matched) - Number(a.matched) || String(a.company.name).localeCompare(String(b.company.name)));
  return { ticket: t, vendors };
}

function channelLine(c) {
  const name = c.label ? `${c.label}: ` : '';
  const value = c.kind === 'portal' ? `<${c.value}>` : c.value;
  const range = c.min_priority === c.max_priority ? `P${c.min_priority}` : `P${c.min_priority}-P${c.max_priority}`;
  let line = `- **${KIND_LABEL[c.kind]}** ${name}${value} _(${range})_`;
  if (c.notes) line += '\n' + c.notes.split(/\r?\n/).map((l) => `  > ${l}`).join('\n');
  return line;
}

function noteBody(vendor, priority, reason) {
  const rec = vendor.channels.filter((c) => c.recommended);
  const other = vendor.channels.filter((c) => !c.recommended);
  const head = reason === 'priority'
    ? `**Vendor support: ${vendor.company.name}** (priority now P${priority})`
    : `**Vendor support: ${vendor.company.name}** (P${priority})`;
  const lines = [head, '', 'Recommended for this priority:', ...rec.map(channelLine)];
  if (other.length) {
    lines.push('', `Other options: ${other.map((c) => `${KIND_LABEL[c.kind].toLowerCase()} ${c.kind === 'portal' ? `<${c.value}>` : c.value}`).join(' · ')}`);
  }
  lines.push('', '_Open the ticket\'s Vendor support tab to forward the ticket by email or call. Only agents see this note._');
  return lines.join('\n');
}

// Adds an agent-only note per matching vendor (auto_note on) with its
// recommended channels. reason 'create' always notes; 'priority' only
// when the recommended set differs from the last note. Best-effort.
async function autoPrompt(ticketId, { reason = 'create' } = {}) {
  try {
    const ev = await evaluateTicket(ticketId);
    if (!ev || !ev.vendors.length) return 0;
    const p = Number(ev.ticket.effective_priority) || 3;
    let added = 0;
    for (const v of ev.vendors) {
      if (!v.matched || !v.auto_note) continue;
      const ids = v.channels.filter((c) => c.recommended).map((c) => c.id).sort((a, b) => a - b);
      const prev = (await pool.query(
        `SELECT channel_ids FROM ticket_vendor_prompts WHERE ticket_id = $1 AND company_id = $2`,
        [ticketId, v.company.id])).rows[0];
      // A ticket that didn't match when it was created stays quiet later.
      if (reason === 'priority' && !prev) continue;
      const prevIds = (prev?.channel_ids || []).slice().sort((a, b) => a - b);
      if (prev && prevIds.join(',') === ids.join(',')) continue;
      // Matched but nothing recommended at this priority: remember the
      // match (so raising the priority later can prompt) without a note.
      if (ids.length) {
        const patch = await buildWritePatch(pool, 'ticket_notes', { ticket_id: ticketId, user_id: null, body: noteBody(v, p, reason) });
        await pool.query(
          `INSERT INTO ticket_notes (${patch.cols.join(', ')}) VALUES (${patch.cols.map((_, i) => `$${i + 1}`).join(', ')})`,
          patch.values);
        added++;
      }
      await pool.query(
        `INSERT INTO ticket_vendor_prompts (ticket_id, company_id, channel_ids, priority) VALUES ($1, $2, $3, $4)
         ON CONFLICT (ticket_id, company_id) DO UPDATE SET channel_ids = EXCLUDED.channel_ids, priority = EXCLUDED.priority, created_at = NOW()`,
        [ticketId, v.company.id, ids, p]);
    }
    return added;
  } catch (err) {
    console.error(`vendor support prompt (ticket ${ticketId}) failed:`, err.message);
    return 0;
  }
}

module.exports = { evaluateTicket, autoPrompt, regexError, evaluateConditions, fieldMatches, noteBody, REGEX_MAX };

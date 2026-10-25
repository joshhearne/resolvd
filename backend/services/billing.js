// MSP billing — rate cards, bill types, contracts, ticket → customer
// resolution, pricing, approvals and the utilisation report. Postgres
// side of billingRules.js. Only surfaced when MSP mode (customer
// companies) is on; with it off nothing here is called by the UI.

const { pool } = require('../db/pool');
const { decryptRows } = require('./fields');
const { getBranding } = require('./branding');
const businessHours = require('./businessHours');
const tt = require('./timeTracking');
const br = require('./billingRules');

const bad = br.bad;
function httpError(status, message) {
  return Object.assign(new Error(message), { httpStatus: status });
}

async function isMspMode() {
  const b = await getBranding().catch(() => null);
  return b?.enable_customer_companies === true;
}

async function orgTz() {
  const b = await getBranding().catch(() => null);
  return b?.timezone || 'UTC';
}

// --- Rate cards ---------------------------------------------------------

async function listRateCards({ includeInactive = true } = {}) {
  const cards = (await pool.query(
    `SELECT * FROM rate_cards ${includeInactive ? '' : 'WHERE active'} ORDER BY is_default DESC, lower(name)`
  )).rows;
  const rates = (await pool.query(
    `SELECT r.*, wt.name AS work_type_name, u.display_name AS user_name, u.email AS user_email
       FROM rate_card_rates r
  LEFT JOIN time_work_types wt ON wt.id = r.work_type_id
  LEFT JOIN users u ON u.id = r.user_id
      ORDER BY r.rate_card_id, wt.name NULLS FIRST, u.display_name NULLS FIRST`
  )).rows;
  for (const c of cards) c.rates = rates.filter((r) => r.rate_card_id === c.id);
  return cards;
}

function cleanCard(body, partial) {
  const out = {};
  if (body.name !== undefined || !partial) {
    const name = String(body.name || '').trim();
    if (!name) bad('Name is required');
    if (name.length > 80) bad('Name is too long');
    out.name = name;
  }
  if (body.hourly_rate !== undefined || !partial) out.hourly_rate = br.money(body.hourly_rate ?? 0, 'Hourly rate');
  if (body.after_hours_multiplier !== undefined) out.after_hours_multiplier = br.multiplier(body.after_hours_multiplier, 'After-hours multiplier');
  if (body.weekend_multiplier !== undefined) out.weekend_multiplier = br.multiplier(body.weekend_multiplier, 'Weekend multiplier');
  for (const k of ['is_default', 'active']) {
    if (body[k] !== undefined) {
      if (typeof body[k] !== 'boolean') bad(`${k} must be true or false`);
      out[k] = body[k];
    }
  }
  return out;
}

async function writeCard(id, body) {
  const v = cleanCard(body || {}, id != null);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (v.is_default) await client.query('UPDATE rate_cards SET is_default = FALSE WHERE is_default');
    let row;
    if (id == null) {
      const cols = Object.keys(v);
      row = (await client.query(
        `INSERT INTO rate_cards (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
        cols.map((k) => v[k])
      )).rows[0];
      // First card becomes the default automatically.
      const n = (await client.query('SELECT COUNT(*)::int AS n FROM rate_cards WHERE is_default')).rows[0].n;
      if (!n) row = (await client.query('UPDATE rate_cards SET is_default = TRUE WHERE id = $1 RETURNING *', [row.id])).rows[0];
    } else {
      const keys = Object.keys(v);
      if (!keys.length) bad('Nothing to update');
      row = (await client.query(
        `UPDATE rate_cards SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1} RETURNING *`,
        [...keys.map((k) => v[k]), id]
      )).rows[0];
      if (!row) throw httpError(404, 'Rate card not found');
    }
    await client.query('COMMIT');
    return row;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function deleteRateCard(id) {
  const used = await pool.query('SELECT 1 FROM contracts WHERE rate_card_id = $1 LIMIT 1', [id]);
  if (used.rows[0]) {
    await pool.query('UPDATE rate_cards SET active = FALSE, is_default = FALSE WHERE id = $1', [id]);
    return { retired: true };
  }
  const r = await pool.query('DELETE FROM rate_cards WHERE id = $1', [id]);
  if (!r.rowCount) throw httpError(404, 'Rate card not found');
  return { deleted: true };
}

async function setRate(cardId, body) {
  const wt = body.work_type_id == null || body.work_type_id === '' ? null : Number(body.work_type_id);
  const u = body.user_id == null || body.user_id === '' ? null : Number(body.user_id);
  if (wt == null && u == null) bad('Pick a work type, a tech, or both');
  const rate = br.money(body.hourly_rate, 'Hourly rate');
  const r = await pool.query(
    `INSERT INTO rate_card_rates (rate_card_id, work_type_id, user_id, hourly_rate)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (rate_card_id, work_type_id, user_id) DO UPDATE SET hourly_rate = EXCLUDED.hourly_rate
     RETURNING *`,
    [cardId, wt, u, rate]
  );
  return r.rows[0];
}

async function deleteRate(cardId, rateId) {
  const r = await pool.query('DELETE FROM rate_card_rates WHERE id = $1 AND rate_card_id = $2', [rateId, cardId]);
  if (!r.rowCount) throw httpError(404, 'Rate not found');
  return { deleted: true };
}

// --- Bill types -----------------------------------------------------------

async function listBillingTypes({ includeInactive = true } = {}) {
  return (await pool.query(
    `SELECT * FROM billing_types ${includeInactive ? '' : 'WHERE active'} ORDER BY sort_order, lower(name)`
  )).rows;
}

function cleanBillingType(body, partial) {
  const out = {};
  if (body.name !== undefined || !partial) {
    const name = String(body.name || '').trim();
    if (!name) bad('Name is required');
    if (name.length > 80) bad('Name is too long');
    out.name = name;
  }
  if (body.behavior !== undefined || !partial) {
    if (!br.BEHAVIORS.includes(body.behavior)) bad(`Behaviour must be one of ${br.BEHAVIORS.join(', ')}`);
    out.behavior = body.behavior;
  }
  for (const k of ['external_code', 'description']) {
    if (body[k] !== undefined) {
      const v = body[k] == null ? null : String(body[k]).trim();
      if (v && v.length > (k === 'external_code' ? 100 : 500)) bad(`${k} is too long`);
      out[k] = v || null;
    }
  }
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') bad('active must be true or false');
    out.active = body.active;
  }
  if (body.sort_order !== undefined) {
    const n = Number(body.sort_order);
    if (!Number.isInteger(n)) bad('sort_order must be a whole number');
    out.sort_order = n;
  }
  return out;
}

async function writeBillingType(id, body) {
  const v = cleanBillingType(body || {}, id != null);
  const keys = Object.keys(v);
  if (!keys.length) bad('Nothing to update');
  if (id == null) {
    return (await pool.query(
      `INSERT INTO billing_types (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      keys.map((k) => v[k])
    )).rows[0];
  }
  const row = (await pool.query(
    `UPDATE billing_types SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1} RETURNING *`,
    [...keys.map((k) => v[k]), id]
  )).rows[0];
  if (!row) throw httpError(404, 'Bill type not found');
  return row;
}

async function deleteBillingType(id) {
  const used = await pool.query('SELECT 1 FROM contracts WHERE billing_type_id = $1 LIMIT 1', [id]);
  if (used.rows[0]) {
    await pool.query('UPDATE billing_types SET active = FALSE WHERE id = $1', [id]);
    return { retired: true };
  }
  const r = await pool.query('DELETE FROM billing_types WHERE id = $1', [id]);
  if (!r.rowCount) throw httpError(404, 'Bill type not found');
  return { deleted: true };
}

// --- Contracts --------------------------------------------------------------

async function loadContracts(companyIds) {
  if (!companyIds.length) return [];
  return (await pool.query(
    `SELECT c.*,
            -- Plain YYYY-MM-DD: a DATE parsed into a JS Date can shift a
            -- day when the server isn't on UTC.
            to_char(c.starts_on, 'YYYY-MM-DD') AS starts_on,
            to_char(c.ends_on, 'YYYY-MM-DD') AS ends_on,
            bt.name AS billing_type_name, bt.behavior, bt.external_code,
            rc.name AS rate_card_name
       FROM contracts c
       JOIN billing_types bt ON bt.id = c.billing_type_id
  LEFT JOIN rate_cards rc ON rc.id = c.rate_card_id
      WHERE c.company_id = ANY($1::int[])
      ORDER BY c.starts_on DESC, c.id DESC`,
    [companyIds]
  )).rows;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function cleanContract(body, existing) {
  const out = {};
  const partial = !!existing;
  if (body.name !== undefined || !partial) {
    const name = String(body.name || '').trim();
    if (!name) bad('Name is required');
    if (name.length > 120) bad('Name is too long');
    out.name = name;
  }
  if (body.billing_type_id !== undefined || !partial) {
    const bt = (await pool.query('SELECT * FROM billing_types WHERE id = $1', [Number(body.billing_type_id)])).rows[0];
    if (!bt) bad('Pick a bill type');
    if (!bt.active && Number(body.billing_type_id) !== existing?.billing_type_id) bad('That bill type is retired');
    out.billing_type_id = bt.id;
  }
  if (body.rate_card_id !== undefined) {
    if (body.rate_card_id == null || body.rate_card_id === '') out.rate_card_id = null;
    else {
      const rc = (await pool.query('SELECT id FROM rate_cards WHERE id = $1', [Number(body.rate_card_id)])).rows[0];
      if (!rc) bad('Rate card not found');
      out.rate_card_id = rc.id;
    }
  }
  for (const k of ['starts_on', 'ends_on']) {
    if (body[k] !== undefined) {
      if (body[k] == null || body[k] === '') {
        if (k === 'starts_on') bad('Start date is required');
        out[k] = null;
      } else {
        if (!DATE_RE.test(String(body[k]))) bad(`${k} must be YYYY-MM-DD`);
        out[k] = String(body[k]);
      }
    }
  }
  const start = out.starts_on ?? (existing ? br.toDay(existing.starts_on) : null);
  const end = out.ends_on !== undefined ? out.ends_on : (existing ? br.toDay(existing.ends_on) || null : null);
  if (start && end && end < start) bad('End date is before the start date');
  if (body.block_hours !== undefined) {
    if (body.block_hours == null || body.block_hours === '') out.block_hours = null;
    else {
      const n = Number(body.block_hours);
      if (!Number.isFinite(n) || n <= 0 || n > 10000) bad('Block hours must be above 0');
      out.block_hours = Math.round(n * 100) / 100;
    }
  }
  if (body.block_period !== undefined) {
    if (!['term', 'monthly'].includes(body.block_period)) bad('Block period must be term or monthly');
    out.block_period = body.block_period;
  }
  for (const k of ['external_ref', 'notes']) {
    if (body[k] !== undefined) {
      const v = body[k] == null ? null : String(body[k]).trim();
      if (v && v.length > (k === 'notes' ? 2000 : 200)) bad(`${k} is too long`);
      out[k] = v || null;
    }
  }
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') bad('active must be true or false');
    out.active = body.active;
  }
  // A prepaid block needs its hours.
  const btId = out.billing_type_id ?? existing?.billing_type_id;
  const bt = (await pool.query('SELECT behavior FROM billing_types WHERE id = $1', [btId])).rows[0];
  const hours = out.block_hours !== undefined ? out.block_hours : existing?.block_hours;
  if (bt?.behavior === 'prepaid_block' && !hours) bad('A prepaid block contract needs its block hours');
  return out;
}

async function listContracts(companyId) {
  const rows = await loadContracts([companyId]);
  const tz = await orgTz();
  for (const c of rows) {
    if (c.behavior === 'prepaid_block') c.block_usage = await blockUsage(c, tz);
  }
  return rows;
}

async function createContract(companyId, body) {
  const co = (await pool.query('SELECT id, kind FROM companies WHERE id = $1', [companyId])).rows[0];
  if (!co) throw httpError(404, 'Company not found');
  if (co.kind !== 'customer') bad('Contracts belong to customer companies');
  const v = await cleanContract(body || {}, null);
  const keys = ['company_id', ...Object.keys(v)];
  const vals = [companyId, ...Object.values(v)];
  const row = (await pool.query(
    `INSERT INTO contracts (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    vals
  )).rows[0];
  return (await loadContracts([companyId])).find((c) => c.id === row.id);
}

async function updateContract(companyId, id, body) {
  const existing = (await pool.query('SELECT * FROM contracts WHERE id = $1 AND company_id = $2', [id, companyId])).rows[0];
  if (!existing) throw httpError(404, 'Contract not found');
  const v = await cleanContract(body || {}, existing);
  const keys = Object.keys(v);
  if (!keys.length) bad('Nothing to update');
  await pool.query(
    `UPDATE contracts SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_at = NOW() WHERE id = $${keys.length + 1}`,
    [...keys.map((k) => v[k]), id]
  );
  return (await loadContracts([companyId])).find((c) => c.id === id);
}

async function deleteContract(companyId, id) {
  const r = await pool.query('DELETE FROM contracts WHERE id = $1 AND company_id = $2', [id, companyId]);
  if (!r.rowCount) throw httpError(404, 'Contract not found');
  return { deleted: true };
}

// --- Ticket → customer -----------------------------------------------------

// A ticket bills to tickets.billing_company_id when set, else to the one
// customer company its project is linked to. A project linked to several
// customers needs the ticket-level pick.
const CUSTOMER_SQL = `
  SELECT t.id AS ticket_id, t.project_id, t.billing_company_id,
         COALESCE(t.billing_company_id, sp.company_id) AS customer_id
    FROM tickets t
LEFT JOIN (
      SELECT cp.project_id, MIN(cp.company_id) AS company_id
        FROM company_projects cp
        JOIN companies c ON c.id = cp.company_id AND c.kind = 'customer'
       GROUP BY cp.project_id
      HAVING COUNT(*) = 1
    ) sp ON sp.project_id = t.project_id`;

async function ticketCustomers(ticketIds) {
  if (!ticketIds.length) return new Map();
  const r = await pool.query(`${CUSTOMER_SQL} WHERE t.id = ANY($1::int[])`, [ticketIds]);
  return new Map(r.rows.map((row) => [row.ticket_id, row]));
}

async function customerCandidates(ticketId) {
  const r = await pool.query(
    `SELECT c.id, c.name, c.name_enc
       FROM tickets t
       JOIN company_projects cp ON cp.project_id = t.project_id
       JOIN companies c ON c.id = cp.company_id AND c.kind = 'customer'
      WHERE t.id = $1
      ORDER BY c.id`,
    [ticketId]
  );
  await decryptRows('companies', r.rows);
  return r.rows.map((c) => ({ id: c.id, name: c.name }));
}

async function setTicketCustomer(ticketId, companyId) {
  if (companyId != null) {
    const co = (await pool.query("SELECT id FROM companies WHERE id = $1 AND kind = 'customer'", [companyId])).rows[0];
    if (!co) bad('Customer not found');
  }
  await pool.query('UPDATE tickets SET billing_company_id = $1 WHERE id = $2', [companyId, ticketId]);
}

// --- Pricing ------------------------------------------------------------------

async function loadEntries(ticketIds) {
  const r = await pool.query(
    `SELECT e.id, e.ticket_id, e.user_id, e.work_type_id, e.billable, e.started_at, e.ended_at,
            e.created_at, e.duration_minutes, e.billing_rules
       FROM time_entries e
      WHERE e.ticket_id = ANY($1::int[])
      ORDER BY e.created_at`,
    [ticketIds]
  );
  return r.rows;
}

// Block minutes a contract has used, per period, from its customer's
// time. Prices the customer's tickets since the contract started.
async function blockUsage(contract, tz) {
  const { blockUsed } = await priceCustomerSince(contract.company_id, br.toDay(contract.starts_on), tz);
  const used = blockUsed[contract.id] || {};
  const total = Math.round((Number(contract.block_hours) || 0) * 60);
  const currentKey = contract.block_period === 'monthly'
    ? require('./timeTrackingRules').localDay(new Date(), tz).slice(0, 7)
    : 'term';
  const settings = await tt.getSettings();
  const usedNow = used[currentKey] || 0;
  return {
    block_minutes: total,
    used_minutes: usedNow,
    period: currentKey,
    by_period: used,
    alert_percent: settings.billing_block_alert_percent,
    level: br.blockAlertLevel(usedNow, total, settings.billing_block_alert_percent),
  };
}

// Notify Admins/Managers when a prepaid block in force today crosses the
// alert threshold or is used up — once per contract, block period and
// level. `companyIds` narrows the sweep (e.g. to the customer whose time
// was just logged); omit to check every customer. MSP mode only.
async function checkBlockAlerts({ companyIds } = {}) {
  if (!await isMspMode()) return { sent: 0 };
  const tz = await orgTz();
  const params = [];
  let where = `bt.behavior = 'prepaid_block' AND c.active`;
  if (companyIds) {
    if (!companyIds.length) return { sent: 0 };
    params.push(companyIds);
    where += ' AND c.company_id = ANY($1::int[])';
  }
  const r = await pool.query(
    `SELECT DISTINCT c.company_id FROM contracts c JOIN billing_types bt ON bt.id = c.billing_type_id WHERE ${where}`,
    params
  );
  const { notifyManagersAndAdmins } = require('./notifications');
  let sent = 0;
  for (const { company_id: companyId } of r.rows) {
    const contract = br.contractOn(await loadContracts([companyId]), new Date(), tz);
    if (!contract || contract.behavior !== 'prepaid_block') continue;
    const usage = await blockUsage(contract, tz);
    if (!usage.level) continue;
    const levels = usage.level === 'exhausted' ? ['threshold', 'exhausted'] : ['threshold'];
    const co = await pool.query('SELECT name, name_enc FROM companies WHERE id = $1', [companyId]);
    await decryptRows('companies', co.rows);
    const name = co.rows[0]?.name || 'Customer';
    for (const level of levels) {
      const ins = await pool.query(
        `INSERT INTO contract_block_alerts (contract_id, period, level, used_minutes)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING contract_id`,
        [contract.id, usage.period, level, usage.used_minutes]
      );
      if (!ins.rowCount) continue;
      // Crossing both at once (one big entry): send only the stronger one.
      if (level === 'threshold' && levels.length === 2) continue;
      const hours = (m) => `${Math.round((m / 60) * 100) / 100} h`;
      const when = usage.period === 'term' ? 'for the contract term' : `for ${usage.period}`;
      await notifyManagersAndAdmins(pool, {
        type: 'contract_block_alert',
        title: level === 'exhausted'
          ? `${name}: prepaid block used up ${when}`
          : `${name}: prepaid block ${Math.round((usage.used_minutes / usage.block_minutes) * 100)}% used ${when}`,
        body: `${hours(usage.used_minutes)} of ${hours(usage.block_minutes)} used on "${contract.name}".${level === 'exhausted' ? ' Further time bills as overage.' : ''}`,
        data: { company_id: companyId, contract_id: contract.id },
      });
      sent += 1;
    }
  }
  return { sent };
}

const ALERT_TICK_MS = 30 * 60 * 1000;
let _alertInterval = null;
function startScheduler() {
  if (_alertInterval) return;
  const run = () => checkBlockAlerts().catch((e) => console.error('block alerts:', e.message));
  _alertInterval = setInterval(run, ALERT_TICK_MS);
  setTimeout(run, 60 * 1000);
}

// After time is logged on a ticket, check its customer's block now rather
// than waiting for the next sweep. Fire-and-forget.
function checkBlockAlertsForTicket(ticketId) {
  ticketCustomers([ticketId])
    .then((m) => {
      const id = m.get(ticketId)?.customer_id;
      return id ? checkBlockAlerts({ companyIds: [id] }) : null;
    })
    .catch((e) => console.error('block alerts (ticket):', e.message));
}

async function customerTicketIdsSince(companyId, sinceDay) {
  const r = await pool.query(
    `SELECT DISTINCT x.ticket_id FROM (${CUSTOMER_SQL}) x
       JOIN time_entries e ON e.ticket_id = x.ticket_id
      WHERE x.customer_id = $1 AND e.ended_at >= $2::date - interval '1 day'`,
    [companyId, sinceDay || '1970-01-01']
  );
  return r.rows.map((row) => row.ticket_id);
}

async function priceCustomerSince(companyId, sinceDay, tz) {
  const ids = await customerTicketIdsSince(companyId, sinceDay);
  return priceTickets(ids, { tz });
}

// Price a set of tickets together (so block draw-down is chronological
// across them). Returns per-entry lines, top-ups, per-ticket totals.
//
// A prepaid block is shared by all of a customer's tickets, so any
// customer with a block contract has its other tickets (since the
// earliest block start) priced alongside — that way the ticket view, the
// export and the report all draw the block down in the same order.
async function priceTickets(requestedIds, { tz } = {}) {
  const zone = tz || await orgTz();
  const out = { byEntry: {}, topUps: {}, byTicket: {}, blockUsed: {}, customers: {} };
  if (!requestedIds.length) return out;
  const settings = await tt.getSettings();
  let ticketIds = [...new Set(requestedIds)];
  let customers = await ticketCustomers(ticketIds);
  const companyIds = [...new Set([...customers.values()].map((c) => c.customer_id).filter(Boolean))];
  const contracts = await loadContracts(companyIds);
  const blockSince = {};
  for (const c of contracts) {
    if (c.behavior !== 'prepaid_block' || !c.active) continue;
    const d = br.toDay(c.starts_on);
    if (!blockSince[c.company_id] || d < blockSince[c.company_id]) blockSince[c.company_id] = d;
  }
  if (Object.keys(blockSince).length) {
    for (const [companyId, since] of Object.entries(blockSince)) {
      ticketIds.push(...await customerTicketIdsSince(Number(companyId), since));
    }
    ticketIds = [...new Set(ticketIds)];
    customers = await ticketCustomers(ticketIds);
  }
  const cards = await listRateCards();
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const defaultCard = cards.find((c) => c.is_default && c.active) || null;
  const projects = new Map();
  for (const c of customers.values()) {
    if (!projects.has(c.project_id)) projects.set(c.project_id, await businessHours.policyFor(null, c.project_id));
  }

  const entries = await loadEntries(ticketIds);
  const units = [];
  for (const id of ticketIds) {
    const cust = customers.get(id);
    const mine = entries.filter((e) => e.ticket_id === id);
    const { units: tu } = br.billableUnits(mine, settings, { tz: zone });
    for (const u of tu) {
      const custContracts = contracts.filter((c) => c.company_id === cust?.customer_id);
      const contract = br.contractOn(custContracts, u.at, zone);
      const card = (contract?.rate_card_id && cardById.get(contract.rate_card_id)) || defaultCard;
      u.ticket_id = id;
      u.ctx = {
        contract,
        behavior: contract?.behavior || 'hourly',
        card,
        rates: card?.rates || [],
        bh: projects.get(cust?.project_id) || null,
      };
      units.push(u);
    }
    out.customers[id] = cust?.customer_id || null;
  }
  const priced = br.priceUnits(units, { tz: zone });
  out.blockUsed = priced.blockUsed;
  for (const u of priced.units) {
    const line = {
      ticket_id: u.ticket_id,
      minutes: u.minutes,
      billable_minutes: u.billable_minutes,
      covered_minutes: u.covered_minutes,
      rate_cents: u.rate_cents,
      base_rate_cents: u.base_rate_cents,
      rate_source: u.rate_source,
      multiplier: u.multiplier,
      hours_class: u.hours_class,
      coverage: u.coverage,
      amount_cents: u.amount_cents,
      block_period: u.block_period || null,
      contract_id: u.ctx.contract?.id || null,
      contract_name: u.ctx.contract?.name || null,
      billing_type: u.ctx.contract?.billing_type_name || null,
      billing_type_code: u.ctx.contract?.external_code || null,
      contract_ref: u.ctx.contract?.external_ref || null,
      rate_card: u.ctx.card?.name || null,
    };
    if (u.kind === 'session') out.byEntry[u.entry.id] = line;
    else (out.topUps[u.ticket_id] = out.topUps[u.ticket_id] || []).push({ ...line, anchor_entry_id: u.entry.id, key: u.key });
  }
  for (const id of ticketIds) {
    const mine = priced.units.filter((u) => u.ticket_id === id);
    out.byTicket[id] = br.totals(mine);
  }
  return out;
}

// Pricing for one ticket's time log: customer, contract in force, and a
// line per entry (priceTickets handles prepaid-block sharing).
async function ticketBilling(ticketId) {
  const tz = await orgTz();
  const settings = await tt.getSettings();
  const cust = (await ticketCustomers([ticketId])).get(ticketId);
  const companyId = cust?.customer_id || null;
  let customer = null;
  if (companyId) {
    const r = await pool.query('SELECT id, name, name_enc FROM companies WHERE id = $1', [companyId]);
    await decryptRows('companies', r.rows);
    customer = r.rows[0] ? { id: r.rows[0].id, name: r.rows[0].name, source: cust.billing_company_id ? 'ticket' : 'project' } : null;
  }
  const contracts = companyId ? await loadContracts([companyId]) : [];
  const current = br.contractOn(contracts, new Date(), tz);
  const priced = await priceTickets([ticketId], { tz });
  return {
    currency: settings.billing_currency,
    require_approval: settings.billing_require_approval,
    customer,
    candidates: await customerCandidates(ticketId),
    contract: current ? {
      id: current.id, name: current.name, billing_type: current.billing_type_name,
      behavior: current.behavior, rate_card: current.rate_card_name,
      block_usage: current.behavior === 'prepaid_block' ? await blockUsage(current, tz) : null,
    } : null,
    lines: Object.fromEntries(Object.entries(priced.byEntry).filter(([, l]) => l.ticket_id === ticketId)),
    topups: priced.topUps[ticketId] || [],
    totals: priced.byTicket[ticketId] || br.totals([]),
  };
}

// --- Approval ---------------------------------------------------------------------

async function setApproval({ user, ticketId, entryIds, approve }) {
  const ids = (entryIds || []).map(Number).filter(Number.isInteger);
  const params = [ticketId];
  let where = 'ticket_id = $1';
  if (ids.length) { params.push(ids); where += ' AND id = ANY($2::int[])'; }
  const r = approve
    ? await pool.query(
      `UPDATE time_entries SET approved_at = NOW(), approved_by = $${params.length + 1}
        WHERE ${where} AND approved_at IS NULL AND invoiced_at IS NULL RETURNING id`,
      [...params, user.id]
    )
    : await pool.query(
      `UPDATE time_entries SET approved_at = NULL, approved_by = NULL
        WHERE ${where} AND invoiced_at IS NULL RETURNING id`,
      params
    );
  return { updated: r.rowCount };
}

// --- Approval queue ---------------------------------------------------------

// Billable entries awaiting approval (status 'pending') or already
// approved but not invoiced ('approved'), across all tickets, ending in
// [from, to); optional tech / customer filters. Each row carries its
// priced line so the approver sees what they're signing off.
async function approvalQueue({ from, to, status = 'pending', userId, companyId }) {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) bad('Give a valid from / to range');
  if (end - start > 366 * 86400000) bad('Range is limited to one year');
  const params = [start, end];
  const where = ['e.billable', 'e.invoiced_at IS NULL', 'e.ended_at >= $1', 'e.ended_at < $2'];
  where.push(status === 'approved' ? 'e.approved_at IS NOT NULL' : 'e.approved_at IS NULL');
  if (userId) { params.push(Number(userId)); where.push(`e.user_id = $${params.length}`); }
  if (companyId) { params.push(Number(companyId)); where.push(`x.customer_id = $${params.length}`); }
  const r = await pool.query(
    `SELECT e.id, e.ticket_id, e.user_id, e.started_at, e.ended_at, e.duration_minutes, e.note, e.note_enc,
            e.approved_at, wt.name AS work_type_name, u.display_name AS user_name, u.email AS user_email,
            t.internal_ref, t.title, t.title_enc, x.customer_id
       FROM time_entries e
       JOIN tickets t ON t.id = e.ticket_id
       JOIN (${CUSTOMER_SQL}) x ON x.ticket_id = e.ticket_id
  LEFT JOIN users u ON u.id = e.user_id
  LEFT JOIN time_work_types wt ON wt.id = e.work_type_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.started_at
      LIMIT 500`,
    params
  );
  await decryptRows('time_entries', r.rows);
  await decryptRows('tickets', r.rows);
  const priced = r.rows.length ? await priceTickets([...new Set(r.rows.map((e) => e.ticket_id))]) : { byEntry: {} };
  const custIds = [...new Set(r.rows.map((e) => e.customer_id).filter(Boolean))];
  let names = {};
  if (custIds.length) {
    const cr = await pool.query('SELECT id, name, name_enc FROM companies WHERE id = ANY($1::int[])', [custIds]);
    await decryptRows('companies', cr.rows);
    names = Object.fromEntries(cr.rows.map((c) => [c.id, c.name]));
  }
  const settings = await tt.getSettings();
  return {
    currency: settings.billing_currency,
    truncated: r.rows.length === 500,
    entries: r.rows.map((e) => {
      delete e.note_enc;
      delete e.title_enc;
      return { ...e, customer_name: names[e.customer_id] || null, line: priced.byEntry[e.id] || null };
    }),
  };
}

// Approve / un-approve any set of entries (across tickets).
async function bulkApproval({ user, entryIds, approve }) {
  const ids = (entryIds || []).map(Number).filter(Number.isInteger);
  if (!ids.length) bad('Pick at least one entry');
  if (ids.length > 500) bad('At most 500 entries at a time');
  const r = approve
    ? await pool.query(
      `UPDATE time_entries SET approved_at = NOW(), approved_by = $2
        WHERE id = ANY($1::int[]) AND billable AND approved_at IS NULL AND invoiced_at IS NULL RETURNING id`,
      [ids, user.id]
    )
    : await pool.query(
      `UPDATE time_entries SET approved_at = NULL, approved_by = NULL
        WHERE id = ANY($1::int[]) AND invoiced_at IS NULL RETURNING id`,
      [ids]
    );
  return { updated: r.rowCount };
}

// --- Utilisation report -------------------------------------------------------------

// Per tech over [from, to): logged, billable-flagged, non-billable,
// utilisation (billable ÷ logged), and — in MSP mode — billed amount.
async function utilisation({ from, to }) {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) bad('Give a valid from / to range');
  if (end - start > 366 * 86400000) bad('Range is limited to one year');
  const r = await pool.query(
    `SELECT e.id, e.ticket_id, e.user_id, e.billable, e.duration_minutes,
            u.display_name AS user_name, u.email AS user_email
       FROM time_entries e
  LEFT JOIN users u ON u.id = e.user_id
      WHERE e.ended_at >= $1 AND e.ended_at < $2`,
    [start, end]
  );
  const msp = await isMspMode();
  let byEntry = {};
  if (msp && r.rows.length) {
    const priced = await priceTickets([...new Set(r.rows.map((e) => e.ticket_id))]);
    byEntry = priced.byEntry;
  }
  const techs = new Map();
  for (const e of r.rows) {
    const key = e.user_id || 0;
    if (!techs.has(key)) {
      techs.set(key, {
        user_id: e.user_id, name: e.user_name || e.user_email || 'Unknown',
        entries: 0, logged_minutes: 0, billable_minutes: 0, non_billable_minutes: 0, amount_cents: 0,
      });
    }
    const t = techs.get(key);
    t.entries += 1;
    t.logged_minutes += e.duration_minutes;
    if (e.billable) t.billable_minutes += e.duration_minutes;
    else t.non_billable_minutes += e.duration_minutes;
    t.amount_cents += byEntry[e.id]?.amount_cents || 0;
  }
  const rows = [...techs.values()]
    .map((t) => ({ ...t, utilisation: t.logged_minutes ? Math.round((t.billable_minutes / t.logged_minutes) * 1000) / 10 : 0 }))
    .sort((a, b) => b.logged_minutes - a.logged_minutes);
  const settings = await tt.getSettings();
  return { msp, currency: settings.billing_currency, rows };
}

module.exports = {
  isMspMode,
  listRateCards,
  createRateCard: (body) => writeCard(null, body),
  updateRateCard: (id, body) => writeCard(id, body),
  deleteRateCard,
  setRate,
  deleteRate,
  listBillingTypes,
  createBillingType: (body) => writeBillingType(null, body),
  updateBillingType: (id, body) => writeBillingType(id, body),
  deleteBillingType,
  listContracts,
  createContract,
  updateContract,
  deleteContract,
  ticketBilling,
  setTicketCustomer,
  priceTickets,
  setApproval,
  approvalQueue,
  bulkApproval,
  utilisation,
  checkBlockAlerts,
  checkBlockAlertsForTicket,
  startScheduler,
};

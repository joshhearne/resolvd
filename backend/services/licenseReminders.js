// Software license renewal reminders. An hourly sweep tells Admins and
// Managers when a license renews or expires in 30 days, in 7 days, and
// once its renewal date has passed. Delivery goes through the
// notification matrix (event 'license_renewal'): in-app, push and email
// per each recipient's preferences. Email is sent straight away rather
// than through the digest, which groups by ticket.
//
// Each reminder is sent once per license, renewal date and stage
// (software_license_reminders). Only the most urgent stage due is sent,
// so a license added 5 days before renewal gets the 7-day reminder and
// not a late 30-day one. Moving the renewal date forward starts a new
// cycle. Licenses that lapsed more than LAPSED_WINDOW_DAYS ago are left
// alone, so turning this on doesn't flood inboxes with old renewals.

const { pool } = require('../db/pool');
const { getBranding } = require('./branding');
const { decryptRows } = require('./fields');

const STAGES = [
  { stage: 'd30', maxDays: 30 },
  { stage: 'd7', maxDays: 7 },
];
const LAPSED_WINDOW_DAYS = 30;
const TICK_MS = 60 * 60 * 1000;

function stageFor(days) {
  if (days < 0) return days >= -LAPSED_WINDOW_DAYS ? 'lapsed' : null;
  // Most urgent stage whose window the license is in.
  let hit = null;
  for (const s of STAGES) if (days <= s.maxDays) hit = s.stage;
  return hit;
}

function whenText(days) {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

// Title / body for one reminder. Exported for tests and the email renderer.
function describe({ name, days, auto_renew: autoRenew }) {
  if (days < 0) {
    const ago = -days === 1 ? 'yesterday' : `${-days} days ago`;
    return autoRenew
      ? { title: `License renewal date passed: ${name}`, lead: `${name} was due to auto-renew ${ago}. Update its renewal date to the new term.` }
      : { title: `License lapsed: ${name}`, lead: `${name} reached its renewal date ${ago} and isn't marked to renew automatically.` };
  }
  return autoRenew
    ? { title: `License auto-renews ${whenText(days)}: ${name}`, lead: `${name} renews automatically ${whenText(days)}.` }
    : { title: `License expires ${whenText(days)}: ${name}`, lead: `${name} expires ${whenText(days)} unless it's renewed.` };
}

async function orgToday() {
  let tz = 'UTC';
  try { tz = (await getBranding())?.timezone || 'UTC'; } catch { /* default UTC */ }
  try {
    const r = await pool.query(`SELECT (NOW() AT TIME ZONE $1)::date::text AS today`, [tz]);
    return r.rows[0].today;
  } catch {
    // Unknown zone name: fall back to the database's date.
    const r = await pool.query(`SELECT CURRENT_DATE::text AS today`);
    return r.rows[0].today;
  }
}

async function recipients() {
  const r = await pool.query(
    `SELECT id, email, display_name, preferences FROM users
      WHERE role IN ('Admin', 'Manager') AND status = 'active'`
  );
  return r.rows;
}

// One sweep. Returns { sent } (reminders, not individual deliveries).
async function checkRenewals() {
  const today = await orgToday();
  const due = await pool.query(
    `SELECT l.id, l.name, l.vendor, l.seats, l.company_id, l.auto_renew, l.software_key,
            to_char(l.renewal_date, 'YYYY-MM-DD') AS renewal_date,
            (l.renewal_date - $1::date) AS days
       FROM software_licenses l
      WHERE NOT l.archived
        AND l.renewal_date IS NOT NULL
        AND l.renewal_date BETWEEN $1::date - ${LAPSED_WINDOW_DAYS} AND $1::date + ${STAGES[0].maxDays}
      ORDER BY l.renewal_date, l.id`,
    [today]
  );
  if (!due.rows.length) { await heartbeat({ checked: 0, sent: 0, today }); return { sent: 0 }; }

  const companyIds = [...new Set(due.rows.map((l) => l.company_id).filter(Boolean))];
  const companyNames = {};
  if (companyIds.length) {
    const c = await pool.query('SELECT id, name, name_enc FROM companies WHERE id = ANY($1::int[])', [companyIds]);
    await decryptRows('companies', c.rows);
    for (const row of c.rows) companyNames[row.id] = row.name;
  }

  // Lazy require: notificationFanout pulls in email + push.
  const { dispatchPerRecipient, routeEmail } = require('./notificationFanout');
  let users = null;
  let sent = 0;
  for (const l of due.rows) {
    const days = Number(l.days);
    const stage = stageFor(days);
    if (!stage) continue;
    // Claim the reminder first so overlapping sweeps can't double-send.
    const claim = await pool.query(
      `INSERT INTO software_license_reminders (license_id, renewal_date, stage)
       VALUES ($1, $2::date, $3) ON CONFLICT DO NOTHING RETURNING license_id`,
      [l.id, l.renewal_date, stage]
    );
    if (!claim.rowCount) continue;

    users = users || await recipients();
    const { title, lead } = describe({ name: l.name, days, auto_renew: l.auto_renew });
    const link = days < 0 ? '/inventory/licenses?status=expired' : '/inventory/licenses?status=renewing';
    const companyName = l.company_id ? companyNames[l.company_id] || null : null;
    const bodyParts = [`Renewal date ${l.renewal_date}`];
    if (companyName) bodyParts.push(companyName);
    if (l.vendor) bodyParts.push(l.vendor);
    const payload = {
      license_id: l.id, name: l.name, vendor: l.vendor, company_name: companyName,
      renewal_date: l.renewal_date, days, stage, auto_renew: l.auto_renew, seats: l.seats, link, lead,
    };
    for (const user of users) {
      const matrix = await dispatchPerRecipient({
        user,
        eventType: 'license_renewal',
        ticketId: undefined,
        ticketRef: undefined,
        inApp: { title, body: bodyParts.join(' · '), extraData: { license_id: l.id, link, stage } },
        push: { title, body: lead, url: link, tag: `license-${l.id}-${stage}` },
        payload,
      });
      if (matrix.email) {
        await routeEmail({ user, eventType: 'license_renewal', payload, bypassDigest: true });
      }
    }
    sent += 1;
  }
  await heartbeat({ checked: due.rows.length, sent, today });
  return { sent };
}

async function heartbeat(metadata) {
  await pool.query(
    `UPDATE system_jobs SET last_run_at = NOW(), last_status = 'ok', metadata = $1::jsonb
      WHERE name = 'license_renewal_reminders'`,
    [JSON.stringify(metadata)]
  ).catch(() => {});
}

async function markError(err) {
  await pool.query(
    `UPDATE system_jobs SET last_run_at = NOW(), last_status = 'error', metadata = $1::jsonb
      WHERE name = 'license_renewal_reminders'`,
    [JSON.stringify({ error: String(err?.message || err).slice(0, 500) })]
  ).catch(() => {});
}

let _interval = null;
function startScheduler() {
  if (_interval) return;
  const run = () => checkRenewals().catch((e) => {
    console.error('license renewal reminders:', e.message);
    return markError(e);
  });
  _interval = setInterval(run, TICK_MS);
  setTimeout(run, 2 * 60 * 1000);
}

module.exports = { checkRenewals, startScheduler, stageFor, describe };

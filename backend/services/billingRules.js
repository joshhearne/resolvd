// Pure pricing engine for MSP billing. No DB access; services/billing.js
// loads the inputs.
//
// Pipeline, per customer:
//   1. billableUnits(): per ticket, turn logged entries into billable
//      units — each billable entry's session minutes (rounding / session
//      minimum) plus any ticket-minimum top-ups (timeTrackingRules).
//   2. priceUnits(): walk every unit in time order and price it under
//      the contract in force for it:
//        hourly        → minutes × rate
//        prepaid_block → minutes draw down the contract's hour block
//                        (per contract term, or per month); the rest is
//                        overage at the rate
//        covered       → counted, but $0 (managed / flat-fee customers)
//        non_billable  → not billable at all
//      The rate is the rate card's most specific match (tech + work
//      type → work type → tech → card base), times the card's
//      after-hours or weekend multiplier when the unit starts outside the
//      ticket's business hours.
//
// Money is integer cents throughout.

const tt = require('./timeTrackingRules');
const { holidayClosures } = require('./holidays');

const BEHAVIORS = ['hourly', 'prepaid_block', 'covered', 'non_billable'];
const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function toCents(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

// Most specific rate on a card for this entry. `rates` are the card's
// override rows: { work_type_id|null, user_id|null, hourly_rate }.
function resolveRate(card, rates, entry) {
  if (!card) return { cents: 0, source: 'none' };
  const list = rates || [];
  const pick = (wt, u) => list.find((r) => (r.work_type_id ?? null) === wt && (r.user_id ?? null) === u);
  const wt = entry.work_type_id ?? null;
  const u = entry.user_id ?? null;
  const hit =
    (wt != null && u != null && pick(wt, u) && { row: pick(wt, u), source: 'tech_work_type' }) ||
    (wt != null && pick(wt, null) && { row: pick(wt, null), source: 'work_type' }) ||
    (u != null && pick(null, u) && { row: pick(null, u), source: 'tech' }) ||
    null;
  if (hit) return { cents: toCents(hit.row.hourly_rate), source: hit.source };
  return { cents: toCents(card.hourly_rate), source: 'card' };
}

function wallParts(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz || 'UTC', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const out = {};
  for (const p of fmt.formatToParts(new Date(date))) {
    if (p.type === 'weekday') out.weekday = WEEKDAY[p.value];
    else if (p.type === 'hour') out.hour = Number(p.value) % 24;
    else if (p.type === 'minute') out.minute = Number(p.value);
    else if (p.type === 'year') out.year = Number(p.value);
    else if (p.type === 'month') out.month = Number(p.value);
    else if (p.type === 'day') out.day = Number(p.value);
  }
  return out;
}

// 'business' | 'after_hours' | 'weekend' for an instant. With a business-
// hours policy: a day outside its days, or a whole-day holiday, is
// weekend; outside its window (or after an early-close holiday's
// closes_at) is after-hours. Without one: Sat/Sun (in `tz`) are weekend, nothing is
// after-hours.
function hoursClass(date, bh, tz) {
  const zone = (bh && bh.enabled !== false && bh.tz) || tz || 'UTC';
  let p;
  try { p = wallParts(date, zone); } catch { p = wallParts(date, 'UTC'); }
  if (!bh || bh.enabled === false) return p.weekday === 0 || p.weekday === 6 ? 'weekend' : 'business';
  const days = Array.isArray(bh.days) ? bh.days.map(Number) : [1, 2, 3, 4, 5];
  if (!days.includes(p.weekday)) return 'weekend';
  const shut = holidayClosures(bh.holidays)(p.year, p.month, p.day);
  if (shut && !shut.closesAt) return 'weekend';
  const [sh, sm] = String(bh.start_time || '09:00').split(':').map(Number);
  const [eh, em] = String(bh.end_time || '17:00').split(':').map(Number);
  let end = eh * 60 + (em || 0);
  if (shut?.closesAt) {
    const [ch, cm] = shut.closesAt.split(':').map(Number);
    end = Math.min(end, ch * 60 + cm);
  }
  const mins = p.hour * 60 + p.minute;
  return mins >= sh * 60 + (sm || 0) && mins < end ? 'business' : 'after_hours';
}

function multiplierFor(card, cls) {
  if (!card) return 1;
  if (cls === 'weekend') return Number(card.weekend_multiplier) || 1;
  if (cls === 'after_hours') return Number(card.after_hours_multiplier) || 1;
  return 1;
}

// Step 1 for one ticket. `entries` in logged order. Returns units:
// { kind: 'session' | 'topup', entry (the entry, or the top-up's anchor),
//   at: Date, minutes }.
function billableUnits(entries, settings, { tz } = {}) {
  const b = tt.computeBillable(entries, settings, { tz });
  const byId = new Map(entries.map((e) => [e.id, e]));
  const units = [];
  for (const e of entries) {
    if (!e.billable || !b.perEntry[e.id]) continue;
    units.push({ kind: 'session', entry: e, at: new Date(e.started_at || e.created_at), minutes: b.perEntry[e.id] });
  }
  for (const t of b.topUps) {
    const anchor = byId.get(t.anchorId);
    units.push({ kind: 'topup', entry: anchor, at: new Date(anchor.started_at || anchor.created_at), minutes: t.minutes, key: t.key });
  }
  return { units, billable: b };
}

// Block period key for a unit: 'term' for a one-off block, or the unit's
// month (in tz) for a monthly block.
function blockKey(contract, at, tz) {
  if (contract.block_period === 'monthly') return tt.localDay(at, tz).slice(0, 7);
  return 'term';
}

// Step 2. `units` may span tickets; each carries `ctx`:
//   { contract|null, behavior, card|null, rates[], bh|null }
// `usedBefore` (optional): { [contractId]: { [periodKey]: minutes } } —
// block minutes already consumed by units not passed in. Mutated copy is
// returned as `blockUsed`.
function priceUnits(units, { tz, usedBefore = {} } = {}) {
  const used = JSON.parse(JSON.stringify(usedBefore));
  const sorted = [...units].sort((a, b) => a.at - b.at || (a.kind === 'topup') - (b.kind === 'topup'));
  for (const u of sorted) {
    const { contract, card, rates, bh } = u.ctx;
    const behavior = BEHAVIORS.includes(u.ctx.behavior) ? u.ctx.behavior : 'hourly';
    const rate = resolveRate(card, rates, u.entry);
    const cls = hoursClass(u.at, bh, tz);
    const mult = multiplierFor(card, cls);
    const rateCents = Math.round(rate.cents * mult);
    u.rate_cents = rateCents;
    u.base_rate_cents = rate.cents;
    u.rate_source = rate.source;
    u.hours_class = cls;
    u.multiplier = mult;
    u.covered_minutes = 0;
    if (behavior === 'non_billable') {
      u.coverage = 'non_billable';
      u.billable_minutes = 0;
      u.amount_cents = 0;
      continue;
    }
    u.billable_minutes = u.minutes;
    if (behavior === 'covered') {
      u.coverage = 'covered';
      u.covered_minutes = u.minutes;
      u.amount_cents = 0;
      continue;
    }
    let charged = u.minutes;
    if (behavior === 'prepaid_block' && contract) {
      const blockMinutes = Math.round((Number(contract.block_hours) || 0) * 60);
      const key = blockKey(contract, u.at, tz);
      used[contract.id] = used[contract.id] || {};
      const before = used[contract.id][key] || 0;
      const fromBlock = Math.max(0, Math.min(u.minutes, blockMinutes - before));
      used[contract.id][key] = before + fromBlock;
      u.covered_minutes = fromBlock;
      u.block_period = key;
      charged = u.minutes - fromBlock;
      u.coverage = fromBlock === u.minutes ? 'block' : fromBlock > 0 ? 'block_overage' : 'overage';
    } else {
      u.coverage = 'hourly';
    }
    u.amount_cents = Math.round((charged * rateCents) / 60);
  }
  return { units: sorted, blockUsed: used };
}

function totals(units) {
  const t = { billable_minutes: 0, covered_minutes: 0, charged_minutes: 0, amount_cents: 0, topup_minutes: 0 };
  for (const u of units) {
    t.billable_minutes += u.billable_minutes || 0;
    t.covered_minutes += u.covered_minutes || 0;
    t.charged_minutes += (u.billable_minutes || 0) - (u.covered_minutes || 0);
    t.amount_cents += u.amount_cents || 0;
    if (u.kind === 'topup') t.topup_minutes += u.billable_minutes || 0;
  }
  return t;
}

// Contract in force on a date: active, started, not ended; the latest
// start wins when terms overlap.
function contractOn(contracts, at, tz) {
  const day = tt.localDay(at, tz);
  return (contracts || [])
    .filter((c) => c.active !== false)
    .filter((c) => toDay(c.starts_on) <= day && (!c.ends_on || toDay(c.ends_on) >= day))
    .sort((a, b) => (toDay(b.starts_on) > toDay(a.starts_on) ? 1 : -1))[0] || null;
}

function toDay(v) {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

// How full a prepaid block is: null (fine), 'threshold' (at or past the
// alert percentage) or 'exhausted' (used up). A 0 percent threshold
// turns the early warning off; 'exhausted' still reports.
function blockAlertLevel(usedMinutes, blockMinutes, percent) {
  const total = Number(blockMinutes) || 0;
  if (total <= 0) return null;
  const used = Number(usedMinutes) || 0;
  if (used >= total) return 'exhausted';
  const pct = Number(percent) || 0;
  if (pct > 0 && used >= (total * pct) / 100) return 'threshold';
  return null;
}

// Validation helpers for the admin CRUD.
function bad(msg) { throw Object.assign(new Error(msg), { httpStatus: 400 }); }

function money(v, label) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100000) bad(`${label} must be between 0 and 100000`);
  return Math.round(n * 100) / 100;
}

function multiplier(v, label) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 10) bad(`${label} must be between 0 and 10`);
  return Math.round(n * 100) / 100;
}

module.exports = {
  BEHAVIORS,
  toCents,
  resolveRate,
  hoursClass,
  multiplierFor,
  billableUnits,
  priceUnits,
  totals,
  contractOn,
  blockAlertLevel,
  toDay,
  money,
  multiplier,
  bad,
};

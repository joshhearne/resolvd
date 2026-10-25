import { describe, it, expect } from 'vitest';
import br from '../services/billingRules.js';
import tt from '../services/timeTrackingRules.js';

const { resolveRate, hoursClass, billableUnits, priceUnits, totals, contractOn } = br;

const card = { id: 1, hourly_rate: '100.00', after_hours_multiplier: '1.5', weekend_multiplier: '2' };
const rates = [
  { work_type_id: 7, user_id: null, hourly_rate: '60.00' },     // Travel
  { work_type_id: null, user_id: 3, hourly_rate: '150.00' },    // senior tech
  { work_type_id: 7, user_id: 3, hourly_rate: '75.00' },        // senior tech travelling
];
const bh = { tz: 'America/Chicago', days: [1, 2, 3, 4, 5], start_time: '08:00', end_time: '17:00', enabled: true };

describe('resolveRate', () => {
  it('picks the most specific match', () => {
    expect(resolveRate(card, rates, { work_type_id: 7, user_id: 3 })).toEqual({ cents: 7500, source: 'tech_work_type' });
    expect(resolveRate(card, rates, { work_type_id: 7, user_id: 9 })).toEqual({ cents: 6000, source: 'work_type' });
    expect(resolveRate(card, rates, { work_type_id: 1, user_id: 3 })).toEqual({ cents: 15000, source: 'tech' });
    expect(resolveRate(card, rates, { work_type_id: null, user_id: 9 })).toEqual({ cents: 10000, source: 'card' });
  });
  it('is zero with no card', () => {
    expect(resolveRate(null, [], {}).cents).toBe(0);
  });
});

describe('hoursClass', () => {
  it('uses the business-hours window and days in its zone', () => {
    expect(hoursClass('2026-10-21T15:00:00Z', bh)).toBe('business');    // Wed 10:00 CDT
    expect(hoursClass('2026-10-21T23:30:00Z', bh)).toBe('after_hours'); // Wed 18:30 CDT
    expect(hoursClass('2026-10-24T15:00:00Z', bh)).toBe('weekend');     // Sat
  });
  it('without a policy, only Sat/Sun count (in the org zone)', () => {
    expect(hoursClass('2026-10-21T23:30:00Z', null, 'America/Chicago')).toBe('business');
    expect(hoursClass('2026-10-25T03:00:00Z', null, 'America/Chicago')).toBe('weekend'); // Sat 22:00 CDT
  });
});

const entry = (id, startIso, minutes, extra = {}) => ({
  id, ticket_id: 1, user_id: 9, work_type_id: null, billable: true,
  started_at: startIso, created_at: startIso, duration_minutes: minutes, ...extra,
});

describe('per-day ticket minimum', () => {
  const es = [
    entry(1, '2026-10-20T15:00:00Z', 10),
    entry(2, '2026-10-20T18:00:00Z', 10),
    entry(3, '2026-10-21T15:00:00Z', 5),
  ];
  it('ticket scope tops up once', () => {
    const r = tt.computeBillable(es, { billing_ticket_minimum: 30 });
    expect(r.topUp).toBe(5);
  });
  it('day scope tops up each day', () => {
    const r = tt.computeBillable(es, { billing_ticket_minimum: 30, billing_ticket_minimum_scope: 'day' }, { tz: 'America/Chicago' });
    expect(r.topUps).toEqual([
      { key: '2026-10-20', minutes: 10, anchorId: 1 },
      { key: '2026-10-21', minutes: 25, anchorId: 3 },
    ]);
  });
});

function price(behavior, es, settings = {}, contract = null, extra = {}) {
  const { units } = billableUnits(es, settings, { tz: 'America/Chicago' });
  for (const u of units) u.ctx = { contract, behavior, card, rates, bh };
  return priceUnits(units, { tz: 'America/Chicago', ...extra });
}

describe('priceUnits', () => {
  it('hourly: minutes x rate, with after-hours and weekend multipliers', () => {
    const { units } = price('hourly', [
      entry(1, '2026-10-21T15:00:00Z', 30),               // business, $100/h → $50
      entry(2, '2026-10-21T23:30:00Z', 60),               // after-hours ×1.5 → $150
      entry(3, '2026-10-24T15:00:00Z', 30),               // weekend ×2 → $100
      entry(4, '2026-10-21T16:00:00Z', 60, { work_type_id: 7 }), // travel $60
    ]);
    const byId = Object.fromEntries(units.map((u) => [u.entry.id, u]));
    expect(byId[1].amount_cents).toBe(5000);
    expect([byId[2].hours_class, byId[2].rate_cents, byId[2].amount_cents]).toEqual(['after_hours', 15000, 15000]);
    expect([byId[3].hours_class, byId[3].amount_cents]).toEqual(['weekend', 10000]);
    expect(byId[4].amount_cents).toBe(6000);
    expect(totals(units).amount_cents).toBe(36000);
  });

  it('covered: billable minutes count, $0', () => {
    const { units } = price('covered', [entry(1, '2026-10-21T15:00:00Z', 45)]);
    expect([units[0].coverage, units[0].billable_minutes, units[0].covered_minutes, units[0].amount_cents]).toEqual(['covered', 45, 45, 0]);
  });

  it('non_billable: nothing billable', () => {
    const { units } = price('non_billable', [entry(1, '2026-10-21T15:00:00Z', 45)]);
    expect([units[0].billable_minutes, units[0].amount_cents]).toEqual([0, 0]);
  });

  it('prepaid block draws down, then overage at the rate', () => {
    const contract = { id: 5, block_hours: 1, block_period: 'term' };
    const { units, blockUsed } = price('prepaid_block', [
      entry(1, '2026-10-21T15:00:00Z', 40),
      entry(2, '2026-10-21T16:00:00Z', 40),
      entry(3, '2026-10-21T16:45:00Z', 15),
    ], {}, contract);
    expect(units.map((u) => [u.coverage, u.covered_minutes, u.amount_cents])).toEqual([
      ['block', 40, 0],
      ['block_overage', 20, 3333], // 20 min overage at $100/h
      ['overage', 0, 2500],
    ]);
    expect(blockUsed).toEqual({ 5: { term: 60 } });
  });

  it('monthly blocks reset each month and honour prior usage', () => {
    const contract = { id: 5, block_hours: 1, block_period: 'monthly' };
    const { units } = price('prepaid_block', [
      entry(1, '2026-10-21T15:00:00Z', 30),
      entry(2, '2026-11-03T16:00:00Z', 30),
    ], {}, contract, { usedBefore: { 5: { '2026-10': 45 } } });
    expect(units.map((u) => [u.block_period, u.covered_minutes, u.amount_cents])).toEqual([
      ['2026-10', 15, 2500],
      ['2026-11', 30, 0],
    ]);
  });

  it('prices a ticket-minimum top-up like its anchor entry', () => {
    const { units } = price('hourly', [entry(1, '2026-10-21T23:30:00Z', 10)], { billing_ticket_minimum: 30 });
    const top = units.find((u) => u.kind === 'topup');
    expect([top.minutes, top.hours_class, top.amount_cents]).toEqual([20, 'after_hours', 5000]);
  });
});

describe('contractOn', () => {
  const cs = [
    { id: 1, starts_on: '2026-01-01', ends_on: null, active: true },
    { id: 2, starts_on: '2026-10-01', ends_on: '2026-10-31', active: true },
    { id: 3, starts_on: '2026-10-15', ends_on: null, active: false },
  ];
  it('latest active term in force wins', () => {
    expect(contractOn(cs, '2026-10-20T15:00:00Z', 'UTC').id).toBe(2);
    expect(contractOn(cs, '2026-11-02T15:00:00Z', 'UTC').id).toBe(1);
    expect(contractOn(cs, '2025-12-31T15:00:00Z', 'UTC')).toBe(null);
  });
});

describe('blockAlertLevel', () => {
  const { blockAlertLevel } = br;
  it('reports threshold and exhausted', () => {
    expect(blockAlertLevel(470, 600, 80)).toBe(null);
    expect(blockAlertLevel(480, 600, 80)).toBe('threshold');
    expect(blockAlertLevel(600, 600, 80)).toBe('exhausted');
    expect(blockAlertLevel(650, 600, 80)).toBe('exhausted');
  });
  it('0% turns the early warning off but still reports used up', () => {
    expect(blockAlertLevel(590, 600, 0)).toBe(null);
    expect(blockAlertLevel(600, 600, 0)).toBe('exhausted');
  });
  it('no block, no alert', () => {
    expect(blockAlertLevel(10, 0, 80)).toBe(null);
  });
});

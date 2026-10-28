// Pure-function tests for holiday rules.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { holidayMatcher, holidayClosures, occurrences, nextOccurrence, describeRule, nthWeekdayDay, validRule } = require('../services/holidays');

const dates = (rules, from, to = from) => occurrences(rules, from, to).map((o) => o.date);

describe('nth weekday rules', () => {
  it('finds nth and last weekdays of a month', () => {
    expect(nthWeekdayDay(2026, 11, 4, 4)).toBe(26);  // 4th Thursday of Nov 2026
    expect(nthWeekdayDay(2026, 5, 1, -1)).toBe(25);  // last Monday of May 2026
    expect(nthWeekdayDay(2026, 9, 1, 1)).toBe(7);    // 1st Monday of Sep 2026
    expect(nthWeekdayDay(2026, 8, 1, -1)).toBe(31);  // last day is itself the weekday
    expect(nthWeekdayDay(2026, 2, 1, 5)).toBeNull(); // no 5th Monday in Feb 2026
  });

  it('repeats every year', () => {
    const thanksgiving = { kind: 'nth_weekday', month: 11, weekday: 4, nth: 4 };
    expect(dates([thanksgiving], 2025, 2027)).toEqual(['2025-11-27', '2026-11-26', '2027-11-25']);
  });
});

describe('date rules', () => {
  it('one-off dates only match their year; recurring every year', () => {
    expect(dates([{ kind: 'date', date: '2026-06-08' }], 2026, 2027)).toEqual(['2026-06-08']);
    expect(dates([{ kind: 'date', date: '2001-12-25', recurring: true }], 2026, 2027)).toEqual(['2026-12-25', '2027-12-25']);
  });

  it('treats rows without kind as dates (pre-rule rows)', () => {
    expect(dates([{ date: '2026-06-08' }], 2026)).toEqual(['2026-06-08']);
  });

  it('only places a recurring Feb 29 in leap years', () => {
    expect(dates([{ kind: 'date', date: '2024-02-29', recurring: true }], 2027, 2028)).toEqual(['2028-02-29']);
  });
});

describe('observed shift', () => {
  it('moves Saturday to Friday and Sunday to Monday', () => {
    const july4 = { kind: 'date', date: '2000-07-04', recurring: true, observed: true };
    expect(dates([july4], 2026)).toEqual(['2026-07-03']); // Sat → Fri
    expect(dates([july4], 2027)).toEqual(['2027-07-05']); // Sun → Mon
    expect(dates([july4], 2028)).toEqual(['2028-07-04']); // Tue stays
  });

  it('crosses the year boundary', () => {
    const newYear = { kind: 'date', date: '2000-01-01', recurring: true, observed: true };
    // Sat 2022-01-01 is taken Fri 2021-12-31.
    expect(dates([newYear], 2021)).toEqual(['2021-01-01', '2021-12-31']);
    expect(dates([newYear], 2022)).toEqual([]);
  });

  it('records the actual date next to the taken one', () => {
    const o = occurrences([{ kind: 'date', date: '2026-07-04', observed: true }], 2026, 2026)[0];
    expect(o).toMatchObject({ date: '2026-07-03', actual: '2026-07-04' });
  });
});

describe('holidayMatcher', () => {
  it('matches mixed rules and ignores malformed ones', () => {
    const m = holidayMatcher([
      { kind: 'nth_weekday', month: 5, weekday: 1, nth: -1 },
      { kind: 'date', date: '2026-12-25' },
      { kind: 'nth_weekday', month: 13, weekday: 1, nth: 1 },
      { kind: 'date', date: 'bad' },
      null,
    ]);
    expect(m(2026, 5, 25)).toBe(true);
    expect(m(2027, 5, 31)).toBe(true);
    expect(m(2026, 12, 25)).toBe(true);
    expect(m(2026, 5, 26)).toBe(false);
  });
});

describe('nextOccurrence / describeRule', () => {
  it('finds the next date on or after today', () => {
    const memorial = { kind: 'nth_weekday', month: 5, weekday: 1, nth: -1 };
    expect(nextOccurrence(memorial, '2026-05-25')).toBe('2026-05-25');
    expect(nextOccurrence(memorial, '2026-05-26')).toBe('2027-05-31');
    expect(nextOccurrence({ kind: 'date', date: '2020-01-01' }, '2026-01-01')).toBeNull();
  });

  it('reads like a person would say it', () => {
    expect(describeRule({ kind: 'nth_weekday', month: 11, weekday: 4, nth: 4 })).toBe('4th Thursday of November');
    expect(describeRule({ kind: 'nth_weekday', month: 5, weekday: 1, nth: -1 })).toBe('last Monday of May');
    expect(describeRule({ kind: 'date', date: '2000-12-25', recurring: true })).toBe('Every December 25');
    expect(describeRule({ kind: 'date', date: '2026-06-08' })).toBe('2026-06-08');
  });
});

describe('spans and early closes', () => {
  const thanksgiving = { kind: 'nth_weekday', month: 11, weekday: 4, nth: 4, span_days: 2 };

  it('closes consecutive days from the date taken', () => {
    const closed = holidayMatcher([thanksgiving]);
    expect(closed(2026, 11, 26)).toBe(true);   // Thu
    expect(closed(2026, 11, 27)).toBe(true);   // Fri
    expect(closed(2026, 11, 28)).toBe(false);
    expect(occurrences([thanksgiving], 2026, 2026)[0]).toMatchObject({ date: '2026-11-26', last: '2026-11-27' });
    // A dated span works the same: 11/26–27 this year only.
    expect(holidayMatcher([{ kind: 'date', date: '2026-11-26', span_days: 2 }])(2026, 11, 27)).toBe(true);
  });

  it('runs a span across the year boundary', () => {
    const closed = holidayMatcher([{ kind: 'date', date: '2026-12-31', span_days: 2 }]);
    expect(closed(2026, 12, 31)).toBe(true);
    expect(closed(2027, 1, 1)).toBe(true);
    expect(closed(2027, 1, 2)).toBe(false);
  });

  it('an early close is open, with a closing time', () => {
    const early = { kind: 'date', date: '2026-11-25', closes_at: '12:00' };
    expect(holidayMatcher([early])(2026, 11, 25)).toBe(false);
    expect(holidayClosures([early])(2026, 11, 25)).toEqual({ closesAt: '12:00' });
    expect(holidayClosures([early])(2026, 11, 24)).toBeNull();
  });

  it('a whole day beats an early close; the earlier close wins', () => {
    const at = (rules) => holidayClosures(rules)(2026, 11, 25);
    expect(at([{ date: '2026-11-25', closes_at: '12:00' }, { date: '2026-11-25' }])).toEqual({ closesAt: null });
    expect(at([{ date: '2026-11-25', closes_at: '15:00' }, { date: '2001-11-25', recurring: true, closes_at: '12:00' }]))
      .toEqual({ closesAt: '12:00' });
  });

  it('validates span and closing time', () => {
    expect(validRule({ date: '2026-11-26', span_days: 14 })).toBe(true);
    expect(validRule({ date: '2026-11-26', span_days: 15 })).toBe(false);
    expect(validRule({ date: '2026-11-26', span_days: 0 })).toBe(false);
    expect(validRule({ date: '2026-11-26', closes_at: '24:00' })).toBe(false);
    expect(validRule({ date: '2026-11-26', closes_at: '12:00', span_days: 2 })).toBe(false);
  });

  it('describes spans and early closes; next covers a span under way', () => {
    expect(describeRule(thanksgiving)).toBe('4th Thursday of November · 2 days');
    expect(describeRule({ kind: 'date', date: '2026-11-25', closes_at: '12:00' })).toBe('2026-11-25 · closes 12:00');
    expect(nextOccurrence(thanksgiving, '2026-11-27')).toBe('2026-11-26');
    expect(nextOccurrence(thanksgiving, '2026-11-28')).toBe('2027-11-25');
  });
});

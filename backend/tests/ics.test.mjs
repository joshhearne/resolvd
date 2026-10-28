import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildCalendar, escapeText, utcStamp, fold } = require('../services/ics');

describe('ics', () => {
  it('escapes text values', () => {
    expect(escapeText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
  });

  it('formats UTC stamps', () => {
    expect(utcStamp('2026-10-12T21:08:08.123Z')).toBe('20261012T210808Z');
  });

  it('folds long lines at 75 octets without splitting characters', () => {
    const line = `SUMMARY:${'é'.repeat(60)}`;
    const folded = fold(line);
    for (const part of folded.split('\r\n')) {
      expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(75);
    }
    expect(folded.split('\r\n ').join('')).toBe(line);
  });

  it('builds a calendar with CRLF lines and events', () => {
    const out = buildCalendar({
      name: 'Resolvd · DEV',
      now: new Date('2026-10-12T00:00:00Z'),
      events: [{
        uid: 'maintenance-1@resolvd.example',
        start: '2026-10-13T02:00:00Z',
        end: '2026-10-13T03:00:00Z',
        summary: 'Maintenance: NetBox upgrade [DEV]',
        description: 'Affects: netbox\nAssigned: Tech One',
        sequence: 5,
      }],
    });
    expect(out.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(out.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(out).toContain('DTSTART:20261013T020000Z');
    expect(out).toContain('DTEND:20261013T030000Z');
    expect(out).toContain('UID:maintenance-1@resolvd.example');
    expect(out).toContain('DESCRIPTION:Affects: netbox\\nAssigned: Tech One');
    expect(out).toContain('SEQUENCE:5');
    expect(out.split('\r\n').filter((l) => l && !l.startsWith(' ')).every((l) => /^[A-Z-]+[:;]/.test(l))).toBe(true);
  });
});

describe('buildCalendar — all-day events', () => {
  it('writes DATE values and marks holidays free', () => {
    const out = buildCalendar({
      name: 'Holidays',
      events: [{ uid: 'h1@x', start: '2026-11-26', end: '2026-11-27', allDay: true, transparent: true, summary: 'Thanksgiving' }],
      now: new Date('2026-10-12T21:08:08Z'),
    });
    expect(out).toContain('DTSTART;VALUE=DATE:20261126\r\n');
    expect(out).toContain('DTEND;VALUE=DATE:20261127\r\n');
    expect(out).toContain('TRANSP:TRANSPARENT\r\n');
  });
});

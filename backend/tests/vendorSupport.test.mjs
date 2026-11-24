// Vendor support channels: which tickets match a vendor's conditions,
// channel validation, and the agent-only note text.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateConditions, fieldMatches, regexError, noteBody } = require('../services/vendorSupport');
const { cleanChannel } = require('../routes/vendorSupport')._test;

const ticket = { title: 'G2 Astra down at MOT2', description: 'Nobody can log in' };

describe('evaluateConditions', () => {
  it('matches everything with no conditions', () => {
    expect(evaluateConditions(null, ticket, []).matched).toBe(true);
    expect(evaluateConditions({ auto_note: true }, ticket, []).matched).toBe(true);
  });
  it('applies the regex case-insensitively to title + description', () => {
    expect(evaluateConditions({ match_regex: 'astra' }, ticket, []).matched).toBe(true);
    expect(evaluateConditions({ match_regex: 'log in$' }, ticket, []).matched).toBe(true);
    expect(evaluateConditions({ match_regex: 'printer' }, ticket, []).matched).toBe(false);
  });
  it('requires every set condition', () => {
    const fields = [{ slug: 'system', value: 'G2 Astra' }];
    expect(evaluateConditions({ match_regex: 'astra', match_field_slug: 'system', match_field_values: ['g2 astra'] }, ticket, fields).matched).toBe(true);
    expect(evaluateConditions({ match_regex: 'astra', match_field_slug: 'system', match_field_values: ['DealerTrack'] }, ticket, fields).matched).toBe(false);
  });
});

describe('fieldMatches', () => {
  it('compares values case-insensitively, including multiselect and yes/no', () => {
    expect(fieldMatches([{ slug: 's', value: ['A', 'B'] }], 's', ['b'])).toBe(true);
    expect(fieldMatches([{ slug: 's', value: true }], 's', ['yes'])).toBe(true);
    expect(fieldMatches([{ slug: 's', value: 'x' }], 's', [])).toBe(true); // just filled in
    expect(fieldMatches([{ slug: 's', value: '' }], 's', [])).toBe(false);
    expect(fieldMatches([], 's', ['x'])).toBe(false);
  });
});

describe('regexError', () => {
  it('accepts valid patterns and rejects broken or oversized ones', () => {
    expect(regexError('astra|g2')).toBeNull();
    expect(regexError('')).toBeNull();
    expect(regexError('(open')).toMatch(/valid regular expression/);
    expect(regexError('a'.repeat(301))).toMatch(/at most 300/);
  });
});

describe('cleanChannel', () => {
  it('normalises email and keeps role addresses', () => {
    const [f, e] = cleanChannel({ kind: 'email', value: 'Support@Vendor.com' });
    expect(e).toBeUndefined();
    expect(f.value).toBe('support@vendor.com');
  });
  it('rejects script links, bad phones and backwards ranges', () => {
    expect(cleanChannel({ kind: 'portal', value: 'javascript:alert(1)' })[1]).toMatch(/https/);
    expect(cleanChannel({ kind: 'phone', value: 'call bob' })[1]).toMatch(/phone number/);
    expect(cleanChannel({ kind: 'phone', value: '8005550100', min_priority: 4, max_priority: 2 })[1]).toMatch(/backwards/);
    expect(cleanChannel({ kind: 'fax', value: '1' })[1]).toMatch(/kind/);
  });
  it('validates a partial edit against the current channel', () => {
    const current = { kind: 'phone', value: '8005550100', min_priority: 1, max_priority: 2 };
    expect(cleanChannel({ min_priority: 3 }, { partial: true, current })[1]).toMatch(/backwards/);
    expect(cleanChannel({ notes: 'Press 2' }, { partial: true, current })[0]).toEqual({ notes: 'Press 2' });
  });
});

describe('noteBody', () => {
  it('lists recommended channels with notes, then the others', () => {
    const body = noteBody({
      company: { name: 'IDS' },
      channels: [
        { kind: 'phone', label: 'Support', value: '800-555-0100', notes: 'Press 2\nAcct 123', min_priority: 1, max_priority: 2, recommended: true },
        { kind: 'email', value: 'support@ids.com', min_priority: 3, max_priority: 5, recommended: false },
      ],
    }, 2, 'create');
    expect(body).toContain('**Vendor support: IDS** (P2)');
    expect(body).toContain('- **Call** Support: 800-555-0100 _(P1-P2)_');
    expect(body).toContain('  > Acct 123');
    expect(body).toContain('Other options: email support@ids.com');
  });
});

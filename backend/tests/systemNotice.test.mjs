// Our own notification emails looping back through the inbound mailbox
// must be recognised as system notices, and ordinary replies must not.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let detectSystemNotice;
beforeAll(() => {
  require('../db/pool').pool.query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  process.env.MAIL_FROM = 'noreply@example.com';
  ({ detectSystemNotice } = require('../services/autoResolve'));
});

describe('detectSystemNotice', () => {
  it('recognises SLA warnings and breaches by subject or body', () => {
    expect(detectSystemNotice({ subject: '[INC-0528] SLA breach: resolve window missed', body: 'INC-0528 passed its resolve SLA target' })).toBe('sla');
    expect(detectSystemNotice({ subject: 'FW: something', body: 'Resolvd\n[INC-0528] SLA warning: response window closing\nThe response SLA on INC-0528 is about to' })).toBe('sla');
    expect(detectSystemNotice({ subject: 'Resolve SLA breached: INC-0528', body: '' })).toBe('sla');
    expect(detectSystemNotice({ subject: 'Response window closing on INC-0528 — Printer', body: '' })).toBe('sla');
  });
  it('recognises anything else sent from our own notification address', () => {
    expect(detectSystemNotice({ subject: '[HR-0009] Assigned to you', body: 'Resolvd assigned this ticket', fromAddress: 'NoReply@Example.com' })).toBe('notification');
  });
  it('leaves human replies alone, even when they talk about SLAs', () => {
    expect(detectSystemNotice({ subject: 'Re: [INC-0528] Printer jam', body: 'We blew the SLA breach window yesterday, sorry. Fixed now.', fromAddress: 'bob@customer.com' })).toBeNull();
    expect(detectSystemNotice({ subject: 'Re: [INC-0528] Printer jam', body: 'Thanks!', fromAddress: 'noreply@othercompany.com' })).toBeNull();
  });
});

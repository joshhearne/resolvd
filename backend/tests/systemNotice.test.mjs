// Our own notification emails looping back through the inbound mailbox
// must be recognised as system notices, and ordinary replies must not.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let detectSystemNotice;
beforeAll(() => {
  require('../db/pool').pool.query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  process.env.MAIL_FROM = 'noreply@example.com';
  process.env.FRONTEND_URL = 'https://resolvd.example.com';
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
  it('recognises any Resolvd notification by its body shape (the close-loop case)', () => {
    const closed = 'Resolvd\n[G2A-0025] Ticket closed\nTicket G2A-0025 has been closed.\nAuthorization Needed to Finalize Work Orders\n[View Ticket](https://resolvd.example.com/tickets/750)\nhttps://resolvd.example.com';
    expect(detectSystemNotice({ subject: '[G2A-0025] Ticket closed', body: closed, fromAddress: 'helpdesk@example.com' })).toBe('notification');
    expect(detectSystemNotice({ subject: 'FW: something', body: closed, fromAddress: 'someone@example.com' })).toBe('notification');
    const assigned = 'Resolvd\n[HR-0009] Assigned to you\nYou were assigned HR-0009.\n[View Ticket](https://resolvd.example.com/tickets/9)';
    expect(detectSystemNotice({ subject: '[HR-0009] Assigned to you', body: assigned, fromAddress: 'tech@example.com' })).toBe('notification');
  });
  it('keeps a human reply that quotes a notification underneath their own words', () => {
    const reply = 'Thanks, confirmed fixed on my side.\n\n> Resolvd\n> [G2A-0025] Ticket closed\n> [View Ticket](https://resolvd.example.com/tickets/750)';
    expect(detectSystemNotice({ subject: 'Re: [G2A-0025] Ticket closed', body: reply, fromAddress: 'user@customer.com' })).toBeNull();
  });
  it('leaves human replies alone, even when they talk about SLAs', () => {
    expect(detectSystemNotice({ subject: 'Re: [INC-0528] Printer jam', body: 'We blew the SLA breach window yesterday, sorry. Fixed now.', fromAddress: 'bob@customer.com' })).toBeNull();
    expect(detectSystemNotice({ subject: 'Re: [INC-0528] Printer jam', body: 'Thanks!', fromAddress: 'noreply@othercompany.com' })).toBeNull();
  });
});

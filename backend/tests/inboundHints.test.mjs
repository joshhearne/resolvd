// Pure-function tests for the inbound "likely unblocks" matcher.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { matchUnblockCandidates, splitExternalRefs } = require('../services/inboundHints');

const tickets = [
  { id: 1, internal_ref: 'SUP-0001', title: 'Printer', internal_status: 'Awaiting Input', external_ticket_ref: 'CASE-77812', contact_ids: [] },
  { id: 2, internal_ref: 'SUP-0002', title: 'VPN', internal_status: 'Awaiting Input', external_ticket_ref: null, contact_ids: [42] },
  { id: 3, internal_ref: 'SUP-0003', title: 'Email', internal_status: 'Awaiting Input', external_ticket_ref: 'Case 900; INC12', contact_ids: [] },
];

describe('splitExternalRefs', () => {
  it('splits on comma / semicolon, keeps spaces inside a ref, drops tiny fragments', () => {
    expect(splitExternalRefs('Case 900; INC12, x')).toEqual(['Case 900', 'INC12']);
    expect(splitExternalRefs(null)).toEqual([]);
  });
});

describe('matchUnblockCandidates', () => {
  it('matches the candidate ticket ref', () => {
    const r = matchUnblockCandidates({ message: { candidate_ticket_ref: 'sup-0002' }, tickets });
    expect(r).toMatchObject([{ id: 2, reason: 'ticket_ref' }]);
  });

  it('matches a vendor ref in the body on token boundaries only', () => {
    const hit = matchUnblockCandidates({ message: { subject: 'Re: your case', body: 'Update on CASE-77812: done' }, tickets });
    expect(hit).toMatchObject([{ id: 1, reason: 'external_ref', matched_ref: 'CASE-77812' }]);
    const miss = matchUnblockCandidates({ message: { body: 'see CASE-778123' }, tickets });
    expect(miss).toEqual([]);
  });

  it('matches multi-word and secondary refs', () => {
    const r = matchUnblockCandidates({ message: { subject: '[INC12] resolved' }, tickets });
    expect(r).toMatchObject([{ id: 3, matched_ref: 'INC12' }]);
    const r2 = matchUnblockCandidates({ message: { body: 'regarding case 900' }, tickets });
    expect(r2).toMatchObject([{ id: 3 }]);
  });

  it('matches when the sender is an attached contact', () => {
    const r = matchUnblockCandidates({ message: { body: 'hello' }, contactId: 42, tickets });
    expect(r).toMatchObject([{ id: 2, reason: 'contact' }]);
  });

  it('ranks ticket ref over vendor ref over contact', () => {
    const r = matchUnblockCandidates({
      message: { candidate_ticket_ref: 'SUP-0003', body: 'CASE-77812' },
      contactId: 42,
      tickets,
    });
    expect(r.map((c) => [c.id, c.reason])).toEqual([
      [3, 'ticket_ref'], [1, 'external_ref'], [2, 'contact'],
    ]);
  });

  it('returns nothing when no signal matches', () => {
    expect(matchUnblockCandidates({ message: { body: 'unrelated' }, contactId: 7, tickets })).toEqual([]);
  });
});

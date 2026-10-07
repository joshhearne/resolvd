// Knowledge briefs: what counts as noise in a ticket's comments. SLA
// warnings/breaches, project moves, and auto-replies must never be fed
// to a brief; real reports and replies must.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import nodeCrypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let assist;
beforeAll(() => {
  process.env.RESOLVD_MASTER_KEY = nodeCrypto.randomBytes(32).toString('base64');
  require('../db/pool').pool.query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  assist = require('../services/troveKbAssist');
});

describe('troveKbAssist.isNoiseComment', () => {
  it('drops SLA notifications however they are phrased', () => {
    expect(assist.isNoiseComment('Resolvd\n[INC-0528] SLA breach: resolve window missed\nINC-0528 passed its resolve SLA target')).toBe(true);
    expect(assist.isNoiseComment('Resolvd\n[INC-0528] SLA warning: response window closing\nThe response SLA on INC-0528 is about to')).toBe(true);
    expect(assist.isNoiseComment('SLA warning: response window closing')).toBe(true);
  });
  it('drops moves, merges, and automatic replies', () => {
    expect(assist.isNoiseComment('Ticket moved from project ID 6 (was INC-0528) to IDS G2 Astra as G2A-0025.')).toBe(true);
    expect(assist.isNoiseComment('Ticket moved (bulk) from project ID 1 (was WEB-0128) to MOT IT HR Helpdesk as HR-0009.')).toBe(true);
    expect(assist.isNoiseComment('Automatic reply: Out of Office')).toBe(true);
    expect(assist.isNoiseComment('   ')).toBe(true);
  });
  it('keeps real reports and replies, even ones that mention an SLA in passing', () => {
    expect(assist.isNoiseComment('My G2 session dropped again after I closed the laptop lid.')).toBe(false);
    expect(assist.isNoiseComment('Debbie,\n\nPlease see that these employees are removed from the website.')).toBe(false);
    expect(assist.isNoiseComment('We agreed the vendor SLA is 4 hours; they responded in 2.')).toBe(false);
  });
});

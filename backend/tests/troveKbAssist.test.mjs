// Knowledge-brief noise rules: the seeded built-ins must drop SLA
// notices, moves, and auto-replies and keep real reports; user rules
// drop a named account; literal rules match case-insensitively.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import nodeCrypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let noise; let rules;
beforeAll(() => {
  process.env.RESOLVD_MASTER_KEY = nodeCrypto.randomBytes(32).toString('base64');
  require('../db/pool').pool.query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  noise = require('../services/troveKbNoise');
  rules = [
    ...noise.BUILTINS.map((b, i) => ({ id: i + 1, enabled: true, ...b })),
    { id: 90, kind: 'user', user_id: 103, enabled: true },
    { id: 91, kind: 'literal', pattern: 'Sent from my iPhone', enabled: true },
    { id: 92, kind: 'regex', pattern: 'disabled rule', enabled: false },
  ].map(noise.compile);
});

const hit = (c) => noise.matchRules(rules, c).map((r) => r.id);

describe('troveKbNoise built-ins', () => {
  it('drop SLA notifications however they are phrased', () => {
    expect(hit({ body: 'Resolvd\n[INC-0528] SLA breach: resolve window missed\nINC-0528 passed its resolve SLA target' })).not.toEqual([]);
    expect(hit({ body: 'SLA warning: response window closing' })).not.toEqual([]);
  });
  it('drop moves, merges, and automatic replies', () => {
    expect(hit({ body: 'Ticket moved from project ID 6 (was INC-0528) to IDS G2 Astra as G2A-0025.' })).not.toEqual([]);
    expect(hit({ body: 'Ticket moved (bulk) from project ID 1 (was WEB-0128) to MOT IT HR Helpdesk as HR-0009.' })).not.toEqual([]);
    expect(hit({ body: 'Automatic reply: Out of Office' })).not.toEqual([]);
  });
  it('keep real reports and replies, even ones that mention an SLA in passing', () => {
    expect(hit({ body: 'My G2 session dropped again after I closed the laptop lid.', user_id: 1 })).toEqual([]);
    expect(hit({ body: 'We agreed the vendor SLA is 4 hours; they responded in 2.', user_id: 1 })).toEqual([]);
  });
});

describe('troveKbNoise admin rules', () => {
  it('a user rule drops that account only', () => {
    expect(hit({ body: 'anything at all', user_id: 103 })).toEqual([90]);
    expect(hit({ body: 'anything at all', user_id: 104 })).toEqual([]);
  });
  it('a literal rule matches case-insensitively; a disabled rule is skipped', () => {
    expect(hit({ body: 'ok will do\n\nsent from my iphone' })).toEqual([91]);
    expect(hit({ body: 'this is a disabled rule test' })).toEqual([]);
  });
  it('rejects a bad regex and an empty pattern', async () => {
    await expect(noise.createRule({ kind: 'regex', pattern: '(' })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(noise.createRule({ kind: 'literal', pattern: '  ' })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(noise.createRule({ kind: 'user' })).rejects.toMatchObject({ httpStatus: 400 });
  });
});

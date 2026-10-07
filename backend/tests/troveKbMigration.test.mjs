// The local-KB → Trove KB re-key, checked against the real exported step
// map: a block id becomes the first 8 hex of itself, which is the step id
// the export baked into the runbook Markdown.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import nodeCrypto from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

let m;
beforeAll(() => {
  process.env.RESOLVD_MASTER_KEY = nodeCrypto.randomBytes(32).toString('base64');
  require('../db/pool').pool.query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  m = require('../services/troveKbMigration');
});

const FIXTURE = {
  '8': { slug: 'nps-service-report-prep', steps: [
    { block_id: '6cb294f7-1489-4a5d-8ba6-6d68fc30f66d', step_id: '6cb294f7', text: 'Select the correct store' },
    { block_id: '588880e8-17fb-448d-aaf8-a499ce47816a', step_id: '588880e8', text: 'Select the correct department' },
  ] },
  '14': { slug: 'vm-pin-reset', steps: [
    { block_id: '7b790c08-ecd4-4129-a169-c55b683971ca', step_id: '7b790c08', text: 'Find the account' },
    { block_id: 'ac1b08a9-0000-4000-8000-000000000000', step_id: 'ac1b08a9', text: 'Send @canned:[Fidium VM PIN Reset]' },
  ] },
};

describe('troveKbMigration', () => {
  it('derives the step id the export baked in', () => {
    for (const entry of Object.values(FIXTURE)) {
      for (const s of entry.steps) expect(m.stepIdFromBlock(s.block_id)).toBe(s.step_id);
    }
  });

  it('re-keys step states and drops orphans, idempotently', () => {
    const steps = new Set(FIXTURE['8'].steps.map((s) => s.step_id));
    const before = {
      '6cb294f7-1489-4a5d-8ba6-6d68fc30f66d': { checked: true, checked_by: 1 },
      '4bc5dba6-c459-4a0c-a424-2daeb4115390': { checked: true, checked_by: 1 }, // block deleted in a later edit
    };
    const first = m.rekeyStepStates(before, steps);
    expect(first.next).toEqual({ '6cb294f7': { checked: true, checked_by: 1 } });
    expect(first.dropped).toBe(1);
    // Running again over already re-keyed states changes nothing: a step
    // id is its own first 8 hex.
    const second = m.rekeyStepStates(first.next, steps);
    expect(second).toEqual({ next: first.next, dropped: 0 });
  });

  it('agrees with the real export map when it is present', () => {
    const file = path.resolve(here, '../../backups/bothy-kb-export/out/runbook-step-map.json');
    if (!fs.existsSync(file)) return; // local-only artifact
    const map = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const entry of Object.values(map)) for (const s of entry.steps) expect(m.stepIdFromBlock(s.block_id)).toBe(s.step_id);
  });
});

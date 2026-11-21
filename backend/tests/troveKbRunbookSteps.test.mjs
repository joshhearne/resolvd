// Nested runbooks from Trove KB: expanded steps keep their paths, depths and
// groups; an older Trove KB's flat steps read as depth 0; the procedure text
// numbers nested steps under the step that links them.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runbookItems, leafItems, procedureText } = require('../services/troveKbRunbookSteps');

const expanded = {
  steps: [{ id: 'phone', text: 'Order the phone' }, { id: 'account', text: '[[kb:x|AD]]' }],
  expanded_steps: [
    { id: 'phone', step_id: 'phone', depth: 0, parent_id: null, group: false, text: 'Order the phone' },
    { id: 'account', step_id: 'account', depth: 0, parent_id: null, group: true, text: 'Create the AD account', includes: { id: 'x', title: 'Create the AD account', status: 'expanded' } },
    { id: 'account/user', step_id: 'user', depth: 1, parent_id: 'account', group: false, text: 'New user', note: 'In ADUC' },
    { id: 'account/groups', step_id: 'groups', depth: 1, parent_id: 'account', group: false, text: 'Add groups' },
    { id: 'laptop', step_id: 'laptop', depth: 0, parent_id: null, group: false, text: 'Hand over the laptop' },
  ],
};

describe('troveKbRunbookSteps', () => {
  it('takes the expanded steps when Trove KB sends them, keyed by path', () => {
    const items = runbookItems(expanded);
    expect(items.map((s) => [s.id, s.depth, s.group])).toEqual([
      ['phone', 0, false],
      ['account', 0, true],
      ['account/user', 1, false],
      ['account/groups', 1, false],
      ['laptop', 0, false],
    ]);
    expect(items[1].includes).toEqual({ id: 'x', title: 'Create the AD account', status: 'expanded' });
    expect(leafItems(items).map((s) => s.id)).toEqual(['phone', 'account/user', 'account/groups', 'laptop']);
  });

  it('reads an older Trove KB that sends steps alone', () => {
    expect(runbookItems({ steps: [{ id: 'a', text: 'One' }] })).toEqual([{ id: 'a', text: 'One', depth: 0, parent_id: null, group: false }]);
    expect(runbookItems({})).toEqual([]);
  });

  it('numbers nested steps under the step that links them', () => {
    expect(procedureText(runbookItems(expanded))).toBe(
      ['1. Order the phone', '2. Create the AD account', '   2.1. New user', '      In ADUC', '   2.2. Add groups', '3. Hand over the laptop'].join('\n'),
    );
  });
});

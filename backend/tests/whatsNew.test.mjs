// What's new: change-file parsing and the boot-time sync that turns new
// change files into a release + bell notifications (or drops them again
// after a rollback). The database is a recording stub.

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

let state;
const queries = [];
function handle(sql, params = []) {
  queries.push({ sql, params });
  if (/SELECT id FROM change_entries/.test(sql)) return { rows: state.known.map((id) => ({ id })) };
  if (/DELETE FROM change_releases/.test(sql)) return { rows: state.emptyReleases.map((id) => ({ id })) };
  if (/INSERT INTO change_releases/.test(sql)) return { rows: [{ id: 7 }] };
  return { rows: [] };
}
const poolPath = require.resolve('../db/pool');
require.cache[poolPath] = {
  id: poolPath, filename: poolPath, loaded: true,
  exports: {
    pool: {
      query: async (sql, params) => handle(sql, params),
      connect: async () => ({ query: async (sql, params) => handle(sql, params), release() {} }),
    },
  },
};

const { parseChange, loadChanges, summarize, syncChanges } = require('../services/whatsNew');

beforeEach(() => {
  state = { known: [], emptyReleases: [] };
  queries.length = 0;
});

const sqlMatching = (re) => queries.filter((q) => re.test(q.sql));

describe('parseChange', () => {
  it('reads type, audience and a one-line body', () => {
    expect(parseChange('97-holidays', '---\ntype: feature\naudience: everyone\n---\nHolidays can span days.\n'))
      .toEqual({ id: '97-holidays', kind: 'feature', audience: 'everyone', items: ['Holidays can span days.'] });
  });

  it('defaults to staff, accepts aliases, and splits a "- " list into bullets', () => {
    const e = parseChange('x', '---\ntype: Fixed   # comment\n---\n- one\n  continued\n- two\n');
    expect(e).toEqual({ id: 'x', kind: 'fix', audience: 'staff', items: ['one continued', 'two'] });
    expect(parseChange('y', '---\ntype: improved\naudience: all\n---\nok').kind).toBe('improvement');
  });

  it('rejects files without frontmatter, a known type, or a body', () => {
    expect(parseChange('a', 'just text')).toBeNull();
    expect(parseChange('b', '---\ntype: chore\n---\nbody')).toBeNull();
    expect(parseChange('c', '---\ntype: fix\n---\n\n')).toBeNull();
  });

  it('loads a directory, skipping README and broken files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'changes-'));
    fs.writeFileSync(path.join(dir, 'README.md'), 'how to');
    fs.writeFileSync(path.join(dir, 'b.md'), '---\ntype: fix\n---\nB');
    fs.writeFileSync(path.join(dir, 'a.md'), '---\ntype: feature\n---\nA');
    fs.writeFileSync(path.join(dir, 'broken.md'), 'no frontmatter');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
    expect(loadChanges(dir).map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('summarizes counts per kind', () => {
    expect(summarize([
      { kind: 'feature', items: ['a', 'b'] },
      { kind: 'fix', items: ['c'] },
    ])).toBe('2 new features, 1 fix');
  });
});

describe('syncChanges', () => {
  const feature = { id: 'f', kind: 'feature', audience: 'staff', items: ['F'] };
  const userFacing = { id: 'u', kind: 'improvement', audience: 'everyone', items: ['U'] };

  it('records new change files as one release and notifies by audience', async () => {
    const r = await syncChanges({ entries: [feature, userFacing], version: 'dev-abc1234', commit: 'abc' });
    expect(r).toEqual({ added: 2, removed: 0, releaseId: 7 });
    expect(sqlMatching(/INSERT INTO change_releases/)[0].params).toEqual(['dev-abc1234', 'abc']);
    expect(sqlMatching(/INSERT INTO change_entries/)).toHaveLength(2);

    const notes = sqlMatching(/INSERT INTO notifications/);
    expect(notes).toHaveLength(2);
    // Staff: everything.
    expect(notes[0].params[0]).toBe('Resolvd was updated to dev-abc1234');
    expect(notes[0].params[1]).toBe("1 new feature, 1 improvement. Click to see what's changed.");
    expect(notes[0].params.slice(3)).toEqual([['Admin', 'Manager', 'Tech'], true]);
    expect(JSON.parse(notes[0].params[2])).toEqual({ release_id: 7 });
    // Everyone else: only the user-facing entry.
    expect(notes[1].params[1]).toBe("1 improvement. Click to see what's changed.");
    expect(notes[1].params.slice(3)).toEqual([['Admin', 'Manager', 'Tech'], false]);
    expect(sqlMatching(/^COMMIT$/)).toHaveLength(1);
  });

  it("doesn't notify submitters when nothing is user-facing", async () => {
    await syncChanges({ entries: [feature], version: 'v1.2.0' });
    const notes = sqlMatching(/INSERT INTO notifications/);
    expect(notes).toHaveLength(1);
    expect(notes[0].params[4]).toBe(true);
  });

  it('does nothing new when every file is already known, but keeps wording in step', async () => {
    state.known = ['f'];
    const r = await syncChanges({ entries: [feature] });
    expect(r.added).toBe(0);
    expect(sqlMatching(/INSERT INTO/)).toHaveLength(0);
    expect(sqlMatching(/UPDATE change_entries/)[0].params[0]).toBe('f');
  });

  it('drops entries a rollback took away, with their empty releases and notifications', async () => {
    state.known = ['f', 'gone'];
    state.emptyReleases = [5];
    const r = await syncChanges({ entries: [feature] });
    expect(r).toMatchObject({ added: 0, removed: 1 });
    expect(sqlMatching(/DELETE FROM change_entries/)[0].params).toEqual([['gone']]);
    expect(sqlMatching(/DELETE FROM notifications/)[0].params).toEqual([[5]]);
  });

  it('rolls back the transaction on a database error', async () => {
    const orig = state;
    state = { get known() { throw new Error('boom'); }, emptyReleases: [] };
    await expect(syncChanges({ entries: [feature] })).rejects.toThrow('boom');
    expect(sqlMatching(/^ROLLBACK$/)).toHaveLength(1);
    state = orig;
  });
});

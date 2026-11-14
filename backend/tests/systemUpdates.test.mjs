// Host-facing update endpoints: token auth and the plain-text policy the
// host updater parses. The database is stubbed; the routes run in a real
// Express app over HTTP.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const settings = { channel: 'development', update_hour: 4, update_requested_at: null };
const queries = [];
const poolPath = require.resolve('../db/pool');
require.cache[poolPath] = {
  id: poolPath, filename: poolPath, loaded: true,
  exports: {
    pool: {
      query: async (sql, params) => {
        queries.push({ sql, params });
        return { rows: [settings] };
      },
    },
  },
};

const express = require('express');
const router = require('../routes/systemUpdates');

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use('/api/system-updates', router);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/system-updates`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => {
  process.env.RESOLVD_UPDATER_TOKEN = 'secret-token';
  queries.length = 0;
});

const auth = (t) => ({ Authorization: `Bearer ${t}` });

describe('host updater endpoints', () => {
  it('refuse every request when the token is not configured', async () => {
    delete process.env.RESOLVD_UPDATER_TOKEN;
    const r = await fetch(`${base}/policy`, { headers: auth('anything') });
    expect(r.status).toBe(503);
  });

  it('reject a missing or wrong token', async () => {
    expect((await fetch(`${base}/policy`)).status).toBe(401);
    expect((await fetch(`${base}/policy`, { headers: auth('wrong') })).status).toBe(401);
    expect(queries).toHaveLength(0);
  });

  it('serve the policy as key=value lines', async () => {
    let r = await fetch(`${base}/policy`, { headers: auth('secret-token') });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('channel=development\nupdate_hour=4\nupdate_now=0\n');
    settings.update_requested_at = new Date();
    r = await fetch(`${base}/policy`, { headers: auth('secret-token') });
    expect(await r.text()).toContain('update_now=1');
    settings.update_requested_at = null;
  });

  it('validate report status and log updates as events', async () => {
    const post = (fields) => fetch(`${base}/report`, {
      method: 'POST', headers: auth('secret-token'), body: new URLSearchParams(fields),
    });
    expect((await post({ status: 'bogus' })).status).toBe(400);
    expect(queries).toHaveLength(0);

    expect((await post({ status: 'up_to_date', message: 'fine' })).status).toBe(200);
    expect(queries.some((q) => q.sql.includes('INSERT INTO update_events'))).toBe(false);

    queries.length = 0;
    expect((await post({ status: 'updated', previous_version: 'v1.0.0', target_version: 'v1.1.0', handled_request: '1' })).status).toBe(200);
    const update = queries.find((q) => q.sql.includes('UPDATE update_settings'));
    expect(update.params[1]).toBe(true); // clears the pending "update now"
    const insert = queries.find((q) => q.sql.includes('INSERT INTO update_events'));
    expect(insert.params.slice(0, 4)).toEqual(['updated', null, 'v1.0.0', 'v1.1.0']);
  });

  it('store the change files of the build the host would install next', async () => {
    const body = new URLSearchParams({ status: 'waiting', pending_changes_sent: '1', pending_changes_total: '3' });
    body.append('pending_change', '97-holidays\n---\ntype: feature\naudience: everyone\n---\nHoliday spans');
    body.append('pending_change', '98-fix\n---\ntype: fix\n---\n- one\n- two');
    body.append('pending_change', 'broken\nno frontmatter');
    const r = await fetch(`${base}/report`, { method: 'POST', headers: auth('secret-token'), body });
    expect(r.status).toBe(200);
    const update = queries.find((q) => q.sql.includes('UPDATE update_settings'));
    expect(update.params[2]).toBe(true);
    expect(JSON.parse(update.params[3])).toEqual({
      total: 3,
      entries: [
        { id: '97-holidays', kind: 'feature', audience: 'everyone', items: ['Holiday spans'] },
        { id: '98-fix', kind: 'fix', audience: 'staff', items: ['one', 'two'] },
      ],
    });

    // An empty set clears the preview; an older updater that sends nothing keeps it.
    queries.length = 0;
    await fetch(`${base}/report`, { method: 'POST', headers: auth('secret-token'), body: new URLSearchParams({ status: 'up_to_date', pending_changes_sent: '1' }) });
    let u = queries.find((q) => q.sql.includes('UPDATE update_settings'));
    expect(u.params[2]).toBe(true);
    expect(JSON.parse(u.params[3])).toEqual({ total: 0, entries: [] });
    queries.length = 0;
    await fetch(`${base}/report`, { method: 'POST', headers: auth('secret-token'), body: new URLSearchParams({ status: 'up_to_date' }) });
    u = queries.find((q) => q.sql.includes('UPDATE update_settings'));
    expect(u.params[2]).toBe(false);
  });
});

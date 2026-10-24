const { Pool } = require('pg');
const { AsyncLocalStorage } = require('node:async_hooks');

// `pool` is a facade over the real pg.Pool so the same code runs in both
// runtimes:
//
// - Node (Docker): one process-wide Pool, created on first use.
// - Cloudflare Workers: a socket opened while serving one request can't
//   be used by another, and the Hyperdrive connection string is only
//   readable inside a handler. The Worker entry wraps each request / cron
//   run in withScopedPool(), which gives that unit of work its own Pool.
//   Hyperdrive does the real connection pooling behind it.
const scope = new AsyncLocalStorage();
let shared = null;

function makePool(connectionString) {
  const p = new Pool({ connectionString });
  p.on('error', (err) => {
    console.error('Unexpected PostgreSQL pool error:', err);
  });
  return p;
}

function current() {
  const s = scope.getStore();
  if (s) return (s.pool ??= makePool(s.connectionString));
  return (shared ??= makePool(process.env.DATABASE_URL));
}

const pool = {
  query: (...args) => current().query(...args),
  connect: (...args) => current().connect(...args),
  on: (...args) => current().on(...args),
  end: () => {
    const s = scope.getStore();
    const p = s ? s.pool : shared;
    if (s) s.pool = null; else shared = null;
    return p ? p.end() : Promise.resolve();
  },
};

// Count `promise` as outstanding work for the current scope until it
// settles. The Worker entry routes every fetch() through this, so a
// fire-and-forget email/push call keeps the request alive.
function trackPending(promise) {
  const s = scope.getStore();
  if (!s) return promise;
  s.pending += 1;
  const done = () => { s.pending -= 1; };
  promise.then(done, done);
  return promise;
}

// Resolves once the scope has had no checked-out or waiting DB clients
// and no tracked pending work for `quietMs`, or after `maxMs`. Lets
// fire-and-forget work a handler started after responding (notification
// fan-out, vendor email) finish before the Worker tears the request down.
async function waitForIdle(s, { quietMs = 500, maxMs = 25000 } = {}) {
  const deadline = Date.now() + maxMs;
  let quietSince = null;
  while (Date.now() < deadline) {
    const p = s.pool;
    const busy = s.pending > 0 || (p && (p.totalCount > p.idleCount || p.waitingCount > 0));
    if (busy) quietSince = null;
    else if (quietSince === null) quietSince = Date.now();
    else if (Date.now() - quietSince >= quietMs) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

// Run fn with its own pool. Returns fn's result plus `settled`, a promise
// that resolves after the pool goes idle and is closed (hand it to
// ctx.waitUntil()).
async function withScopedPool(connectionString, fn) {
  const s = { connectionString, pool: null, pending: 0 };
  const result = await scope.run(s, fn);
  const settled = waitForIdle(s)
    .then(() => s.pool && s.pool.end())
    .catch((err) => console.error('scoped pool close error:', err.message));
  return { result, settled };
}

async function query(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

async function getOne(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows[0] || null;
}

async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, getOne, transaction, withScopedPool, trackPending };

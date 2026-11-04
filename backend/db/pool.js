const { Pool } = require('pg');

const intEnv = (name, dflt) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: intEnv('PG_POOL_MAX', 10),
  // Waiting for a free connection errors out instead of hanging forever
  // (the session store shares this pool, so exhaustion froze every page).
  connectionTimeoutMillis: intEnv('PG_CONNECT_TIMEOUT_MS', 15000),
  // Postgres kills a session left idle inside an open transaction, so a
  // transaction that awaits something it can never get (#104) releases
  // its locks instead of wedging the pool. 0 disables.
  idle_in_transaction_session_timeout: intEnv('PG_IDLE_IN_TXN_TIMEOUT_MS', 60000),
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

// The pool's own 'error' handler only covers idle clients. A checked-out
// client whose backend is terminated (e.g. idle_in_transaction timeout,
// admin pg_terminate_backend) emits 'error' on the client itself, which
// would crash the process unhandled. The in-flight query still rejects,
// so callers see the failure; this just keeps the server up.
pool.on('connect', (client) => {
  client.on('error', (err) => {
    console.error('PostgreSQL client error (connection dropped):', err.message);
  });
});

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
  let broken;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // A failed ROLLBACK means the connection is broken (e.g. killed by
    // idle_in_transaction_session_timeout): keep the original error and
    // discard the client instead of returning it to the pool.
    await client.query('ROLLBACK').catch((e) => { broken = e; });
    throw err;
  } finally {
    client.release(broken);
  }
}

module.exports = { pool, query, getOne, transaction };

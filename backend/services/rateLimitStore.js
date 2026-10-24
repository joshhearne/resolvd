// Postgres-backed store for express-rate-limit. Used on Cloudflare
// Workers, where the default MemoryStore can't start its cleanup timer at
// import time and would only count per isolate anyway. Docker keeps the
// in-memory default (see storeFor()).

const { pool } = require('../db/pool');

class PgRateLimitStore {
  constructor(prefix) {
    this.prefix = `${prefix}:`;
    this.localKeys = false;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  async get(key) {
    const r = await pool.query(
      'SELECT hits, reset_at FROM rate_limit_hits WHERE key = $1 AND reset_at > NOW()',
      [this.prefix + key],
    );
    const row = r.rows[0];
    return row ? { totalHits: row.hits, resetTime: row.reset_at } : undefined;
  }

  // Start a fresh window when the stored one has lapsed.
  async increment(key) {
    const r = await pool.query(
      `INSERT INTO rate_limit_hits (key, hits, reset_at)
       VALUES ($1, 1, NOW() + $2 * INTERVAL '1 millisecond')
       ON CONFLICT (key) DO UPDATE SET
         hits = CASE WHEN rate_limit_hits.reset_at <= NOW() THEN 1 ELSE rate_limit_hits.hits + 1 END,
         reset_at = CASE WHEN rate_limit_hits.reset_at <= NOW() THEN EXCLUDED.reset_at ELSE rate_limit_hits.reset_at END
       RETURNING hits, reset_at`,
      [this.prefix + key, this.windowMs],
    );
    return { totalHits: r.rows[0].hits, resetTime: r.rows[0].reset_at };
  }

  async decrement(key) {
    await pool.query(
      'UPDATE rate_limit_hits SET hits = GREATEST(hits - 1, 0) WHERE key = $1 AND reset_at > NOW()',
      [this.prefix + key],
    );
  }

  async resetKey(key) {
    await pool.query('DELETE FROM rate_limit_hits WHERE key = $1', [this.prefix + key]);
  }
}

// Store option for rateLimit(): Postgres on Workers, default (memory) on Node.
function storeFor(prefix) {
  return process.env.RESOLVD_RUNTIME === 'workers' ? new PgRateLimitStore(prefix) : undefined;
}

async function purgeExpired() {
  await pool.query('DELETE FROM rate_limit_hits WHERE reset_at <= NOW()');
}

module.exports = { PgRateLimitStore, storeFor, purgeExpired };

const { pool } = require('../db/pool');

let _cache = null;
let _cacheAt = 0;
const TTL_MS = 60 * 1000;

async function getBranding() {
  if (_cache && Date.now() - _cacheAt < TTL_MS) return _cache;
  const result = await pool.query('SELECT * FROM branding WHERE id = 1');
  _cache = result.rows[0] || null;
  _cacheAt = Date.now();
  return _cache;
}

function invalidateBranding() {
  _cache = null;
  _cacheAt = 0;
}

module.exports = { getBranding, invalidateBranding };

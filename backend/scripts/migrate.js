// Apply the schema (idempotent) and exit. Docker runs this implicitly at
// boot (server.js); Cloudflare Workers deployments run it from CI or a
// workstation before `wrangler deploy`, since a Worker can't afford the
// full schema pass on every cold start.
//
//   DATABASE_URL=postgres://... npm run migrate
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { initSchema } = require('../db/schema');
const { pool } = require('../db/pool');

initSchema()
  .then(async () => {
    console.log('Schema up to date.');
    await pool.end();
  })
  .catch(async (err) => {
    console.error('Schema migration failed:', err);
    await pool.end().catch(() => {});
    process.exit(1);
  });

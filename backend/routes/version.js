// Build identity endpoint. Public (no auth) so a health probe or load
// balancer can read it, but contains no PII or secrets — just the
// values baked into the image at build time. Falls back to "dev" /
// "unknown" / null when the env wasn't supplied (local dev builds,
// `docker compose build` without the build-with-version.sh wrapper).

const express = require('express');

const router = express.Router();

router.get('/', (_req, res) => {
  res.json({
    version: process.env.APP_VERSION || 'dev',
    commit: process.env.APP_COMMIT || 'unknown',
    built_at: process.env.BUILT_AT || null,
  });
});

module.exports = router;

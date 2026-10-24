// Runs before anything else in the Worker bundle (imported first by
// index.js). Secrets and plain vars already land on process.env through
// nodejs_compat. Bindings like Hyperdrive are only readable inside a
// handler, so index.js passes those per request.
process.env.RESOLVD_RUNTIME = 'workers';

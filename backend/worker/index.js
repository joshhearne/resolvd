// Cloudflare Workers entry. Serves the Express app (same one Docker runs)
// through the Workers Node HTTP server bridge, and runs background jobs
// from the Cron Trigger. Static frontend assets are served by the
// Workers assets layer before this code runs; see wrangler.toml.
import './env.js';
import { httpServerHandler } from 'cloudflare:node';
import app from '../app.js';
import schedulers from '../services/schedulers.js';
import db from '../db/pool.js';
import storage from '../services/storage.js';

// Register outbound fetches with the request's scope so background work
// that's waiting on an HTTP call (Graph mail, web push, AI) isn't cut off
// once the response has gone out. See db/pool.js waitForIdle().
const rawFetch = globalThis.fetch;
globalThis.fetch = function fetch(...args) {
  return db.trackPending(rawFetch.apply(this, args));
};

const PORT = 8080;
app.listen(PORT);
const http = httpServerHandler({ port: PORT });

// Same proxy headers nginx sets in the Docker deployment: the real client
// IP (login security blocks by IP) and the original scheme (secure
// cookies). Overwritten, not appended, so clients can't spoof them.
function withProxyHeaders(request) {
  const headers = new Headers(request.headers);
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) {
    headers.set('x-forwarded-for', ip);
    headers.set('x-real-ip', ip);
  } else {
    headers.delete('x-forwarded-for');
    headers.delete('x-real-ip');
  }
  headers.set('x-forwarded-proto', new URL(request.url).protocol.replace(':', ''));
  return new Request(request, { headers });
}

export default {
  async fetch(request, env, ctx) {
    storage.useR2(env.UPLOADS);
    const { result, settled } = await db.withScopedPool(
      env.HYPERDRIVE.connectionString,
      () => http.fetch(withProxyHeaders(request), env, ctx),
    );
    ctx.waitUntil(settled);
    return result;
  },

  async scheduled(controller, env, ctx) {
    storage.useR2(env.UPLOADS);
    const { result, settled } = await db.withScopedPool(
      env.HYPERDRIVE.connectionString,
      () => schedulers.runCron(new Date(controller.scheduledTime)),
    );
    ctx.waitUntil(settled);
    console.log('cron', JSON.stringify(result));
  },
};

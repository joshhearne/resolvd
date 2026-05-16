// Client-side rate limiter for Action1 API calls. Action1 publishes
// a ~100 req/min per-tenant limit; without throttling a multi-org poll
// can blow through it mid-walk and lose alerts. We enforce two layers:
//
//   1. Token bucket keyed by baseUrl (tenant). Sliding 60s window with
//      MAX_PER_WINDOW slots. acquire() blocks until a slot frees.
//   2. 429 retry. If the server still says no (shared tenant, clock
//      skew, etc.), honor Retry-After and retry up to MAX_RETRIES.
//
// Single-process only — there's no cross-instance coordination. If we
// ever run multiple backend replicas hitting one tenant, lower
// MAX_PER_WINDOW accordingly or move the counter to Redis.

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 90;     // 10% headroom under the published 100/min cap
const MAX_RETRIES = 3;

const buckets = new Map();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function acquire(baseUrl) {
  let b = buckets.get(baseUrl);
  if (!b) { b = { timestamps: [] }; buckets.set(baseUrl, b); }
  for (;;) {
    const now = Date.now();
    while (b.timestamps.length && now - b.timestamps[0] >= WINDOW_MS) {
      b.timestamps.shift();
    }
    if (b.timestamps.length < MAX_PER_WINDOW) {
      b.timestamps.push(now);
      return;
    }
    // +25ms cushion so we don't re-check exactly at the boundary
    const wait = WINDOW_MS - (now - b.timestamps[0]) + 25;
    await sleep(wait);
  }
}

// Wrap an arbitrary fetch-returning thunk. Acquires a bucket slot,
// invokes the thunk, retries on 429 honoring Retry-After (seconds).
// Returns the final Response; caller still inspects .ok.
async function rateLimitedFetch(baseUrl, fetchFn) {
  let resp;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await acquire(baseUrl);
    resp = await fetchFn();
    if (resp.status !== 429) return resp;
    if (attempt === MAX_RETRIES) return resp;
    const ra = parseInt(resp.headers.get('retry-after') || '', 10);
    const waitMs = Number.isFinite(ra) && ra > 0
      ? ra * 1000
      : Math.min(30_000, 1000 * (2 ** attempt));
    await sleep(waitMs);
  }
  return resp;
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return url; }
}

module.exports = { acquire, rateLimitedFetch, originOf };

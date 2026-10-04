'use strict';
// Shared rate-limit storage.
//
// Audit finding H-4. Every limiter in this app used express-rate-limit's
// DEFAULT store, which is an in-process Map. That is correct for exactly one
// api container and quietly wrong for two: each replica keeps its own counters,
// so "30 login attempts per 15 minutes" becomes 30 x N for anyone who gets
// round-robined across instances. The protection does not fail loudly when the
// service scales out — it just silently weakens, which is the worst way for a
// brute-force control to break.
//
// Redis was already a hard dependency of this stack (BullMQ runs five queues
// through it, and the worker container cannot start without it), so this needs
// no new infrastructure — only a second consumer of the one already there.
//
// ── Why this degrades instead of failing ────────────────────────────────────
//
// redis.js is explicit that Redis is OPTIONAL: the app boots and works without
// it, just without retries and backoff. Rate limiting has to hold that same
// contract, in two places:
//
//   1. Not configured at all -> return undefined, and express-rate-limit uses
//      its in-memory store exactly as before. A single-container or local dev
//      setup is unaffected by any of this.
//   2. Configured but unreachable mid-request -> the caller pairs this store
//      with `passOnStoreError: true`, so a Redis blip lets the request through
//      rather than turning every API call into a 500.
//
// (2) is a deliberate trade. Failing OPEN briefly weakens the limiter; failing
// closed would take the whole API down whenever Redis hiccups. For a limiter
// that is a denial-of-service control rather than an authorization boundary,
// availability wins — and it is strictly better than the status quo, where the
// counters were per-process anyway.
//
// ── Why this uses the FAIL-FAST client ─────────────────────────────────────
//
// (2) did not work, for a reason that is invisible from here: the shared
// client is configured for BullMQ, with ioredis's offline queue on and
// `maxRetriesPerRequest: null`. A command issued while Redis is unreachable is
// therefore QUEUED, not rejected, and never abandoned — so `increment()` never
// settled, `passOnStoreError` never had an error to pass on, and every
// rate-limited route hung for the process lifetime rather than degrading.
//
// Measured with Redis stopped: /api/health answered (not rate limited) while
// every other route was gone. lib/redis.js getFailFastClient() refuses to
// queue, so the fallback this file was written around can actually happen.

const { RedisStore } = require('rate-limit-redis');
const redis = require('./redis');
const logger = require('./logger');

let warnedUnavailable = false;

/**
 * Build a store for one limiter.
 *
 * @param {string} prefix Namespace for this limiter's keys. MUST be unique per
 *   limiter — every limiter sharing a prefix would share one counter, so the
 *   login limiter would consume the general API budget and vice versa.
 * @returns {object|undefined} A RedisStore, or undefined to mean "use the
 *   default in-memory store".
 */
function makeStore(prefix) {
  if (!prefix || typeof prefix !== 'string') {
    throw new Error('makeStore(prefix) requires a unique string prefix');
  }

  if (!redis.isConfigured()) {
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      logger.warn(
        'Redis is not configured — rate limits are per-process. Correct for a '
        + 'single container; running more than one api replica this way multiplies '
        + 'every limit by the replica count.'
      );
    }
    return undefined;
  }

  // The FAIL-FAST client, not the shared BullMQ one. See the header: the
  // shared client queues commands during an outage instead of rejecting them,
  // so `passOnStoreError` could never fire and every limited route hung.
  const client = redis.getFailFastClient();
  const keyPrefix = `rl:${prefix}:`;

  // ── Why this returns a proxy instead of a RedisStore ──────────────────────
  //
  // `new RedisStore()` cannot be called here. rate-limit-redis@4.3.1 issues two
  // commands from its CONSTRUCTOR — `SCRIPT LOAD` for the increment script and
  // for the get script (dist/index.cjs:95-96) — and neither promise is awaited
  // nor caught. makeStore() runs at module load, and getFailFastClient() is
  // built with `lazyConnect: true` and `enableOfflineQueue: false`, so at that
  // moment the client is in `wait`: not connected, and refusing to queue.
  //
  // ioredis rejects a command issued while merely CONNECTING, not only while
  // down, so this was guaranteed rather than conditional — thirty unhandled
  // rejections on every deploy (fifteen stores x two), from a healthy Redis.
  // Measured against a live server: `wait` at construction, immediate
  // "Stream isn't writeable and enableOfflineQueue options is false", then
  // PONG on the same client two seconds later. That is the whole reason the
  // errors appeared in a burst at deploy and never again, with Redis up.
  //
  // Gating on `redis.isReady()` would be worse, not better: it reads the
  // SHARED client, which is also lazy, so it is `wait` at boot on a perfectly
  // healthy Redis — every limiter would fall back to per-process counters for
  // the life of the process. That is exactly the H-4 finding this file exists
  // to fix, reintroduced silently.
  //
  // So the store is built on FIRST USE, by which point Redis is ready. If it
  // genuinely is not, the failure now lands inside increment() — which
  // express-rate-limit already handles via `passOnStoreError: true` — instead
  // of escaping as an unhandled rejection at import time.
  //
  // Every limit, key and policy is untouched: this changes WHEN the client is
  // first spoken to, not what is sent. `prefix` is exposed because two limiters
  // sharing a key space share a budget, and callers read it.
  let limiterOptions = null;
  let store = null;

  const real = () => {
    if (!store) {
      store = new RedisStore({
        prefix: keyPrefix,
        // ioredis speaks `call(command, ...args)`. rate-limit-redis hands us the
        // command and its arguments already split, so this is a straight forward.
        sendCommand: (...args) => client.call(...args),
      });
      // RedisStore.init() is the only thing that sets `windowMs`, and its own
      // increment() reads it — so this must happen before the first call, or
      // the Lua script receives `undefined` and the limiter breaks silently.
      if (limiterOptions) store.init(limiterOptions);
    }
    return store;
  };

  return {
    prefix: keyPrefix,
    // Called by express-rate-limit once, at limiter creation — which is module
    // load, and therefore still too early to build anything.
    init(options) { limiterOptions = options; },
    get: (key) => real().get(key),
    increment: (key) => real().increment(key),
    decrement: (key) => real().decrement(key),
    resetKey: (key) => real().resetKey(key),
  };
}

module.exports = { makeStore };

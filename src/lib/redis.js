// src/lib/redis.js
// Single source of truth for every Redis connection in this process.
//
// BullMQ needs `maxRetriesPerRequest: null` (blocking commands must never be
// retried by the driver, BullMQ owns retries), so that option lives on the
// one client factory here rather than being re-argued at every call site.
//
// One shared, lazily-connected client is used by:
//   - the /api/health check (ping)
//   - every BullMQ *producer* Queue in the API process (non-blocking commands)
//
// BullMQ *workers* get their own client via getWorkerConnection(): a consumer
// issues blocking commands (BZPOPMIN) that would stall a shared connection and
// starve every other user of it. One extra connection per worker is required
// by the protocol, not duplication — they all still derive from the same
// options object below.

const Redis = require('ioredis');
const logger = require('./logger');

const DEFAULT_HOST = 'redis';

// ioredis v6 removed Redis.parseURL(), so REDIS_URL is parsed here with the
// WHATWG URL parser. Handles redis://, rediss:// (TLS) and the optional
// [:password@]host[:port][/db] parts. Usernames are ignored (ioredis uses the
// password field alone; if REDIS_USERNAME is set it is passed through below).
function parseRedisUrl(raw) {
  try {
    const u = new URL(raw);
    const db = u.pathname && u.pathname.length > 1 ? Number(u.pathname.slice(1)) : undefined;
    return {
      scheme: u.protocol.replace(':', ''),
      hostname: u.hostname || undefined,
      port: u.port ? Number(u.port) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
      db: Number.isFinite(db) ? db : undefined,
    };
  } catch {
    return null;
  }
}

function resolveOptions(env = process.env) {
  const url = env.REDIS_URL;
  const base = {
    host: env.REDIS_HOST || DEFAULT_HOST,
    port: Number(env.REDIS_PORT ?? 6379) || 6379,
  };
  // A connection string wins when present; host/port still fall back above
  // so a bare REDIS_URL never leaves host/port undefined.
  const parsed = url ? parseRedisUrl(url) : null;

  const options = {
    ...base,
    host: parsed?.hostname || base.host,
    port: parsed?.port || base.port,
    username: env.REDIS_USERNAME || undefined,
    password: parsed?.password || env.REDIS_PASSWORD || undefined,
    db: parsed?.db ?? (env.REDIS_DB ? Number(env.REDIS_DB) : 0),
    // Required by BullMQ: the driver must not cap retries on blocking
    // commands; queue-level retry/backoff is BullMQ's job.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    // Never connect at import time — a deploy without Redis must boot (and
    // fall back to inline sends / degraded health) rather than hang.
    lazyConnect: true,
    // TLS for managed Redis providers (Upstash, Render Redis, ElastiCache).
    // REDIS_TLS=1 forces it; REDIS_URL of scheme rediss:// implies it.
    tls: (parsed && parsed.scheme === 'rediss') || env.REDIS_TLS === '1'
      ? {}
      : undefined,
  };

  return {
    options,
    configured:
      Boolean(url) ||
      Boolean(env.REDIS_HOST) ||
      Boolean(env.REDIS_PORT) ||
      Boolean(env.REDIS_PASSWORD) ||
      Boolean(env.REDIS_USERNAME) ||
      Boolean(env.REDIS_TLS),
  };
}

const { options: redisOptions, configured: _configured } = resolveOptions();

let redisClient;

function createRedisClient() {
  const client = new Redis(redisOptions);

  client.on('connect', () => {
    logger.info({ host: redisOptions.host, port: redisOptions.port }, 'Redis connected');
  });

  client.on('ready', () => {
    logger.info({ host: redisOptions.host, port: redisOptions.port }, 'Redis ready');
  });

  client.on('error', (err) => {
    logger.error({ err, host: redisOptions.host, port: redisOptions.port }, 'Redis error');
  });

  client.on('close', () => {
    logger.warn({ host: redisOptions.host, port: redisOptions.port }, 'Redis connection closed');
  });

  return client;
}

function getRedisClient() {
  if (!redisClient) {
    redisClient = createRedisClient();
  }
  return redisClient;
}

/**
 * The shared producer connection. Safe to pass to every BullMQ Queue in this
 * process: producers only ever issue non-blocking commands.
 */
function getConnection() {
  return getRedisClient();
}

/**
 * A dedicated client for a BullMQ Worker. Workers issue blocking commands and
 * MUST NOT share a connection with anything else in the process.
 */
function getWorkerConnection() {
  return createRedisClient();
}

// ── The fail-fast client, and the outage it exists to survive ───────────────
//
// The shared client above is configured for BullMQ, and correctly so:
// `maxRetriesPerRequest: null` because a blocking command must never be capped,
// and ioredis's `enableOfflineQueue` left at its default `true` so a command
// issued during a blip is held and sent on reconnect rather than lost.
//
// For a QUEUE that is right. For anything on a request path it is a trap, and
// the two together make it worse: a command issued while Redis is unreachable
// is queued rather than rejected, and with retries uncapped it is never
// abandoned. It does not fail. It waits — for the process lifetime.
//
// Measured, with Redis stopped and REDIS_URL still set: every rate-limited
// route hung indefinitely. Not slow, not 500 — no response at all. The rate
// limiter's store is deliberately paired with `passOnStoreError: true` so a
// Redis fault lets the request through, and that fallback could never fire,
// because there was no error to pass on. The API's own /api/health answered
// (it is not rate limited) while every other route was gone, which is the
// worst possible shape: a health check that says the process is alive while
// the API is unreachable.
//
// So callers on a request path get their own connection that refuses to queue:
// a command issued while disconnected rejects immediately, and a connection
// that is up but unresponsive is bounded by commandTimeout. Now the degraded
// paths that were written to handle an error actually receive one.
const FAIL_FAST_COMMAND_TIMEOUT_MS =
  Number(process.env.REDIS_COMMAND_TIMEOUT_MS) || 1000;

let failFastClient;

/**
 * A client for request-path consumers: rate limiting, the Command Center's
 * coordination primitives, anything where a hung request is worse than a
 * missing answer.
 *
 * NOT for BullMQ. Queues need the offline queue and uncapped retries.
 */
function getFailFastClient() {
  if (!failFastClient) {
    failFastClient = new Redis({
      ...redisOptions,
      // The whole point. Reject instead of queueing when disconnected.
      enableOfflineQueue: false,
      // Bounded rather than null: nothing on this client blocks.
      maxRetriesPerRequest: 1,
      // Guards the other shape — connected, but not answering.
      commandTimeout: FAIL_FAST_COMMAND_TIMEOUT_MS,
    });
    // Errors here are expected during an outage and are handled by each
    // caller's own fallback. Without a listener, ioredis emits them as
    // unhandled 'error' events and takes the process down.
    failFastClient.on('error', (err) => {
      logger.debug({ err: err.message }, 'fail-fast redis client error (handled by caller fallback)');
    });
  }
  return failFastClient;
}

/**
 * True when the shared client is actually connected (status === 'ready').
 * Producers use this to decide queue-vs-inline: never enqueue into a dead
 * Redis — fall back to the synchronous path instead.
 */
function isReady() {
  return getRedisClient().status === 'ready';
}

/** True when Redis was explicitly configured via the environment. */
function isConfigured() {
  return _configured;
}

/**
 * Bring the shared client to a usable state when Redis is configured:
 * connects if idle and waits up to `timeoutMs` for 'ready'. Returns false when
 * Redis is not configured, or the connection cannot be established in time —
 * producers use that to fall back to inline delivery rather than hang or
 * throw. Bounded by design: an unreachable Redis must cost a little latency,
 * never the request. Connection-refused fails fast; the timeout only bites
 * when the host is unreachable enough to hang.
 */
async function ensureReady(timeoutMs = 2000) {
  if (!isConfigured()) return false;
  const client = getRedisClient();
  if (client.status === 'ready') return true;
  // ioredis auto-reconnects from 'close'/'end' itself; while it is doing so
  // there is nothing to wait for that won't hang, so producers degrade inline.
  if (client.status === 'close' || client.status === 'end') return false;
  try {
    if (client.status !== 'connecting' && client.status !== 'connect') {
      await client.connect();
    }
    if (client.status === 'ready') return true;
    await Promise.race([
      new Promise((resolve, reject) => {
        client.once('ready', resolve);
        client.once('error', reject);
      }),
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error('redis connect timeout')), timeoutMs);
        if (typeof t.unref === 'function') t.unref();
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Bounded ping so a health probe can never hang on an unreachable Redis
 * (a bare client.ping() waits indefinitely while the driver retries).
 */
async function ping(timeoutMs = 5000) {
  if (!(await ensureReady(timeoutMs))) throw new Error('redis unavailable');
  return getRedisClient().ping();
}

/** Close the shared client (used by graceful shutdown). */
async function close() {
  if (failFastClient) {
    const f = failFastClient;
    failFastClient = undefined;
    try { await f.quit(); } catch { f.disconnect(); }
  }
  if (!redisClient) return;
  const c = redisClient;
  redisClient = undefined;
  try {
    await c.quit();
  } catch (err) {
    logger.warn({ err: err.message }, 'Redis close failed');
    c.disconnect();
  }
}

module.exports = {
  getClient: getRedisClient,
  ping,
  ensureReady,
  isReady,
  isConfigured,
  getConnection,
  getWorkerConnection,
  getFailFastClient,
  FAIL_FAST_COMMAND_TIMEOUT_MS,
  close,
  redisOptions,
};

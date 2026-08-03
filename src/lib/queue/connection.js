'use strict';

/**
 * The Redis connections, and the only place they are made.
 *
 * ── There was no Redis before this ─────────────────────────────────────────
 *
 * Nothing in this project connected to Redis: no dependency, no config, no
 * REDIS_* variable in .env.example, render.yaml or the Dockerfile. BullMQ
 * requires one, so queueing is a NEW infrastructure dependency here rather
 * than a reuse of an existing one. That is worth stating plainly, because it
 * is the difference between "add a library" and "add a server that must be
 * running for the feature to work".
 *
 * ── One connection per role, and no more ───────────────────────────────────
 *
 * BullMQ cannot share a single connection between producers and workers, and
 * this is not a style preference: a Worker issues BZPOPMIN/BRPOPLPUSH, which
 * block the entire connection until they return. A Queue sharing that
 * connection would hang behind them. ioredis also requires
 * maxRetriesPerRequest: null on a worker connection or BullMQ refuses to
 * start.
 *
 * So this module hands out exactly two, both memoised:
 *
 *   producer() — every Queue and every QueueEvents reader shares this one.
 *   worker()   — the base connection every Worker is constructed from.
 *
 * What that adds up to, measured against a real Redis rather than assumed:
 *
 *   4 Queues, no workers ....... 1 connection
 *   + 4 Workers ................ 6 connections
 *
 * The four Queues genuinely share one socket. The Workers do not: BullMQ uses
 * the connection it is given for bookkeeping and DUPLICATES it once per
 * Worker for the blocking commands, because two workers cannot both sit in
 * BZPOPMIN on the same socket. That duplication is BullMQ's, it is
 * unavoidable, and it is the correct behaviour — a "shared" worker connection
 * would mean the queues consumed one at a time.
 *
 * So "no duplicate connections" here means: nothing in this application
 * constructs a client of its own. This file is the only place that calls into
 * ioredis at all, and queue.test.js asserts that by scanning every source
 * file for `new IORedis` and `require('ioredis')`.
 *
 * ── Absent Redis is a supported state ──────────────────────────────────────
 *
 * REDIS_URL unset means "no queue", not "broken". Every caller falls back to
 * running the work inline, exactly as it did before this module existed. This
 * is not defensive padding: Redis is not deployed yet, the deploy pipeline is
 * currently failing on unset secrets, and a version of this that required
 * Redis would take the API down the moment it did deploy.
 */

const logger = require('../logger');

/** Unset means no queue. Never a default localhost — see isEnabled(). */
const REDIS_URL = process.env.REDIS_URL || '';

/**
 * Whether queueing is available at all.
 *
 * Deliberately NOT defaulting to redis://localhost:6379. A default would make
 * every enqueue in production retry against a host that is not there, turning
 * a clean "queueing is off" into a slow failure on every call — and it would
 * hide a missing variable behind a connection error at 3am rather than a log
 * line at boot.
 */
function isEnabled() {
  return Boolean(REDIS_URL);
}

let producerConn = null;
let workerConn = null;

/**
 * Options shared by both roles.
 *
 * family: 4 for the same reason lib/email.js pins it — a managed Redis with
 * an AAAA record on an IPv4-only host fails with ENETUNREACH and an error
 * message that blames the port. Overridable, because a genuinely IPv6-only
 * network exists and this must not be the thing that breaks it.
 */
function baseOptions() {
  const opts = {
    // Pinned by the URL's own scheme rather than a separate flag: rediss://
    // is the only correct way to say "TLS" here, and a boolean that disagrees
    // with the scheme is a support ticket.
    lazyConnect: false,
    enableOfflineQueue: true,
    connectTimeout: parseInt(process.env.REDIS_CONNECT_TIMEOUT_MS, 10) || 10_000,
  };
  if (process.env.REDIS_FAMILY !== '6') opts.family = 4;
  return opts;
}

function build(role, extra) {
  // Required lazily so a process that never queues never loads ioredis, and
  // so the test suite can run without the module installed.
  const IORedis = require('ioredis');
  const conn = new IORedis(REDIS_URL, { ...baseOptions(), ...extra });

  // Logged, not thrown. A Redis blip must degrade the queue, never take the
  // API process down with it — ioredis reconnects on its own, and an
  // unhandled 'error' event on an EventEmitter is an uncaught exception.
  conn.on('error', (err) => {
    logger.warn({ role, err: err.message, code: err.code }, 'redis connection error');
  });
  conn.on('end', () => logger.warn({ role }, 'redis connection closed'));
  conn.on('ready', () => logger.info({ role }, 'redis connected'));
  return conn;
}

/** Shared by every Queue and QueueEvents instance in this process. */
function producer() {
  if (!isEnabled()) return null;
  if (!producerConn) producerConn = build('producer', {});
  return producerConn;
}

/**
 * Shared by every Worker in this process.
 *
 * maxRetriesPerRequest: null is mandatory — BullMQ throws at construction
 * without it, because a worker's blocking commands must not be abandoned
 * mid-wait by ioredis's own retry counter.
 */
function worker() {
  if (!isEnabled()) return null;
  if (!workerConn) workerConn = build('worker', { maxRetriesPerRequest: null });
  return workerConn;
}

/**
 * Close whichever connections this process opened.
 *
 * quit() rather than disconnect(): it finishes the command in flight and
 * sends QUIT, so a job being acknowledged as this runs is still acknowledged.
 * Never rejects — shutdown must not fail because cleanup did.
 */
async function close() {
  const conns = [producerConn, workerConn].filter(Boolean);
  producerConn = null;
  workerConn = null;
  await Promise.all(conns.map((c) => c.quit().catch(() => c.disconnect())));
}

/** For the health endpoint: reachable, and how long the round trip took. */
async function ping() {
  if (!isEnabled()) return { ok: false, reason: 'REDIS_NOT_CONFIGURED' };
  try {
    const started = Date.now();
    await producer().ping();
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, reason: err.code || 'ERROR', message: err.message };
  }
}

module.exports = { isEnabled, producer, worker, close, ping, REDIS_URL };

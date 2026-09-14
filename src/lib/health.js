// src/lib/health.js
//
// The ORCHESTRATOR's health probe. Not the Command Center's.
//
// ── Why these two are deliberately separate ────────────────────────────────
//
// This answers /api/health: unauthenticated, called every few seconds by
// Docker's HEALTHCHECK, nginx and any load balancer in front of the API. It
// has one job — is this container still worth routing traffic to — and it must
// answer in single-digit milliseconds even when everything behind it is on
// fire, because a probe that hangs is read as a dead container and restarted.
//
// modules/command-center/snapshot.service.js answers a different question for
// a different caller: what is the state of the whole platform, graded, cached,
// with coverage, for an authenticated operator looking at a console.
//
// They are NOT a duplicated health calculation, and collapsing them would be a
// mistake in both directions: routing this through the collector registry
// would make a liveness check expensive enough to cause restart loops during
// the exact incident it exists to survive, and routing the console through
// this would throw away every grade, threshold and reason the cards carry.
//
// `/api/platform/system-health` WAS a genuine third opinion, and is now a
// projection of the snapshot. This one stays.
//
// ── It must never hang ─────────────────────────────────────────────────────
//
// redis.ping() is bounded by ensureReady()'s own timeout rather than the bare
// client call. That matters more than it looks: the shared Redis client keeps
// ioredis's offline queue, so an unbounded command issued during an outage
// waits for the process lifetime rather than failing. Measured with Redis
// stopped: this endpoint answered 503 in 4ms while every rate-limited route
// was hung — see lib/redis.js getFailFastClient() for that fix.

const pool = require('../db/pool');
const redis = require('./redis');

async function getHealthPayload() {
  let dbState = 'disconnected';
  let redisState = 'disconnected';
  let errorMessage = null;

  try {
    await pool.query('SELECT 1');
    dbState = 'connected';
  } catch (err) {
    errorMessage = err.message;
  }

  try {
    await redis.ping();
    redisState = 'connected';
  } catch (err) {
    if (!errorMessage) {
      errorMessage = err.message;
    }
  }

  // Queue snapshot — defensive by construction (collectQueueStats never
  // throws): a down queue must appear as a health field, not as a probe that
  // crashes. Only meaningful when Redis is actually reachable.
  let queues = null;
  if (redisState === 'connected') {
    try {
      const { collectQueueStats, summarize } = require('./queueHealth');
      queues = summarize(await collectQueueStats());
    } catch (err) {
      queues = { status: 'unknown', detail: err.message };
    }
  }

  if (dbState === 'connected' && redisState === 'connected') {
    return {
      status: 'ok',
      version: 'v3',
      time: new Date().toISOString(),
      db: 'connected',
      redis: 'connected',
      queues,
    };
  }

  return {
    status: 'error',
    db: dbState,
    redis: redisState,
    queues,
    error: errorMessage,
  };
}

async function sendHealthResponse(req, res) {
  const payload = await getHealthPayload();

  if (payload.status === 'ok') {
    return res.json(payload);
  }

  return res.status(503).json(payload);
}

module.exports = {
  getHealthPayload,
  sendHealthResponse,
};

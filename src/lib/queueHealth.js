// src/lib/queueHealth.js
// Shared queue-monitoring helpers for health probes and the super-admin
// /system-health dashboard.
//
// Every function here is defensive: an unhealthy queue must show up as a
// red/amber health field, never as a thrown error that makes the whole probe
// 500. Wrap each in try/catch at the call site (or use collectQueueStats,
// which does it for you).

const { QUEUE_NAMES } = require('../jobs/queue');
const logger = require('./logger');

// BullMQ commands on a client whose Redis is unreachable sit in the offline
// queue and never resolve (maxRetriesPerRequest: null). Every probe below is
// therefore raced against a timeout so a down queue shows as unhealthy rather
// than hanging the health endpoint or a test suite.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error(`queue health timeout: ${label}`)), ms);
      if (typeof t.unref === 'function') t.unref();
    }),
  ]);
}

/**
 * Snapshot one queue. Returns null (and logs) if the queue cannot be reached
 * — the caller treats that as unhealthy rather than crashing.
 */
async function queueStats(name) {
  try {
    const { getQueue } = require('../jobs/queue');
    const queue = getQueue(name);
    const [waiting, active, delayed, completed, failed, paused] = await Promise.all([
      withTimeout(queue.getWaitingCount(), 2000, name),
      withTimeout(queue.getActiveCount(), 2000, name),
      withTimeout(queue.getDelayedCount(), 2000, name),
      withTimeout(queue.getCompletedCount(), 2000, name),
      withTimeout(queue.getFailedCount(), 2000, name),
      withTimeout(queue.isPaused(), 2000, name),
    ]);
    return {
      name,
      waiting,
      active,
      delayed,
      completed,
      failed,
      paused,
      // Work nobody has picked up. Delayed jobs are scheduled (cron), not
      // backlog; counting them made every healthy scheduler look degraded.
      backlog: waiting,
    };
  } catch (err) {
    logger.error({ err: err.message, queue: name }, 'queue_stats_failed');
    return null;
  }
}

/**
 * Snapshot every queue in parallel. Unreachable queues stay in the result as
 * `null` so summarize() can report them; filtering them out here was how a
 * queue that failed to answer disappeared from the health payload entirely.
 * When Redis is not configured there is nothing to monitor, so it
 * short-circuits instead of waiting on connections that will never happen.
 */
async function collectQueueStats() {
  const redis = require('./redis');
  if (!redis.isConfigured()) return [];
  return Promise.all(QUEUE_NAMES.map(queueStats));
}

/** Human-readable summary for a health payload. */
function summarize(stats) {
  if (!Array.isArray(stats) || stats.length === 0) {
    return { status: 'unknown', detail: 'queues unreachable' };
  }

  const reachable = stats.filter(Boolean);
  const unreachable = stats.length - reachable.length;
  const sum = (key) => reachable.reduce((n, s) => n + (s[key] || 0), 0);

  // ── Backlog is work nobody has picked up ────────────────────────────────
  //
  // `delayed` is not backlog. Every cron/scheduler queue keeps one or more
  // delayed jobs parked between runs, so counting them made a healthy box
  // permanently "degraded" (production: 11 delayed, 0 waiting, yet degraded).
  const waiting = sum('waiting');
  const active = sum('active');
  const delayed = sum('delayed');
  const failed = sum('failed');
  const completed = sum('completed');

  // A queue is degraded when something is actually wrong: work is waiting
  // with nothing draining it, a job failed, or a queue could not be reached.
  // An idle system, or one with only scheduled jobs, is healthy.
  const starved = reachable.some((s) => (s.waiting || 0) > 0 && (s.active || 0) === 0 && !s.paused);
  const status = unreachable > 0 || failed > 0 || starved ? 'degraded' : 'healthy';

  return {
    status,
    queues: stats.length,
    unreachable,
    backlog: waiting,
    waiting,
    active,
    delayed,
    failed,
    // ── Liveness, not backlog ───────────────────────────────────────────
    //
    // Everything else here comes from BullMQ's Redis counters, which answer
    // "is work queued" and never "is anything working it". A process with no
    // worker at all reads exactly like an idle one: waiting 0, active 0.
    //
    // Completed jobs are retained for 24h (jobs/queue.js removeOnComplete),
    // so a non-zero count here is the one field that proves a worker actually
    // drained something recently. Zero is not a verdict on its own — a quiet
    // hour looks the same — but zero completed WITH a non-zero waiting count
    // is a dead worker, and before this field there was no way to ask.
    completed,
    counts: reachable.reduce((acc, s) => {
      acc[s.name] = { waiting: s.waiting, active: s.active, delayed: s.delayed, completed: s.completed, failed: s.failed, paused: s.paused };
      return acc;
    }, {}),
  };
}

module.exports = { queueStats, collectQueueStats, summarize, QUEUE_NAMES };

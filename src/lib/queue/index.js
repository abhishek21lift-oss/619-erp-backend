'use strict';

/**
 * The queues, and the one way to put work on them.
 *
 * ── Why enqueue() takes the inline function too ────────────────────────────
 *
 * Every call site here already worked before there was a queue: email sent
 * inline with its own retry, AI ingestion ran fire-and-forget, the renewal
 * sweep ran on an interval. The queue is an improvement on where that work
 * runs, not a change to whether it happens.
 *
 * So enqueue() is given both the job and the function that does it, and runs
 * the function directly whenever the queue cannot take it — REDIS_URL unset,
 * Redis unreachable, the add() rejected. The caller's behaviour is identical
 * in both cases; only the timing and the retry budget differ. That is what
 * keeps every existing endpoint compatible, and it is what makes this safe to
 * deploy before Redis exists, which right now it does not.
 *
 * The fallback is a real code path, not a nicety: it is what runs in every
 * test, in local development, and in production until a Redis service is
 * added to the compose file on the VPS.
 *
 * ── Retry policy ───────────────────────────────────────────────────────────
 *
 * Exponential backoff, per queue, tuned to what the failure usually is:
 *
 *   email     5 attempts from 5s  — SMTP blips and greylisting resolve in
 *                                   minutes; lib/email.js also retries inside
 *                                   one attempt, so this is the outer loop.
 *   whatsapp  5 attempts from 10s — a third-party HTTP API with rate limits.
 *   ai        3 attempts from 30s — embedding a PDF is expensive; retrying it
 *                                   quickly three times is how one bad upload
 *                                   becomes an hour of CPU.
 *   renewal   3 attempts from 60s — touches money. Slow and few.
 *
 * Completed jobs are trimmed by count and age so a queue cannot grow without
 * bound; failed jobs are kept far longer, because a failed job nobody can
 * read is the same as no queue at all.
 */

const logger = require('../logger');
const connection = require('./connection');

/** Queue names. Exported so workers and the health endpoint cannot drift. */
const QUEUES = {
  EMAIL: 'email',
  WHATSAPP: 'whatsapp',
  AI: 'ai',
  RENEWAL: 'renewal',
};

const int = (name, fallback) => parseInt(process.env[name], 10) || fallback;

/** Per-queue job options. Every number is overridable by environment. */
const JOB_OPTIONS = {
  [QUEUES.EMAIL]: {
    attempts: int('QUEUE_EMAIL_ATTEMPTS', 5),
    backoff: { type: 'exponential', delay: int('QUEUE_EMAIL_BACKOFF_MS', 5_000) },
  },
  [QUEUES.WHATSAPP]: {
    attempts: int('QUEUE_WHATSAPP_ATTEMPTS', 5),
    backoff: { type: 'exponential', delay: int('QUEUE_WHATSAPP_BACKOFF_MS', 10_000) },
  },
  [QUEUES.AI]: {
    attempts: int('QUEUE_AI_ATTEMPTS', 3),
    backoff: { type: 'exponential', delay: int('QUEUE_AI_BACKOFF_MS', 30_000) },
  },
  [QUEUES.RENEWAL]: {
    attempts: int('QUEUE_RENEWAL_ATTEMPTS', 3),
    backoff: { type: 'exponential', delay: int('QUEUE_RENEWAL_BACKOFF_MS', 60_000) },
  },
};

/** Shared by all four. Keeps Redis from growing without bound. */
const RETENTION = {
  removeOnComplete: {
    count: int('QUEUE_KEEP_COMPLETED', 500),
    age: int('QUEUE_KEEP_COMPLETED_AGE_S', 24 * 60 * 60),
  },
  removeOnFail: {
    count: int('QUEUE_KEEP_FAILED', 5_000),
    age: int('QUEUE_KEEP_FAILED_AGE_S', 14 * 24 * 60 * 60),
  },
};

const instances = new Map();

/**
 * The Queue for a name, or null when queueing is off.
 *
 * Memoised per name: a second Queue object for the same name would open no
 * new connection (they share the producer) but would duplicate its event
 * listeners, which is how a "why did this log twice" afternoon starts.
 */
function getQueue(name) {
  if (!connection.isEnabled()) return null;
  if (instances.has(name)) return instances.get(name);

  const { Queue } = require('bullmq');
  const q = new Queue(name, {
    connection: connection.producer(),
    prefix: process.env.QUEUE_PREFIX || 'myptstudio',
    defaultJobOptions: { ...JOB_OPTIONS[name], ...RETENTION },
  });
  q.on('error', (err) => logger.warn({ queue: name, err: err.message }, 'queue error'));
  instances.set(name, q);
  return q;
}

/**
 * Put work on a queue, or do it here if there is no queue.
 *
 * @param {string} queueName   one of QUEUES
 * @param {string} jobName     what this job is, for logs and the dashboard
 * @param {object} data        must be JSON-serialisable — it goes to Redis
 * @param {Function} inline    the same work, run here when the queue cannot
 * @param {object} [opts]      per-job overrides (delay, jobId, priority)
 * @returns {Promise<{queued: boolean, jobId?: string, result?: unknown}>}
 */
async function enqueue(queueName, jobName, data, inline, opts = {}) {
  const q = getQueue(queueName);

  if (q) {
    try {
      const job = await q.add(jobName, data, opts);
      logger.info({ queue: queueName, job: jobName, jobId: job.id }, 'job queued');
      return { queued: true, jobId: String(job.id) };
    } catch (err) {
      // Redis went away between isEnabled() and add(). Falling through to
      // inline is the whole point: the alternative is losing the work.
      logger.warn(
        { queue: queueName, job: jobName, err: err.message },
        'enqueue failed — running inline instead'
      );
    }
  }

  if (typeof inline !== 'function') {
    // A job with no inline equivalent cannot be silently dropped.
    throw new Error(`No queue available for ${queueName}/${jobName} and no inline fallback given`);
  }
  const result = await inline();
  return { queued: false, result };
}

/**
 * Counts per state, for the health endpoint.
 *
 * Never throws: this is read by a monitoring endpoint, and an endpoint that
 * 500s when Redis is down tells you less than one that says Redis is down.
 */
async function counts(name) {
  const q = getQueue(name);
  if (!q) return { name, enabled: false };
  try {
    const c = await q.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused');
    return { name, enabled: true, paused: await q.isPaused(), ...c };
  } catch (err) {
    return { name, enabled: true, error: err.message };
  }
}

/** Close every Queue this process opened, then the connections. */
async function close() {
  const open = [...instances.values()];
  instances.clear();
  await Promise.all(open.map((q) => q.close().catch(() => {})));
  await connection.close();
}

module.exports = { QUEUES, JOB_OPTIONS, RETENTION, getQueue, enqueue, counts, close };

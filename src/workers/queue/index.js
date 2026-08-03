'use strict';

/**
 * The worker process: consumes all four queues, and stops cleanly.
 *
 *   npm run queue:worker
 *
 * ── Separate process, not in-process ───────────────────────────────────────
 *
 * Workers do not run inside the API by default. Embedding a PDF pins a core
 * for tens of seconds, and doing that in the process serving requests is how
 * a single upload degrades every studio's dashboard at once. WORKER_INLINE=on
 * exists for a single-container deploy that cannot run a second service, and
 * is off by default because it trades isolation for one less container.
 *
 * ── Graceful shutdown ──────────────────────────────────────────────────────
 *
 * The API already handled SIGTERM by closing the server and the pg pool. A
 * worker has a harder job: it may be halfway through charging a card when the
 * signal arrives.
 *
 * worker.close() stops it taking NEW jobs and waits for the ones in flight,
 * so a renewal completes rather than being abandoned and retried against a
 * card that was already charged. The wait is bounded — Docker sends SIGKILL
 * ten seconds after SIGTERM by default, and a shutdown that outlives that is
 * a shutdown that did not happen. On timeout the connection is closed anyway
 * and the job returns to the queue: at-least-once is the contract, which is
 * why every handler is idempotent.
 */

const logger = require('../../lib/logger');
const connection = require('../../lib/queue/connection');
const { QUEUES, JOB_OPTIONS } = require('../../lib/queue');
const handlers = require('./handlers');

const int = (name, fallback) => parseInt(process.env[name], 10) || fallback;

/**
 * How many jobs each queue runs at once.
 *
 * AI is 1 by design: embedding is CPU-bound on this box, and running four in
 * parallel makes all four slow rather than any of them fast. Renewal is 1
 * because it charges cards and a serialised money path is easier to reason
 * about than a fast one.
 */
const CONCURRENCY = {
  [QUEUES.EMAIL]: int('QUEUE_EMAIL_CONCURRENCY', 5),
  [QUEUES.WHATSAPP]: int('QUEUE_WHATSAPP_CONCURRENCY', 5),
  [QUEUES.AI]: int('QUEUE_AI_CONCURRENCY', 1),
  [QUEUES.RENEWAL]: int('QUEUE_RENEWAL_CONCURRENCY', 1),
};

const started = [];

/** Build one Worker, with the logging every job gets. */
function startWorker(name, handler) {
  const { Worker } = require('bullmq');
  const w = new Worker(
    name,
    async (job) => {
      const t0 = Date.now();
      logger.info({ queue: name, job: job.name, jobId: job.id, attempt: job.attemptsMade + 1 },
        'job started');
      const out = await handler(job.data);
      logger.info({ queue: name, job: job.name, jobId: job.id, ms: Date.now() - t0 },
        'job completed');
      return out;
    },
    {
      connection: connection.worker(),
      prefix: process.env.QUEUE_PREFIX || 'myptstudio',
      concurrency: CONCURRENCY[name],
    }
  );

  w.on('failed', (job, err) => {
    const attempts = JOB_OPTIONS[name]?.attempts ?? 1;
    const made = job?.attemptsMade ?? 0;
    // Distinguished because they mean different things to whoever is on call:
    // one is "it will try again", the other is "this will never be delivered".
    logger[made >= attempts ? 'error' : 'warn'](
      { queue: name, job: job?.name, jobId: job?.id, attempt: made, of: attempts, err: err?.message },
      made >= attempts ? 'job failed permanently' : 'job failed — will retry'
    );
  });
  w.on('error', (err) => logger.warn({ queue: name, err: err.message }, 'worker error'));

  started.push(w);
  return w;
}

/** Start all four. Returns the workers so a caller can await shutdown. */
function startAll() {
  if (!connection.isEnabled()) {
    logger.warn('REDIS_URL is not set — queue workers not started. '
      + 'Email, WhatsApp, AI ingestion and renewals run inline, as they did before.');
    return [];
  }
  startWorker(QUEUES.EMAIL, handlers.email);
  startWorker(QUEUES.WHATSAPP, handlers.whatsapp);
  startWorker(QUEUES.AI, handlers.ai);
  startWorker(QUEUES.RENEWAL, handlers.renewal);
  logger.info({ queues: Object.values(QUEUES), concurrency: CONCURRENCY }, 'queue workers started');
  return started;
}

/**
 * Stop taking new jobs, finish the ones in flight, close the connections.
 *
 * Bounded by QUEUE_SHUTDOWN_TIMEOUT_MS, default 8s — under Docker's 10s
 * SIGTERM-to-SIGKILL window, so this finishes on its own terms rather than
 * being killed mid-close.
 */
async function stopAll() {
  const timeoutMs = int('QUEUE_SHUTDOWN_TIMEOUT_MS', 8_000);
  const workers = started.splice(0);
  if (!workers.length) return;

  logger.info({ count: workers.length, timeoutMs }, 'draining queue workers');
  const drained = Promise.all(workers.map((w) => w.close().catch(() => {})));
  const timedOut = await Promise.race([
    drained.then(() => false),
    new Promise((r) => setTimeout(() => r(true), timeoutMs)),
  ]);
  if (timedOut) {
    logger.warn('worker drain timed out — in-flight jobs return to the queue for retry');
  }
  await connection.close();
}

if (require.main === module) {
  startAll();
  // Both signals: SIGTERM is Docker stopping the container, SIGINT is a
  // person pressing Ctrl-C. Neither should abandon a job mid-charge.
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      logger.info({ signal: sig }, 'worker received signal — shutting down');
      stopAll()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
  }
  process.on('unhandledRejection', (reason) => logger.error({ reason }, 'worker unhandledRejection'));
}

module.exports = { startAll, stopAll, startWorker, CONCURRENCY };

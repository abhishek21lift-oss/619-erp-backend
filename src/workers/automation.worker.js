// src/workers/automation.worker.js
// The clock behind the six date-driven automation events.
//
// Six of the twelve trigger events a studio can select — expiring and expired
// memberships, birthdays, joining anniversaries, missed attendance and overdue
// lead follow-ups — are not caused by anything a person does in the product.
// Nothing in an HTTP request will ever notice that today is somebody's
// birthday. This worker is what notices.
//
// It owns no logic: the sweep itself is
// src/modules/automation/automation.sweep.js, which decides which studios to
// visit and hands each row to the automation engine. This file is the cron
// registration and the BullMQ plumbing around it, kept separate for the same
// reason renewal.worker.js is — a worker that also contains the business rules
// is a worker that can only be exercised by running it.
//
// Standalone:   node src/workers/automation.worker.js   (one pass, then exit)
// In-process:   see src/workers/index.js
//
// ── Why its own queue ───────────────────────────────────────────────────────
//
// Rather than a third job name on 'membership-renewals'. That queue's jobs are
// pinned to attempts: 1 because they charge cards, and its cron is tuned to
// that. This sweep charges nothing, is idempotent by construction (every
// message it produces carries a date-anchored dedupe key), and wants a
// different schedule and a different retry policy. Sharing the queue would
// mean one of those two facts had to be wrong.

const { Worker } = require('bullmq');
const logger = require('../lib/logger');
const redis = require('../lib/redis');
const { runSweep } = require('../modules/automation/automation.sweep');

const SWEEP_JOB_ID = 'automation-daily-sweep';

/**
 * When the sweep runs.
 *
 * 03:30 UTC = 09:00 IST, which is where this product's studios are. The
 * default matters more than it looks: these jobs produce messages to real
 * people's phones, and a default of midnight UTC would send birthday wishes at
 * half past five in the morning. A studio that wants a different hour sets
 * AUTOMATION_SWEEP_CRON; the per-rule delay_minutes still applies on top.
 */
const DEFAULT_SWEEP_CRON = '30 3 * * *';

async function processSweepJob(job) {
  if (job.name !== 'daily') throw new Error(`Unknown automation job: ${job.name}`);
  return runSweep();
}

function createAutomationWorker() {
  const worker = new Worker('automation-sweep', processSweepJob, {
    connection: redis.getWorkerConnection(),
    prefix: process.env.BULL_PREFIX || 'bull',
    // One at a time. A second concurrent pass would race the first on the same
    // rows; the dedupe index would refuse the duplicate messages, so nothing
    // would be sent twice — but it would be doing the whole scan twice to
    // discover that.
    concurrency: 1,
  });

  worker.on('completed', (job, result) =>
    logger.info({ jobId: job.id, orgs: result?.orgs, skipped: result?.skipped }, 'automation sweep completed'));
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err: err.message }, 'automation sweep failed'));
  worker.on('error', (err) => logger.error({ err: err.message }, 'automation sweep worker error'));

  return worker;
}

/**
 * Register the sweep's job scheduler (bullmq v6 Job Scheduler API).
 *
 * Idempotent — upserting the same schedulerId updates it rather than adding a
 * second — so every replica may call this on every boot, and BullMQ guarantees
 * a scheduled job fires on exactly one of them. Two replicas sweeping the same
 * studio would not send anything twice (the dedupe key is what makes that
 * true), but it would do the work twice.
 *
 * Bounded by a timeout for the same reason scheduleRenewalCron is: with Redis
 * unreachable the upsert would sit in ioredis's offline queue indefinitely and
 * take boot with it. It throws instead, the caller logs, and a later boot
 * registers the schedule.
 */
async function scheduleAutomationSweep() {
  const cron = process.env.AUTOMATION_SWEEP_CRON || DEFAULT_SWEEP_CRON;
  const { automationSweepQueue } = require('../jobs/queue');

  const withTimeout = (p, ms) =>
    Promise.race([
      p,
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error('automation sweep schedule timeout')), ms);
        if (typeof t.unref === 'function') t.unref();
      }),
    ]);

  await withTimeout(automationSweepQueue.upsertJobScheduler(
    SWEEP_JOB_ID,
    { pattern: cron },
    {
      name: 'daily',
      data: {},
      opts: {
        // attempts: 1, like the renewal sweep, but for a different reason: a
        // retry is harmless here (every write is idempotent) and also nearly
        // useless, because the failures this can have — Postgres unreachable,
        // Redis unreachable — are not the kind that clear inside a backoff.
        // The next day's pass is the retry, and missing a day is visible in
        // the logs rather than hidden behind three silent attempts.
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    }
  ), 5000);

  logger.info({ cron }, 'automation sweep cron scheduled');
  return { jobSchedulerId: SWEEP_JOB_ID };
}

if (require.main === module) {
  runSweep()
    .then((summary) => {
      logger.info({ summary }, 'automation sweep run finished');
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err: err.message }, 'automation sweep run failed');
      process.exit(1);
    });
}

module.exports = {
  createAutomationWorker,
  scheduleAutomationSweep,
  processSweepJob,
  SWEEP_JOB_ID,
  DEFAULT_SWEEP_CRON,
};

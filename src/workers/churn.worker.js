'use strict';
// src/workers/churn.worker.js
// BullMQ plumbing for the daily at-risk digest.
//
// Standalone:   node src/workers/churn.worker.js   (one pass, then exit)
// In-process:   see src/workers/index.js

const { Worker } = require('bullmq');
const { withJobContext } = require('./jobContext');
const logger = require('../lib/logger');
const redis = require('../lib/redis');
const { runChurnDigestSweep } = require('../modules/pt-os/churn.sweep');

const SWEEP_JOB_ID = 'churn-digest-daily-sweep';
// 03:30 UTC = 09:00 IST, half an hour before the re-test sweep. Both wake-ups
// are arbitrary; the per-org timezone decides what "today" means for each row.
const DEFAULT_SWEEP_CRON = '30 3 * * *';

async function processChurnJob(job) {
  if (job.name === 'daily') return runChurnDigestSweep();
  throw new Error(`Unknown churn job: ${job.name}`);
}

function createChurnWorker() {
  const worker = new Worker('churn-digests', withJobContext('churn-digests', processChurnJob), {
    connection: redis.getWorkerConnection(),
    prefix: process.env.BULL_PREFIX || 'bull',
    concurrency: 1,
  });

  worker.on('completed', (job, result) =>
    logger.info({ jobId: job.id, ...result }, 'churn digest sweep completed'));
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err: err.message }, 'churn digest sweep failed'));
  worker.on('error', (err) => logger.error({ err: err.message }, 'churn digest worker error'));

  return worker;
}

async function scheduleChurnDigest() {
  const cron = process.env.CHURN_DIGEST_CRON || DEFAULT_SWEEP_CRON;
  const { churnDigestsQueue } = require('../jobs/queue');

  const withTimeout = (p, ms) =>
    Promise.race([
      p,
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error('churn digest schedule timeout')), ms);
        if (typeof t.unref === 'function') t.unref();
      }),
    ]);

  await withTimeout(churnDigestsQueue.upsertJobScheduler(
    SWEEP_JOB_ID,
    { pattern: cron },
    {
      name: 'daily',
      data: {},
      opts: {
        // Exactly-once is the delivery ledger, not a retry. The next day's
        // pass is a better retry than three attempts in a row.
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    }
  ), 5000);

  logger.info({ cron }, 'churn digest cron scheduled');
  return { jobSchedulerId: SWEEP_JOB_ID };
}

if (require.main === module) {
  runChurnDigestSweep()
    .then((summary) => {
      logger.info({ summary }, 'churn digest run finished');
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err: err.message }, 'churn digest run failed');
      process.exit(1);
    });
}

module.exports = {
  createChurnWorker,
  scheduleChurnDigest,
  processChurnJob,
  SWEEP_JOB_ID,
  DEFAULT_SWEEP_CRON,
};

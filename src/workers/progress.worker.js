'use strict';
// src/workers/progress.worker.js
// BullMQ plumbing for the daily re-test reminder sweep.
//
// Standalone:   node src/workers/progress.worker.js   (one pass, then exit)
// In-process:   see src/workers/index.js

const { Worker } = require('bullmq');
const { withJobContext } = require('./jobContext');
const logger = require('../lib/logger');
const redis = require('../lib/redis');
const { runProgressSweep } = require('../modules/progress/progress.sweep');

const SWEEP_JOB_ID = 'progress-retest-daily-sweep';
// 04:00 UTC = 09:30 IST. The per-org timezone decides what “today” means for
// each row; this is only when the pass wakes up.
const DEFAULT_SWEEP_CRON = '0 4 * * *';

async function processProgressJob(job) {
  if (job.name === 'daily') return runProgressSweep();
  throw new Error(`Unknown progress job: ${job.name}`);
}

function createProgressWorker() {
  const worker = new Worker('progress-reminders', withJobContext('progress-reminders', processProgressJob), {
    connection: redis.getWorkerConnection(),
    prefix: process.env.BULL_PREFIX || 'bull',
    concurrency: 1,
  });

  worker.on('completed', (job, result) =>
    logger.info({ jobId: job.id, ...result }, 'progress reminder sweep completed'));
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err: err.message }, 'progress reminder sweep failed'));
  worker.on('error', (err) => logger.error({ err: err.message }, 'progress reminder worker error'));

  return worker;
}

async function scheduleProgressSweep() {
  const cron = process.env.PROGRESS_SWEEP_CRON || DEFAULT_SWEEP_CRON;
  const { progressRemindersQueue } = require('../jobs/queue');

  const withTimeout = (p, ms) =>
    Promise.race([
      p,
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error('progress sweep schedule timeout')), ms);
        if (typeof t.unref === 'function') t.unref();
      }),
    ]);

  await withTimeout(progressRemindersQueue.upsertJobScheduler(
    SWEEP_JOB_ID,
    { pattern: cron },
    {
      name: 'daily',
      data: {},
      opts: {
        // Every send is idempotent through the delivery ledger, so the next
        // day's pass is a better retry than three attempts in a row.
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    }
  ), 5000);

  logger.info({ cron }, 'progress reminder cron scheduled');
  return { jobSchedulerId: SWEEP_JOB_ID };
}

if (require.main === module) {
  runProgressSweep()
    .then((summary) => {
      logger.info({ summary }, 'progress reminder run finished');
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err: err.message }, 'progress reminder run failed');
      process.exit(1);
    });
}

module.exports = {
  createProgressWorker,
  scheduleProgressSweep,
  processProgressJob,
  SWEEP_JOB_ID,
  DEFAULT_SWEEP_CRON,
};

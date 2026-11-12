// src/workers/notifications.worker.js
// BullMQ worker for the 'notifications' queue. Processes the per-channel fan-
// out jobs produced by notifications.service.js send().
//
// Standalone:   node src/workers/notifications.worker.js
// In-process:   see src/workers/index.js

const { Worker } = require('bullmq');
const { withJobContext } = require('./jobContext');
const logger = require('../lib/logger');
const redis = require('../lib/redis');
const { processNotificationJob } = require('../modules/notifications/notifications.service');

const PUSH_RETENTION_JOB_ID = 'push-delivery-retention';
// 04:15 UTC = 09:45 IST, after the automation sweep and before the studio day.
const DEFAULT_PUSH_RETENTION_CRON = '15 4 * * *';

function createNotificationsWorker() {
  const worker = new Worker('notifications', withJobContext('notifications', processNotificationJob), {
    connection: redis.getWorkerConnection(),
    prefix: process.env.BULL_PREFIX || 'bull',
    concurrency: parseInt(process.env.NOTIFICATIONS_WORKER_CONCURRENCY, 10) || 5,
  });

  worker.on('completed', (job) => logger.info({ jobId: job.id, name: job.name }, 'notification job completed'));
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, name: job?.name, err: err.message }, 'notification job failed'));
  worker.on('error', (err) => logger.error({ err: err.message }, 'notifications worker error'));

  return worker;
}

/**
 * Schedule the daily push-delivery retention pass on this queue.
 *
 * The job only deletes old `push_deliveries` rows — retry state, not audit.
 * `notification_log` is untouched. One attempt is enough: yesterday's rows are
 * not urgent, and the next day's run is the retry.
 */
async function schedulePushRetention() {
  const cron = process.env.PUSH_RETENTION_CRON || DEFAULT_PUSH_RETENTION_CRON;
  const { notificationsQueue } = require('../jobs/queue');

  const withTimeout = (promise, ms) =>
    Promise.race([
      promise,
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error('push retention schedule timeout')), ms);
        if (typeof t.unref === 'function') t.unref();
      }),
    ]);

  await withTimeout(notificationsQueue.upsertJobScheduler(
    PUSH_RETENTION_JOB_ID,
    { pattern: cron },
    {
      name: 'push-retention',
      data: {},
      opts: { attempts: 1, removeOnComplete: true, removeOnFail: true },
    }
  ), 5000);

  logger.info({ cron }, 'push retention cron scheduled');
  return { jobSchedulerId: PUSH_RETENTION_JOB_ID };
}

if (require.main === module) {
  const worker = createNotificationsWorker();
  schedulePushRetention().catch((err) => logger.error({ err: err.message }, 'push retention cron not scheduled'));
  logger.info('notifications worker started');
  const shutdown = async () => {
    await worker.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createNotificationsWorker, schedulePushRetention, PUSH_RETENTION_JOB_ID };

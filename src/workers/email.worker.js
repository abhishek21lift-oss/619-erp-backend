// src/workers/email.worker.js
// BullMQ worker for the 'email' queue. Processes email jobs produced by
// lib/email.js's queue-or-inline dispatcher (password resets, admin OTPs,
// welcome emails) and the notifications centre's raw sends.
//
// Standalone:   node src/workers/email.worker.js
// In-process:   see src/workers/index.js

const { Worker } = require('bullmq');
const logger = require('../lib/logger');
const redis = require('../lib/redis');
const { processEmailJob } = require('../services/email.service');

function createEmailWorker() {
  const worker = new Worker('email', processEmailJob, {
    connection: redis.getWorkerConnection(),
    prefix: process.env.BULL_PREFIX || 'bull',
    concurrency: parseInt(process.env.EMAIL_WORKER_CONCURRENCY, 10) || 5,
  });

  worker.on('completed', (job) => logger.info({ jobId: job.id, type: job.name }, 'email job completed'));
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, type: job?.name, err: err.message }, 'email job failed'));
  worker.on('error', (err) => logger.error({ err: err.message }, 'email worker error'));

  return worker;
}

if (require.main === module) {
  const worker = createEmailWorker();
  logger.info('email worker started');
  const shutdown = async () => {
    await worker.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createEmailWorker };

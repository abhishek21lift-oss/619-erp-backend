// src/workers/index.js
// Start all in-process BullMQ workers plus the renewal scheduler.
//
// Used by server.js (when RUN_WORKERS != 0 and Redis is configured) so a
// single-instance Render deploy does not need a second worker process. Each
// worker owns its own blocking Redis connection — see lib/redis.js for why.
//
// Standalone:   node src/workers/index.js

// Error monitoring, BEFORE anything else, for the same reason server.js does it
// first: the SDK has to be initialised before the code it instruments runs.
//
// This line was missing, and the gap was invisible from inside the worker.
// docker-compose.yml hands SENTRY_DSN to this service explicitly (line 189,
// alongside the api's on line 119) because Compose only passes through variables
// an `environment:` line names — so the variable arrived, was correct, and was
// read by nobody: src/instrument.js is the only thing in the backend that calls
// Sentry.init().
//
// It is not cosmetic here, because of the topology. The api runs with
// RUN_WORKERS=0 and this file runs as its own container, so these are separate
// processes — this is not the single-process case where server.js's own
// require would have covered the workers incidentally. What runs in here owns
// the AI queue, email delivery, WhatsApp, notifications and renewal billing, so
// an unhandled throw in any of them was invisible to Sentry while looking, from
// the compose file, fully configured.
//
// At module scope rather than inside startWorkers(): Node's module cache means
// that when server.js has already required ./instrument (RUN_WORKERS=1), this
// require hands back that same instance and init() runs once, not twice.
// src/instrument.js stays the single place that decides whether to initialise.
require('../instrument');

const logger = require('../lib/logger');

let activeWorkers = [];

async function startWorkers() {
  // Which build these workers are. The worker container's log lines are the
  // ones nobody can attribute after a partial deploy — the api can be on one
  // commit and the worker on another, and until this line existed there was
  // nothing in its output that said which.
  logger.info(require('../lib/release').releaseLogLine(), 'release');

  const redis = require('../lib/redis');
  if (!redis.isConfigured()) {
    logger.warn('Redis not configured — in-process workers skipped');
    return [];
  }

  const { createEmailWorker } = require('./email.worker');
  const { createWhatsappWorker } = require('./whatsapp.worker');
  const { createAiWorker } = require('./ai.worker');
  const { createNotificationsWorker } = require('./notifications.worker');
  const { createRenewalWorker, scheduleRenewalCron } = require('./renewal.worker');
  const { createAutomationWorker, scheduleAutomationSweep } = require('./automation.worker');

  const workers = [
    createEmailWorker(),
    createWhatsappWorker(),
    createAiWorker(),
    createNotificationsWorker(),
    createRenewalWorker(),
    createAutomationWorker(),
  ];
  await scheduleRenewalCron();

  // Caught, unlike the line above it, and deliberately not by changing that
  // line. An unregistered sweep schedule costs a studio one morning's
  // reminders; a throw here would escape before `activeWorkers` is assigned
  // below, so stopWorkers() would have nothing to close and the five workers
  // just started would outlive the shutdown that was supposed to end them.
  // Redis is optional in this stack, so "the cron could not be registered" is
  // a condition this has to survive rather than a reason to abandon the boot.
  try {
    await scheduleAutomationSweep();
  } catch (err) {
    logger.error({ err: err.message }, 'automation sweep cron not scheduled');
  }

  activeWorkers = workers;
  logger.info({ count: workers.length }, 'in-process workers started');
  return workers;
}

async function stopWorkers() {
  await Promise.all(
    activeWorkers.map((w) => w.close().catch((err) => logger.warn({ err: err.message }, 'worker close failed')))
  );
  activeWorkers = [];
  logger.info('in-process workers stopped');
}

if (require.main === module) {
  // Command Center log persistence, standalone-worker half (D4).
  //
  // The worker runs in its own container, so it has its own in-memory ring that
  // nothing can read — the console is served by the API. Its errors reach an
  // operator ONLY through `system_logs`, which is exactly why those rows carry
  // a `source` column. Without this flush the worker would queue critical lines
  // and never write them, and the history would silently be API-only while
  // looking complete.
  //
  // No retention sweep here: one pruning process is enough, and the API's
  // hourly sweep covers every row regardless of who wrote it.
  const captureLogs = process.env.LOG_CAPTURE !== 'off';
  if (captureLogs) {
    const logCapture = require('../modules/command-center/logCapture');
    setInterval(() => { logCapture.flush(); }, 5 * 1000).unref();
  }

  startWorkers()
    .then(() => {
      const stop = async () => {
        // Flush once on the way out. The errors immediately PRECEDING a
        // shutdown are usually the interesting ones, and a 5s interval would
        // otherwise lose them with the process.
        if (captureLogs) {
          try {
            await require('../modules/command-center/logCapture').flush();
          } catch { /* shutting down; these lines are on stdout regardless */ }
        }
        await stopWorkers();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch((err) => {
      logger.error({ err: err.message }, 'failed to start workers');
      process.exit(1);
    });
}

module.exports = { startWorkers, stopWorkers };

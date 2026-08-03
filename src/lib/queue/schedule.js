'use strict';

/**
 * The repeatable jobs.
 *
 * src/workers/renewal.worker.js has existed for a long time with a comment
 * saying "run via cron, BullMQ, or a Vercel cron route". Nothing ran it. So
 * expiry reminders and auto-renew charges only happened when somebody
 * invoked the script by hand, which is to say: rarely.
 *
 * ── Why a repeatable job rather than another setInterval ───────────────────
 *
 * The other sweeps in server.js use setInterval, and that is right for them:
 * each is idempotent and row-locked, so an overlapping tick or a second
 * container changes nothing. Renewals are different — runAutoRenew charges a
 * card. Two API containers on a plain interval means two charge attempts, and
 * the guard against that would have to be written from scratch.
 *
 * BullMQ's repeatable jobs are held in Redis, not in a process, so N
 * containers produce one run. That is the actual reason this one is on the
 * queue and the others are left alone.
 *
 * Absent Redis this does nothing and says so. It does NOT fall back to an
 * interval: an unsupervised interval that charges cards is worse than a
 * missing schedule that is visible in the log at boot.
 */

const logger = require('../logger');
const connection = require('./connection');
const { QUEUES, getQueue } = require('./index');

/** Default 03:00 daily — after midnight so `end_date = CURRENT_DATE` is today. */
const RENEWAL_CRON = process.env.RENEWAL_CRON || '0 3 * * *';

/**
 * Register the daily renewal sweep.
 *
 * Idempotent: BullMQ keys a repeatable job by name + pattern, so every API
 * container calling this on boot leaves exactly one schedule. A changed
 * RENEWAL_CRON creates a new key and leaves the old one behind, so the
 * previous pattern is removed first.
 */
async function scheduleRenewals() {
  if (!connection.isEnabled()) {
    return { scheduled: false, reason: 'REDIS_NOT_CONFIGURED' };
  }
  const q = getQueue(QUEUES.RENEWAL);
  if (!q) return { scheduled: false, reason: 'QUEUE_UNAVAILABLE' };

  const name = 'daily-sweep';
  // Drop any schedule for this job whose pattern is no longer the configured
  // one, or the old cron keeps firing alongside the new.
  const existing = await q.getRepeatableJobs().catch(() => []);
  for (const job of existing) {
    if (job.name === name && job.pattern !== RENEWAL_CRON) {
      await q.removeRepeatableByKey(job.key).catch(() => {});
      logger.info({ was: job.pattern, now: RENEWAL_CRON }, 'renewal schedule pattern changed');
    }
  }

  await q.add(name, { task: 'all' }, {
    repeat: { pattern: RENEWAL_CRON, tz: process.env.RENEWAL_TZ || 'Asia/Kolkata' },
    // A fixed jobId keeps a restart from stacking duplicate schedules.
    jobId: 'renewal-daily-sweep',
  });

  return { scheduled: true, cron: RENEWAL_CRON, tz: process.env.RENEWAL_TZ || 'Asia/Kolkata' };
}

module.exports = { scheduleRenewals, RENEWAL_CRON };

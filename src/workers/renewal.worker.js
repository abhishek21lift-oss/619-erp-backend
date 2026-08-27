// src/workers/renewal.worker.js
// Membership maintenance: expiry reminders + auto-renew (charged via Razorpay)
// + class reminders.
//
// Two modes:
//
//   1. BullMQ worker (production): consumes the 'membership-renewals' queue.
//      scheduleRenewalCron() registers two job schedulers (bullmq v6 API):
//        - 'daily-membership-renewal'   cron RENEWAL_CRON       (default 0 3 * * *)
//                                      reminders + auto-renew
//        - 'class-reminder-sweep'       cron RENEWAL_CLASS_CRON (default */30 * * * *)
//                                      class reminders (matches sessions starting
//                                      ~30 min out, so it must run frequently)
//      BullMQ guarantees a scheduled job fires on exactly one worker, so
//      multiple API replicas cannot double-charge.
//
//   2. One-shot script (manual): node src/workers/renewal.worker.js — runs the
//      full daily pass once and exits. Useful for backfills.
//
// In-process: see src/workers/index.js.

const { Worker } = require('bullmq');
const pool = require('../db/pool');
const notifier = require('../modules/notifications/notifications.service');
const razorpay = require('../lib/razorpay');
const logger = require('../lib/logger');
const redis = require('../lib/redis');

// ── Two of the three sweeps below are still dead ────────────────────────────
//
// runClassReminders() was fixed with the booking module (migration 182) and now
// reads the live tables.
//
// runReminders() and runAutoRenew() have NOT been. Both operate entirely on
// `members`, `member_memberships` and the legacy `payments` table — the
// abandoned v3 model. Nothing writes those tables (the only INSERT INTO
// member_memberships is inside runAutoRenew itself, reached from a SELECT over
// the same empty table), so both select zero rows and report success on every
// daily tick. There is therefore no membership expiry reminder and no
// auto-renew for any real client.
//
// That is a rewrite against pt_clients + pt_client_subscriptions + pt_payments,
// and it is deliberately not bundled here: runAutoRenew CHARGES CARDS through
// Razorpay, and a sweep that moves money needs its own change, its own dry-run
// against a full cycle, and a decision about whether studios auto-charge at all.
// See BIZ-03 in the architecture audit.
const REMINDER_DAYS = [7, 3, 1];   // send reminder when this many days remain

async function runReminders() {
  for (const days of REMINDER_DAYS) {
    const { rows } = await pool.query(`
      SELECT m.id AS member_id, m.user_id, m.name, m.email, m.phone,
             pl.name AS plan_name, mm.end_date,
             (mm.end_date - CURRENT_DATE) AS days_remaining
      FROM member_memberships mm
      JOIN members m ON m.id = mm.member_id
      JOIN plans pl ON pl.id = mm.plan_id
      WHERE mm.status = 'active'
        AND (mm.end_date - CURRENT_DATE) = $1
        AND m.deleted_at IS NULL
    `, [days]);

    for (const m of rows) {
      await notifier.send('membership_expiring', m, { days, plan: m.plan_name },
        ['inapp', 'email', 'whatsapp']);
    }
    logger.info({ count: rows.length, days }, 'sent expiry reminders');
  }
}

async function runAutoRenew() {
  if (!razorpay.isConfigured()) {
    logger.warn('Razorpay not configured — skipping auto-renew. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to enable.');
    return;
  }

  // Find memberships expiring TODAY with auto_renew=true and gateway available
  const { rows } = await pool.query(`
    SELECT mm.*, m.name, m.email, m.phone, m.user_id, pl.name AS plan_name, pl.duration, pl.price
    FROM member_memberships mm
    JOIN members m ON m.id = mm.member_id
    JOIN plans pl ON pl.id = mm.plan_id
    WHERE mm.auto_renew = TRUE
      AND mm.status = 'active'
      AND mm.end_date = CURRENT_DATE
  `);

  for (const m of rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Charge via Razorpay
      const order = await razorpay.createOrder(m.price * 100, 'INR', `renew_${m.id}_${Date.now()}`);
      const payment = order.status === 'created'
        ? await razorpay.capturePayment(order.id, m.price * 100)
        : null;
      const charge = payment || { id: order.id, status: order.status, amount: m.price };

      // 2. Create new membership
      const newEnd = new Date();
      newEnd.setDate(newEnd.getDate() + m.duration);

      await client.query(
        `INSERT INTO member_memberships
           (member_id, plan_id, trainer_id, start_date, end_date,
            base_amount, final_amount, paid_amount, auto_renew, renewed_from_id, status)
         VALUES ($1,$2,$3, CURRENT_DATE, $4, $5, $5, $5, TRUE, $6, 'active')`,
        [m.member_id, m.plan_id, m.trainer_id, newEnd, m.price, m.id]
      );

      // 3. Mark old as expired
      await client.query(`UPDATE member_memberships SET status='expired' WHERE id = $1`, [m.id]);

      // 4. Record payment
      //
      // STILL BROKEN, and deliberately not fixed here: `payments` has no
      // member_id column, so this raises before it writes anything — the
      // BIZ-03 half this file's header already flags. It is left alone
      // because repairing it means deciding how a gym membership (members,
      // member_memberships, branch_id — a pre-multi-tenancy subsystem with no
      // organization_id anywhere) maps onto the PT client model, which is a
      // product decision and not a tenancy fix.
      //
      // Whoever does fix it: migration 186 makes payments.organization_id NOT
      // NULL and gives the table an AND'd parent-walk policy against
      // pt_clients, so this INSERT will need both a real client_id and the
      // org that client belongs to.
      await client.query(
        `INSERT INTO payments (member_id, amount, method, date, gateway, gateway_txn_id, gateway_status, branch_id)
         VALUES ($1,$2,'RAZORPAY', CURRENT_DATE, 'razorpay', $3, $4, COALESCE($5, 'br-main'))`,
        [m.member_id, m.price, charge.id, charge.status, process.env.BRANCH_ID || null]
      );

      await client.query('COMMIT');

      // 5. Notify member
      await notifier.send('payment_received', m,
        { amount: m.price, plan: m.plan_name }, ['inapp', 'email', 'whatsapp']);

      logger.info({ member: m.name }, 'auto-renew completed');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ member: m.name, err: err.message }, 'auto-renew failed');
      try {
        await notifier.send('payment_failed', m,
          { amount: m.price, error: err.message }, ['inapp', 'email']);
      } catch (_) { /* best-effort */ }
    } finally {
      client.release();
    }
  }
  logger.info({ count: rows.length }, 'auto-renew processed');
}

async function runClassReminders() {
  // 30 minutes before each class, ping the clients booked into it.
  //
  // Rewritten alongside the booking module (migration 182). Every join here was
  // against something that does not exist: `cs.starts_at` is not a column —
  // class_sessions stores `date` and `start_time` — and `members` is the
  // abandoned v3 table, joined on `bookings.member_id`, which bookings no
  // longer use. So this swept zero rows and reported success, on every tick,
  // every thirty minutes.
  //
  // class_templates is LEFT JOINed and users is LEFT JOINed on purpose: an
  // ad-hoc session without a template, or a client without a login, should
  // still get whatever channel it CAN be reached on rather than dropping out of
  // the sweep entirely. An inner join here is a silently missed reminder.
  const { rows } = await pool.query(`
    SELECT b.id AS booking_id, u.id AS user_id,
           c.name, c.mobile AS phone, c.email,
           COALESCE(ct.name, cs.title) AS class_name,
           TO_CHAR(cs.date + cs.start_time, 'HH24:MI') AS time,
           cs.id AS session_id
    FROM bookings b
    JOIN class_sessions cs ON cs.id = b.session_id
    LEFT JOIN class_templates ct ON ct.id = cs.template_id
    JOIN pt_clients c ON c.id = b.client_id AND c.deleted_at IS NULL
    LEFT JOIN users u ON u.pt_client_id = c.id AND u.deleted_at IS NULL
    WHERE b.status = 'confirmed'
      AND (cs.date + cs.start_time) AT TIME ZONE current_setting('TimeZone')
          BETWEEN NOW() + INTERVAL '25 minutes' AND NOW() + INTERVAL '35 minutes'
  `);
  for (const r of rows) {
    await notifier.send('class_reminder', r,
      { class_name: r.class_name, time: r.time }, ['inapp', 'whatsapp', 'push']);
  }
}

/** The full daily pass, shared by the one-shot script and the 'daily' job. */
async function runDailyRenewalTasks() {
  await runReminders();
  await runAutoRenew();
}

/** BullMQ processor for the membership-renewals queue. */
async function processRenewalJob(job) {
  if (job.name === 'daily') {
    await runDailyRenewalTasks();
    return { ran: 'daily' };
  }
  if (job.name === 'class-reminders') {
    await runClassReminders();
    return { ran: 'class-reminders' };
  }
  throw new Error(`Unknown renewal job: ${job.name}`);
}

function createRenewalWorker() {
  const worker = new Worker('membership-renewals', processRenewalJob, {
    connection: redis.getWorkerConnection(),
    prefix: process.env.BULL_PREFIX || 'bull',
    concurrency: 1,
  });

  worker.on('completed', (job) => logger.info({ jobId: job.id, name: job.name }, 'renewal job completed'));
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, name: job?.name, err: err.message }, 'renewal job failed'));
  worker.on('error', (err) => logger.error({ err: err.message }, 'renewal worker error'));

  return worker;
}

const RENEWAL_JOB_ID = 'daily-membership-renewal';
const CLASS_REMINDER_JOB_ID = 'class-reminder-sweep';

/**
 * Register the renewal job schedulers (bullmq v6 Job Scheduler API — the
 * repeatable-job API was removed in v6, so a scheduler is the supported way to
 * express "run X on a cron"). Idempotent: upserting the same schedulerId
 * updates it rather than creating duplicates, so this is safe to call on every
 * boot and from every replica.
 *
 * Bounded like every other queue call: if Redis is unreachable the upsert
 * would sit in the offline queue forever, so it races a timeout and throws so
 * the caller can log and move on (the workers themselves keep retrying in the
 * background and the scheduler gets registered on a later boot).
 */
async function scheduleRenewalCron() {
  const cron = process.env.RENEWAL_CRON || '0 3 * * *';
  const classCron = process.env.RENEWAL_CLASS_CRON || '*/30 * * * *';

  const { membershipRenewalsQueue } = require('../jobs/queue');

  const withTimeout = (p, ms) =>
    Promise.race([
      p,
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error('renewal cron schedule timeout')), ms);
        if (typeof t.unref === 'function') t.unref();
      }),
    ]);

  await withTimeout(membershipRenewalsQueue.upsertJobScheduler(
    RENEWAL_JOB_ID,
    { pattern: cron },
    {
      name: 'daily',
      data: {},
      opts: {
        // attempts: 1 on purpose — the per-member work is transactional, and a
        // retry of a partially-completed pass risks double-charging. A missed
        // pass is caught by the next day's (or interval's) run.
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    }
  ), 5000);

  await withTimeout(membershipRenewalsQueue.upsertJobScheduler(
    CLASS_REMINDER_JOB_ID,
    { pattern: classCron },
    {
      name: 'class-reminders',
      data: {},
      opts: { attempts: 1, removeOnComplete: true, removeOnFail: true },
    }
  ), 5000);

  logger.info({ cron, classCron }, 'renewal cron scheduled');
  return {
    daily: { jobSchedulerId: RENEWAL_JOB_ID },
    classReminders: { jobSchedulerId: CLASS_REMINDER_JOB_ID },
  };
}

async function main() {
  logger.info('worker run starting');
  try {
    await runDailyRenewalTasks();
    await runClassReminders();
  } catch (err) {
    logger.error({ err: err.message }, 'worker run failed');
    process.exitCode = 1;
  }
  process.exit(0);
}

if (require.main === module) {
  // One-shot manual run (historical behavior): --watch keeps the process
  // alive as a worker instead of exiting after a single pass.
  if (process.argv.includes('--watch')) {
    const worker = createRenewalWorker();
    scheduleRenewalCron().catch((err) => logger.error({ err: err.message }, 'renewal cron schedule failed'));
    logger.info('renewal worker started (watch mode)');
    const shutdown = async () => {
      await worker.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } else {
    main();
  }
}

module.exports = {
  runReminders, runAutoRenew, runClassReminders, runDailyRenewalTasks,
  createRenewalWorker, scheduleRenewalCron, processRenewalJob,
};

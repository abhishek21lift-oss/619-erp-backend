'use strict';
// Re-drive queued messages whose BullMQ job never made it.
//
// ── The failure this exists for ─────────────────────────────────────────────
//
// automation.engine.js writes the communication_logs row and THEN enqueues the
// job. That order is not an accident and does not change here: a job with no
// row is a message a real client receives that this system has no record of,
// which is worse in every way than a row whose message visibly never went out.
//
// But "visibly never went out" was only half true. Nothing looked. If the
// enqueue returned null because Redis was down, or the process died in the
// millisecond between the INSERT and the `add`, the row sat at 'queued'
// forever — and its dedupe key made that permanent, because the next identical
// business event is correctly refused as a duplicate of a message that was
// never sent. A studio's expiry reminder would silently never exist, and the
// only evidence would be a row on a page nobody reads.
//
// ── Why not weaken the dedupe instead ───────────────────────────────────────
//
// Because the dedupe key is the only thing standing between a retried request
// and a second WhatsApp message to a real person. Loosening it to let a
// stranded event through would trade a message that did not send for a message
// that sends twice, and the second is the one a client complains about. The
// row is not the problem — the missing job is. So this finds the missing job.
//
// ── Why it cannot send anything twice ───────────────────────────────────────
//
// Four independent reasons, in the order they apply:
//
//  1. Only rows still at 'queued' are candidates. The worker moves a row off
//     'queued' the moment it resolves, so anything sent, delivered, read or
//     failed is invisible here.
//  2. Redis is asked whether the job exists before anything is enqueued. A
//     delayed job — a "three days before expiry" reminder mid-wait — exists,
//     so it is left alone.
//  3. The job id is deterministic and unchanged: `wa-auto-<logId>`. BullMQ
//     refuses a duplicate id while the job exists, so even a racing second
//     sweep produces one job.
//  4. The gateway's send-once ledger, keyed on the same log row id, refuses a
//     second delivery of a message it has already sent — which is what covers
//     the one case the three above cannot, a worker that sent and then died
//     before recording it. repository.orphanCandidates() will not return rows
//     older than that ledger's memory, so this guarantee is never relied on
//     after it has expired.
//
// ── Everything else is re-checked by the worker, not here ───────────────────
//
// The studio switch, the trainer's grant and the connected Baileys instance
// are all verified in processAutomationJob at send time, because they can
// change while a job waits — that is exactly why they are checked there rather
// than only in the engine. Re-implementing them here would be a second place
// that decides whether a client gets messaged, which is the thing this
// codebase deliberately does not have. The studio switch is the one exception:
// it is checked before the loop, purely to avoid doing the work at all for a
// studio that has turned automation off.
//
// The daily limit needs no re-check for a subtler reason: a recovered row was
// already counted against it when it was inserted (sendsToday counts queued
// rows, not just sent ones), so re-driving consumes no additional quota. It
// spends the quota the studio has already spent.

const logger = require('../../lib/logger');
const repo = require('./automation.repository');

/** Reasons a candidate was not re-driven. Enumerated for the same reason the
 *  engine's outcomes are: "nothing happened" is the state an operator needs to
 *  be able to explain. */
const RecoveryOutcome = Object.freeze({
  REQUEUED: 'requeued',
  JOB_PRESENT: 'job_present',
  QUEUE_UNAVAILABLE: 'queue_unavailable',
  FAILED: 'failed',
});

/** How long a row must have been queued before it is even considered. */
function graceSeconds() {
  const n = parseInt(process.env.AUTOMATION_RECOVERY_GRACE_SEC, 10);
  return Number.isInteger(n) && n > 0 ? n : 900; // 15 minutes
}

/**
 * The oldest row this will re-drive.
 *
 * Defaults to the gateway's own send-once TTL, because that ledger is what
 * makes a re-drive safe — see reason 4 in the header. Reading the same env var
 * the gateway reads means the two cannot silently disagree; the fallback
 * matches the gateway's own default.
 */
function maxAgeSeconds() {
  const n = parseInt(process.env.AUTOMATION_RECOVERY_MAX_AGE_SEC, 10);
  if (Number.isInteger(n) && n > 0) return n;
  const ttl = parseInt(process.env.WA_SEND_DEDUPE_TTL_SEC, 10);
  return Number.isInteger(ttl) && ttl > 0 ? ttl : 6 * 3600;
}

/**
 * Re-drive one studio's orphaned rows.
 *
 * Exported separately from runRecovery so an operator can re-drive a single
 * studio without touching the others, and so the tests can drive one org
 * without standing up the whole loop.
 */
async function recoverOrg(orgId, { grace = graceSeconds(), maxAge = maxAgeSeconds() } = {}) {
  const stats = { candidates: 0, requeued: 0, jobPresent: 0, failed: 0, unavailable: 0 };

  const candidates = await repo.orphanCandidates(orgId, {
    olderThanSec: grace,
    maxAgeSec: maxAge,
  });
  stats.candidates = candidates.length;
  if (candidates.length === 0) return stats;

  const redis = require('../../lib/redis');
  if (!(await redis.ensureReady())) {
    // Redis is still down — which is very likely the reason these rows are
    // orphaned in the first place. Counted and reported rather than retried in
    // a loop; the next sweep is the retry.
    stats.unavailable = candidates.length;
    logger.warn({ org_id: orgId, candidates: candidates.length }, 'automation_recovery_queue_unavailable');
    return stats;
  }

  const { whatsappQueue } = require('../../jobs/queue');
  const { enqueueWhatsapp } = require('../../services/whatsapp.service');

  for (const row of candidates) {
    const jobId = `wa-auto-${row.id}`;
    try {
      // The question that separates an orphan from a message that is simply
      // waiting. Any state counts as present — delayed, waiting, active, even
      // failed-and-retained — because in every one of them the job exists and
      // this must not add a second.
      const existing = await whatsappQueue.getJob(jobId);
      if (existing) {
        stats.jobPresent += 1;
        continue;
      }

      const job = await enqueueWhatsapp(
        'automation',
        { logId: row.id, orgId, requestId: `recovery-${jobId}` },
        {
          // The REMAINING delay, computed by the database from the row's own
          // created_at and its rule's delay_minutes. Zero for a reminder whose
          // moment has already passed — late is the correct answer there, and
          // it is the studio's own message either way.
          delay: row.remainingDelayMs,
          jobId,
        }
      );

      if (job) {
        stats.requeued += 1;
        logger.info(
          { org_id: orgId, log_id: row.id, job_id: jobId, delay_ms: row.remainingDelayMs },
          'automation_recovery_requeued'
        );
      } else {
        stats.unavailable += 1;
      }
    } catch (err) {
      // One row, not the studio. A single malformed row must not stop the
      // others from being recovered.
      stats.failed += 1;
      logger.error({ err: err.message, org_id: orgId, log_id: row.id }, 'automation_recovery_row_failed');
    }
  }

  return stats;
}

/**
 * Re-drive every studio that has automation switched on.
 *
 * The same per-studio loop shape as automation.sweep.js, and for the same
 * reason: orgId is a local variable that every statement binds, so no
 * statement in this path can see two studios at once. A studio whose recovery
 * throws is logged and skipped rather than ending the run.
 */
async function runRecovery() {
  const orgIds = await repo.orgsWithAutomationOn();
  const summary = { orgs: 0, requeued: 0, candidates: 0, skipped: 0, byOrg: {} };

  for (const orgId of orgIds) {
    try {
      const stats = await recoverOrg(orgId);
      if (stats.candidates === 0) continue;
      summary.orgs += 1;
      summary.candidates += stats.candidates;
      summary.requeued += stats.requeued;
      summary.byOrg[orgId] = stats;
    } catch (err) {
      summary.skipped += 1;
      logger.error({ err: err.message, org_id: orgId }, 'automation_recovery_org_failed');
    }
  }

  if (summary.candidates > 0) {
    logger.info(
      { orgs: summary.orgs, candidates: summary.candidates, requeued: summary.requeued },
      'automation_recovery_complete'
    );
  }
  return summary;
}

/**
 * How far back a reconnect re-drives.
 *
 * THE safety knob of this feature, and the reason it is a knob rather than a
 * constant. These are messages to real people. A welcome note that arrives two
 * minutes after a studio reconnects is the feature working; the same note three
 * days later is worse than one that never arrived, because the client has to
 * work out what it refers to.
 *
 * Two hours by default: long enough to cover a phone that lost its session over
 * lunch or a router that dropped overnight-and-was-fixed-in-the-morning, short
 * enough that nothing arrives with no context left. Raise it deliberately, per
 * deployment, if a studio would rather have late messages than none.
 *
 * Anything older is left `failed` with its reason intact, which is a true
 * statement an operator can read, rather than deleted or silently retried.
 */
function reconnectMaxAgeSeconds() {
  const n = parseInt(process.env.AUTOMATION_RECONNECT_MAX_AGE_SEC, 10);
  return Number.isInteger(n) && n > 0 ? n : 7200; // 2 hours
}

/**
 * Re-drive the messages one studio lost while its WhatsApp was disconnected.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * recoverOrg above finds rows whose JOB went missing. This finds rows whose
 * job ran, reached the transport, and was correctly told the studio's WhatsApp
 * was unusable. The worker marks those `failed` rather than throwing, on the
 * sound reasoning that no number of BullMQ retries reconnects a socket only
 * the studio can restore by scanning a QR.
 *
 * But nothing then acted on the reconnection. Production: a Welcome Message
 * failed `whatsapp_logged_out` at 10:56, the studio reconnected at 11:04, and
 * that message stayed failed for good — and permanently, because its dedupe
 * key means the same business event will never produce another row. The studio
 * did everything right and the client still heard nothing.
 *
 * ── Why this cannot send twice ──────────────────────────────────────────────
 *
 *  1. Only rows still `failed` for a reconnect-fixable reason are candidates,
 *     and requeueFailed re-asserts that in its own WHERE. Its rowCount is the
 *     permission to enqueue, so two concurrent reconnect events produce one
 *     requeue and one job.
 *  2. The job id is unchanged and deterministic — `wa-auto-<logId>` — so
 *     BullMQ refuses a duplicate while the job exists, and the queue is asked
 *     whether one exists before anything is added.
 *  3. The gateway's send-once ledger is keyed on the same log row id, so even
 *     a worker that sent and died before recording it cannot deliver twice.
 *  4. The age window is bounded, so a row can never be re-driven after that
 *     ledger has forgotten it.
 *
 * Called from the webhook that observes the reconnection, and deliberately
 * fire-and-forget there: a studio's WhatsApp coming back must be recorded even
 * if re-driving its backlog fails.
 */
async function recoverAfterReconnect(orgId, { maxAge = reconnectMaxAgeSeconds() } = {}) {
  const stats = { candidates: 0, requeued: 0, jobPresent: 0, failed: 0, unavailable: 0 };
  if (!orgId) return stats;

  // The studio switch, checked once before the work rather than per row. The
  // trainer grant and the instance itself are re-checked by the worker at send
  // time, as they are for every other path — see processAutomationJob.
  const settings = await repo.settingsFor(orgId);
  if (!settings.automation_enabled) return stats;

  const candidates = await repo.reconnectCandidates(orgId, { maxAgeSec: maxAge });
  stats.candidates = candidates.length;
  if (candidates.length === 0) return stats;

  const redis = require('../../lib/redis');
  if (!(await redis.ensureReady())) {
    stats.unavailable = candidates.length;
    logger.warn({ org_id: orgId, candidates: candidates.length }, 'automation_reconnect_queue_unavailable');
    return stats;
  }

  const { whatsappQueue } = require('../../jobs/queue');
  const { enqueueWhatsapp } = require('../../services/whatsapp.service');

  for (const row of candidates) {
    const jobId = `wa-auto-${row.id}`;
    try {
      const existing = await whatsappQueue.getJob(jobId);
      if (existing) {
        // A job from the original attempt is still around. Removing it so the
        // row could be re-queued would race whatever is holding it; leaving it
        // is correct, and the row stays failed until the next reconnect.
        stats.jobPresent += 1;
        continue;
      }

      // The row moves back to 'queued' BEFORE the enqueue, and its rowCount is
      // what authorises the enqueue. The worker refuses any row that is not
      // 'queued', so the order matters: enqueueing first would race a job
      // against the row it needs.
      if (!(await repo.requeueFailed(orgId, row.id))) {
        stats.jobPresent += 1;
        continue;
      }

      const job = await enqueueWhatsapp(
        'automation',
        { logId: row.id, orgId, requestId: `reconnect-${jobId}` },
        { delay: row.remainingDelayMs, jobId }
      );

      if (job) {
        stats.requeued += 1;
        logger.info({ org_id: orgId, log_id: row.id, job_id: jobId }, 'automation_reconnect_requeued');
      } else {
        // Redis went away between ensureReady and here. The row is back at
        // 'queued', which is the state recoverOrg is for, so it is not lost.
        stats.unavailable += 1;
      }
    } catch (err) {
      stats.failed += 1;
      logger.error({ err: err.message, org_id: orgId, log_id: row.id }, 'automation_reconnect_row_failed');
    }
  }

  if (stats.requeued > 0) {
    logger.info({ org_id: orgId, ...stats }, 'automation_reconnect_complete');
  }
  return stats;
}

module.exports = {
  runRecovery, recoverOrg, graceSeconds, maxAgeSeconds, RecoveryOutcome,
  recoverAfterReconnect, reconnectMaxAgeSeconds,
};

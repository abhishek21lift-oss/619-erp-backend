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

module.exports = { runRecovery, recoverOrg, graceSeconds, maxAgeSeconds, RecoveryOutcome };

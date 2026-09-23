'use strict';
// src/services/whatsapp.service.js
//
// WhatsApp job orchestration: enqueue a message for background delivery, and
// deliver one in the worker.
//
// ── What changed here, and why ──────────────────────────────────────────────
//
// This file, the 'whatsapp' BullMQ queue and whatsapp.worker.js all existed
// and were all unreachable. `enqueueWhatsapp` had no caller anywhere outside
// its own tests, while `createWhatsappWorker()` was started on every boot in
// workers/index.js — a worker consuming a queue nothing wrote to. And the
// delivery it would have performed went to Twilio: one platform-wide number,
// configured from process.env, with no organization in the call at all.
//
// The queue and the worker were the right shape. What was missing was a
// producer and a tenant. Both arrive here: the automation engine is the
// producer, and every job now carries the organization it acts for.

const logger = require('../lib/logger');

/**
 * Job types this queue understands.
 *
 * `automation` is the one the engine produces and the only one that resolves a
 * studio's own WhatsApp. `text` and `template` are the pre-existing shapes,
 * kept so that anything still constructing them keeps working — they are
 * documented as the non-tenanted legacy path in processWhatsappJob.
 */
// ── One job type, deliberately ─────────────────────────────────────────────
//
// 'text' and 'template' used to be here too. They predate tenancy on this path
// and carry no organization at all, so processWhatsappJob sent them through
// services/whatsappDelivery — a single platform-wide Twilio number — with no
// communication_logs row written anywhere. A message to a studio's client,
// from a number that studio has never heard of, with no record that it
// happened.
//
// Nothing produces them: every call site passes 'automation'
// (automation.engine once, automation.recovery twice, verified). But a Set is
// the enforcement point, and while those two strings were in it the hazard was
// one careless caller away from being live — on a path where the failure is
// invisible, because there is no row to notice.
//
// Removing them means such a job now fails loudly at enqueue instead. That is
// the right trade: transport.js already carries the shared provider under
// `allowSharedProvider` for callers that genuinely want it, WITH an
// organization and a logged row, which is the whole difference.
const WHATSAPP_TYPES = new Set(['automation']);

/**
 * Enqueue one WhatsApp job.
 *
 * Returns the BullMQ Job, or null when Redis is not ready so the caller can
 * decide what to do. Never throws for a queue outage.
 *
 * ── Why this one does NOT fall back to inline delivery ─────────────────────
 *
 * Its siblings do: notifications and email send inline when Redis is down,
 * because a delayed notification is worse than an unqueued one. An automated
 * WhatsApp message is different in two ways that both point the other way. It
 * may carry a DELAY the studio configured — sending it immediately because the
 * queue is unavailable would deliver a "3 days before expiry" reminder at the
 * moment of the payment. And the row is already written as 'queued', so an
 * operator can see it and re-drive it; an inline send here would bypass the
 * per-attempt bookkeeping that makes that possible.
 */
async function enqueueWhatsapp(type, data = {}, opts = {}) {
  if (!WHATSAPP_TYPES.has(type)) throw new Error(`Unknown whatsapp job type: ${type}`);

  const redis = require('../lib/redis');
  if (!(await redis.ensureReady())) return null;

  const { whatsappQueue } = require('../jobs/queue');
  const job = await whatsappQueue.add(type, { type, ...data }, opts);
  logger.info(
    { jobId: job.id, type, queue: 'whatsapp', delay_ms: opts.delay || 0 },
    'whatsapp job enqueued'
  );
  return job;
}

/**
 * Will BullMQ run this job again if the processor throws?
 *
 * Mirrors BullMQ's own predicate (`Job.shouldRetryJob`: attemptsMade + 1 <
 * opts.attempts), evaluated against the same values, so the two cannot
 * disagree about whether another attempt is coming. `attemptsMade` counts
 * attempts that have already FINISHED — it is 0 during the first run and is
 * incremented after the processor returns or throws.
 *
 * Deliberately conservative on missing data: a job with no opts is treated as
 * single-attempt, so an unknown shape marks the row failed rather than leaving
 * it queued forever waiting for a retry that is not coming.
 */
function willRetry(job) {
  const attempts = Number(job?.opts?.attempts);
  if (!Number.isFinite(attempts)) return false;
  return Number(job?.attemptsMade || 0) + 1 < attempts;
}

/**
 * Deliver one queued automated message.
 *
 * ── Everything is re-checked here, and none of it is redundant ─────────────
 *
 * The engine already checked the studio switch, the trainer grant and the
 * connection. This checks them again, because a job may sit in the queue for
 * as long as the rule's delay — hours, in the case a studio configures for a
 * "3 days before" reminder — and every one of those facts can change while it
 * waits. A studio owner who switches automation off, or revokes a trainer's
 * grant, has to stop the messages that are already in flight; otherwise the
 * kill switch only stops the ones nobody had queued yet, which is not a kill
 * switch.
 *
 * The organization comes off the job payload and is then required to match the
 * row. A job payload is not a credential — it can be edited in Redis, or
 * constructed wrongly by a bug — so it is used as an assertion rather than as
 * a lookup key, the same rule the gateway applies to its X-Org-Id header.
 */
async function processAutomationJob(job) {
  const { logId, orgId, requestId } = job.data || {};
  const repo = require('../modules/automation/automation.repository');
  const transport = require('../modules/messaging/transport');

  if (!logId || !orgId) throw new Error('automation job is missing logId or orgId');

  const row = await repo.loadQueued(orgId, logId);
  if (!row) {
    // The row is gone, or the payload named the wrong organization. Neither is
    // retryable and neither may send: returning ends the job quietly rather
    // than burning three attempts on something that cannot succeed.
    logger.warn({ log_id: logId, org_id: orgId }, 'automation_job_row_not_found');
    return { status: 'skipped', reason: 'row_not_found' };
  }

  // Already delivered — a duplicate job, or a retry after a lost response that
  // the gateway's send-once already resolved.
  if (row.status !== 'queued') {
    return { status: 'skipped', reason: `already_${row.status}` };
  }

  const settings = await repo.settingsFor(orgId);
  if (!settings.automation_enabled) {
    await repo.markFailed(orgId, logId, { reason: 'automation_disabled' });
    return { status: 'skipped', reason: 'automation_disabled' };
  }

  const result = await transport.send({
    orgId,
    to: row.recipient_phone,
    text: row.message,
    // The log row id is the client_message_id. It is stable across every retry
    // of this job, which is exactly what the gateway's send-once needs in order
    // to recognise a retry rather than send the client a second copy.
    clientMessageId: String(row.id),
    requestId,
    // Never. An automated message that cannot go out on the studio's own
    // number does not go out at all — see modules/messaging/transport.js.
    allowSharedProvider: false,
  });

  if (result.status === transport.SendStatus.SENT) {
    await repo.markSent(orgId, logId, {
      providerId: result.provider_id,
      provider: result.provider,
    });
    return { status: 'sent', provider_id: result.provider_id, duplicate: Boolean(result.duplicate) };
  }

  const reason = result.error || result.status;

  // Throwing is what asks BullMQ to retry, so only genuinely transient
  // failures throw. A disconnected WhatsApp is not transient in any sense the
  // queue can help with — no number of retries reconnects a socket that only
  // the studio can restore by scanning a QR — so it ends the job and leaves a
  // failed row saying exactly that.
  const retryable = transport.isRetryable(result.status) && result.retryable !== false;

  if (retryable && willRetry(job)) {
    // ── Why the row is NOT marked failed here ─────────────────────────────
    //
    // It used to be, unconditionally, immediately above the throw — and that
    // silently disabled the entire retry budget. The sequence was:
    //
    //   attempt 1  markFailed() → row is 'failed' → throw
    //   attempt 2  loadQueued() → status is 'failed', not 'queued'
    //              → return { skipped: 'already_failed' }
    //   the job COMPLETES, and nothing ever sends the message
    //
    // So one transient blip — a gateway restart, a lost packet,
    // GATEWAY_UNREACHABLE — dropped the studio's message permanently, and the
    // three attempts and exponential backoff configured in jobs/queue.js
    // never sent anything a second time. Worse, the job finished in the
    // 'completed' state, so the failure was invisible to an operator reading
    // the queue: the only trace was one log line and a communication_logs row
    // reading 'failed' with no explanation of why nothing was retried.
    //
    // The row therefore stays 'queued' while attempts remain, which is the
    // true statement — this message is still going out — and is what lets the
    // next attempt actually re-send it. The reason is recorded without moving
    // the status, so the studio sees what the last attempt hit while it is
    // still in flight.
    await repo.noteAttemptFailure(orgId, logId, reason);
    throw new Error(reason || 'whatsapp delivery failed');
  }

  // Terminal for this message: either the failure is one no retry can fix, or
  // this was the last attempt. Either way the row must stop saying 'queued' —
  // a row left queued with no job behind it is a message the studio is waiting
  // on that nothing will ever send.
  await repo.markFailed(orgId, logId, { reason, provider: result.provider });
  return { status: 'failed', reason };
}

/**
 * Worker processor for the 'whatsapp' queue.
 *
 * One shape, matching WHATSAPP_TYPES above. A job of any other type fails
 * rather than being carried by the org-less legacy transport that used to sit
 * here — see the comment on WHATSAPP_TYPES for what that transport actually
 * did. A job already in Redis from before this deploy dead-letters visibly,
 * which is the outcome to want: a message nobody can trace, sent from a number
 * the studio does not own, is not a degraded success.
 */
async function processWhatsappJob(job) {
  const { type } = job.data || {};
  if (type !== 'automation') throw new Error(`Unknown whatsapp job type: ${type}`);
  return processAutomationJob(job);
}

module.exports = {
  enqueueWhatsapp,
  processWhatsappJob,
  processAutomationJob,
  WHATSAPP_TYPES,
};

// src/modules/command-center/redis-degradation.js
//
// What actually happens to each queue when Redis is down.
//
// ── Why this is a module and not a sentence in a comment ───────────────────
//
// "Redis is optional, producers fall back to inline" is the folklore, and it
// is wrong in a way that matters: the fallback is NOT uniform. Read from the
// code, the five producers do three different things, and the difference
// decides what an operator should do about it:
//
//   email          sends INLINE, synchronously in the request. The mail still
//                  goes. The cost is latency on the request and the loss of
//                  BullMQ's retry/backoff — a transient SMTP failure is now a
//                  failed send rather than a retried one.
//                  (lib/email.js dispatchEmail -> inline())
//
//   notifications  sends INLINE per channel, same shape as email.
//                  (notifications.service.js -> deliverChannel)
//
//   ai             INLINE where the caller supplied a fallback, and those that
//                  did not simply do not run.
//                  (ai.service.js enqueueAiJob / the withFallback wrapper)
//
//   whatsapp       DOES NOT SEND. Deliberately: an inline send would bypass the
//                  per-attempt bookkeeping in communication_logs, so the row
//                  stays 'queued' and automation.recovery re-drives it when
//                  Redis returns. Nothing is lost and nothing is delivered
//                  until then.
//                  (automation.engine.js -> Outcome.NOT_ENQUEUED)
//
//   membership-    worker-driven. With no Redis there is no worker tick, so
//   renewals       renewals do not run at all until Redis returns. This is the
//                  one that costs money silently.
//
// An operator looking at a red Redis card needs to know which of those three
// they are in, because the answers differ: "nothing to do, latency is up",
// "messages are waiting and will flush", and "billing has stopped".
//
// ── Read from the code, and pinned to it ───────────────────────────────────
//
// Everything above is a claim about source that can drift. The companion test
// asserts each producer still has the shape described here — an `ensureReady`
// guard, and whether a null enqueue reaches an inline path — so a change to
// the fallback breaks the description instead of silently outdating it.
'use strict';

/** What a queue does when Redis is unreachable. */
const MODE = {
  /** The work still happens, synchronously, in the caller's request. */
  INLINE: 'inline',
  /** The work is recorded and re-driven later. Nothing lost, nothing sent. */
  DEFERRED: 'deferred',
  /** The work does not happen at all while Redis is down. */
  STOPPED: 'stopped',
};

/**
 * queue name -> what happens, and what it costs.
 *
 * `impact` is written for the operator reading it at 3am, not for a changelog.
 */
const DEGRADATION = {
  email: {
    mode: MODE.INLINE,
    impact: 'Mail still sends, synchronously in the request. Slower responses, and '
      + 'a transient SMTP failure is now a failed send rather than a retried one.',
    source: 'lib/email.js dispatchEmail() falls through to inline()',
  },
  notifications: {
    mode: MODE.INLINE,
    impact: 'Notifications still deliver, synchronously per channel. Same trade as email.',
    source: 'notifications.service.js falls through to deliverChannel()',
  },
  ai: {
    mode: MODE.INLINE,
    impact: 'AI work that supplied a fallback runs inline; work that did not is skipped. '
      + 'Requests get slower and some background enrichment does not happen.',
    source: 'ai.service.js enqueueAiJob() returns null; callers with a fallback run it',
  },
  whatsapp: {
    mode: MODE.DEFERRED,
    impact: 'WhatsApp messages are NOT sent. Each stays \'queued\' in communication_logs '
      + 'and automation.recovery re-drives it when Redis returns — deliberately, because '
      + 'an inline send would bypass the per-attempt bookkeeping. Nothing is lost; nothing '
      + 'arrives until Redis is back AND the automation-sweep scheduler below is running '
      + 'again, since the recovery pass rides that queue.',
    source: 'automation.engine.js records Outcome.NOT_ENQUEUED and leaves the row queued',
  },
  'membership-renewals': {
    mode: MODE.STOPPED,
    impact: 'Renewals DO NOT RUN. This is worker-driven, so with no queue there is no tick '
      + 'and no renewal is processed until Redis returns. This is the one that costs money '
      + 'while looking quiet.',
    source: 'worker-driven; no producer fallback exists',
  },
  'automation-sweep': {
    mode: MODE.STOPPED,
    impact: 'The daily automation sweep and the recovery sweep both stop. The recovery one '
      + 'matters twice over: it is what re-drives the WhatsApp messages deferred above, so '
      + 'those stay queued until Redis returns AND this scheduler is registered again on a '
      + 'later boot.',
    source: 'workers/automation.worker.js upsertJobScheduler; throws on a Redis timeout',
  },
};

/**
 * Describe the platform's behaviour right now.
 *
 * @param {'up'|'down'|'not_configured'} redisState
 * @returns {{ active: boolean, state: string, headline: string|null,
 *             queues: Array<{queue,mode,impact,source}> }}
 */
function describe(redisState) {
  const queues = Object.entries(DEGRADATION).map(([queue, d]) => ({ queue, ...d }));

  if (redisState === 'up') {
    return { active: false, state: 'up', headline: null, queues };
  }

  const stopped = queues.filter((q) => q.mode === MODE.STOPPED).map((q) => q.queue);
  const deferred = queues.filter((q) => q.mode === MODE.DEFERRED).map((q) => q.queue);

  // The headline leads with the worst of the three, because that is the one
  // that decides how urgently somebody has to act.
  const headline = redisState === 'not_configured'
    ? `No Redis on this deployment: ${stopped.join(', ')} never run, `
      + `${deferred.join(', ')} are recorded but never sent, and the rest run inline.`
    : `Redis is unreachable: ${stopped.join(', ')} HAVE STOPPED, `
      + `${deferred.join(', ')} are queued in the database and will flush on recovery, `
      + 'and the rest are running inline in the request.';

  return { active: true, state: redisState, headline, queues };
}

module.exports = { MODE, DEGRADATION, describe };

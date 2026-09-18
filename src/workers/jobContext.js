'use strict';
// src/workers/jobContext.js
//
// Carry a request's correlation id across the queue boundary.
//
// ── The gap this closes ────────────────────────────────────────────────────
//
// middleware/requestId.js opens a correlation context so every log line an
// HTTP request produces carries `req_id`. That context ends when the response
// does — and a great deal of what this platform actually does happens after
// that, on a BullMQ worker: the WhatsApp send, the renewal charge, the AI
// generation, the notification.
//
// So the request that enqueued the work was traceable, the work itself was
// not, and the two could not be joined. "The welcome message never arrived"
// led to a worker log line with no request, no actor and no organization on
// it, sitting among every other studio's.
//
// ── Why the id rides on the job and not on the worker ──────────────────────
//
// A job is enqueued by one process and run by another, possibly minutes or
// hours later — an automation rule can carry a delay of days. Nothing in the
// worker's own async context relates to the request that created the job, so
// the id has to travel as data, in the payload, and be re-opened here.
//
// `requestId` was ALREADY in some payloads: services/whatsapp.service.js reads
// job.data.requestId and passes it to the gateway so one send is traceable
// across both services. It simply never reached the logger. This makes that
// the rule for every queue rather than one caller's private convention.
//
// ── What happens when a job has no request behind it ───────────────────────
//
// Scheduled work — the nightly sweep, the renewal scan — has no originating
// request and never will. Those get a context built from the queue and job id
// instead, which is still strictly better than nothing: every line from one
// sweep shares an id, so a single pass can be read end to end.

const { runWithRequestContext } = require('../lib/request-context');

/**
 * Wrap a BullMQ processor so everything it logs is attributable.
 *
 * @param {string} queueName Used to build an id for jobs with no request.
 * @param {(job: object) => Promise<any>} processor The real processor.
 * @returns {(job: object) => Promise<any>}
 */
function withJobContext(queueName, processor) {
  return function processInContext(job) {
    const data = (job && job.data) || {};
    // A real request id when the work was triggered by one; otherwise an id
    // derived from the job, so the lines of one run still group together.
    const requestId = data.requestId || `job:${queueName}:${job && job.id}`;

    const context = { requestId, job: queueName };
    // Both are ids, never names or emails — the same rule the logger's redact
    // list enforces everywhere else.
    if (data.orgId) context.org = data.orgId;
    if (data.actorId) context.actor = data.actorId;

    return runWithRequestContext(context, () => processor(job));
  };
}

module.exports = { withJobContext };

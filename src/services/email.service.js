// src/services/email.service.js
// Email job orchestration: enqueue for background delivery, and process a
// queued job in the email worker.
//
// lib/email.js remains the single source of truth for *how* a message is
// composed and delivered (transporter, FROM address, retry policy). This
// module owns only the queue boundary: what a job carries and how the worker
// turns it back into a real send.

const logger = require('../lib/logger');

const EMAIL_TYPES = new Set([
  'raw',
  'password_reset',
  'admin_otp',
  'admin_invitation',
  'welcome',
  'notification',
]);

/**
 * Enqueue an email job. `type` is the job name (also stamped into the data so
 * a worker can act on it without parsing the job name).
 *
 * Returns the BullMQ Job, or null when Redis is not ready so the caller can
 * fall back to the synchronous send path. Never throws for a queue outage —
 * that is exactly the condition that must degrade to inline, not to a 500.
 *
 * ── Why organizationId is carried but NOT enforced here ─────────────────────
 *
 * `tenant.organizationId` is stamped onto the job when the caller knows it, so
 * a queued message can be traced to the studio it belongs to. It is not a gate,
 * and this queue deliberately has none, because an email job resolves to an
 * ADDRESS and delivering to an address is not a tenant-scoped act — there is no
 * row to re-derive an organization from and therefore no mismatch to detect.
 * (Contrast the notifications queue, whose recipients do have rows: see
 * assertJobTenant in modules/notifications/notifications.service.js.)
 *
 * More importantly, requiring an organization here would break the three types
 * that legitimately have none. password_reset, admin_otp and admin_invitation
 * are all PRE-AUTHENTICATION: the recipient has no session, and in the
 * invitation case no account yet, so there is no organization to resolve. A
 * check that refused them would lock people out of their own accounts — the
 * exact failure lib/email.js's boot-time verification exists to make loud.
 */
async function enqueueEmail(type, data = {}, opts = {}, tenant = {}) {
  if (!EMAIL_TYPES.has(type)) throw new Error(`Unknown email job type: ${type}`);

  const redis = require('../lib/redis');
  if (!(await redis.ensureReady())) return null;

  const { organizationId = null } = tenant;

  const { emailQueue } = require('../jobs/queue');
  const job = await emailQueue.add(type, { type, ...data, organizationId }, opts);
  logger.info({ jobId: job.id, type, queue: 'email', organizationId }, 'email job enqueued');
  return job;
}

/**
 * Worker processor: turn a queued email job into an actual send.
 *
 * Uses the INLINE variants from lib/email.js on purpose — calling the public
 * wrappers here would re-enqueue forever. Throws on failure so BullMQ's
 * retry/backoff policy (queue default, or per-job override) applies.
 */
async function processEmailJob(job) {
  const { type } = job.data || {};

  switch (type) {
    case 'raw':
    case 'notification': {
      const email = require('../lib/email');
      const { msg, ctx } = job.data;
      return email.sendRaw(msg, { ...(ctx || {}), kind: ctx?.kind || 'notification' });
    }
    case 'password_reset': {
      const email = require('../lib/email');
      return email.sendPasswordResetInline(job.data.email, job.data.token);
    }
    case 'admin_otp': {
      const email = require('../lib/email');
      return email.sendAdminResetOtpInline(job.data.email, job.data.otp);
    }
    case 'admin_invitation': {
      // sendAdminInvitation throws on permanent failure so BullMQ retries and
      // the invitation is never silently marked sent.
      const email = require('../lib/email');
      return email.sendAdminInvitation(job.data);
    }
    case 'welcome': {
      const email = require('../lib/email');
      return email.sendWelcomeInline(job.data);
    }
    default:
      throw new Error(`Unknown email job type: ${type}`);
  }
}

module.exports = { enqueueEmail, processEmailJob, EMAIL_TYPES };

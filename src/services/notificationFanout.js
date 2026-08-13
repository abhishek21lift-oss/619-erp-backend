// src/services/notificationFanout.js
// Enqueue one channel of a notification as its own BullMQ job on the
// 'notifications' queue. Called by notifications.service.js send().

const logger = require('../lib/logger');

const NOTIFICATION_CHANNELS = new Set(['inapp', 'email', 'whatsapp', 'sms', 'push']);

/**
 * Enqueue a single-channel notification job.
 *
 * Returns the BullMQ Job, or null when Redis is not ready so the caller can
 * fall back to the inline adapter. Never throws for a queue outage.
 *
 * `tenant.organizationId` rides on the payload so the worker can check it
 * against the recipient's authoritative organization before delivering (see
 * assertJobTenant in notifications.service.js). It must come from trusted
 * server context — req.user.organization_id — and never from a request body:
 * a tenant id supplied by the caller would make the check confirm the caller's
 * own claim, which is worse than not checking at all.
 *
 * `tenant.scope` of 'platform' declares a send that crosses studios on purpose.
 */
async function enqueueNotification(channel, type, recipient, data, opts = {}, tenant = {}) {
  if (!NOTIFICATION_CHANNELS.has(channel)) throw new Error(`Unknown notification channel: ${channel}`);

  const redis = require('../lib/redis');
  if (!(await redis.ensureReady())) return null;

  const { organizationId = null, scope } = tenant;

  const { notificationsQueue } = require('../jobs/queue');
  const job = await notificationsQueue.add(
    `${channel}:${type}`,
    { ch: channel, type, recipient, data, organizationId, scope },
    opts,
  );
  logger.info({ jobId: job.id, channel, type, queue: 'notifications', organizationId, scope }, 'notification job enqueued');
  return job;
}

module.exports = { enqueueNotification, NOTIFICATION_CHANNELS };

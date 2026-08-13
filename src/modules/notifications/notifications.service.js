// src/modules/notifications/notifications.service.js
// Multi-channel notification orchestrator: email + WhatsApp + SMS + push + in-app.
//
// In production, channel adapters push to a queue (BullMQ). For demo we call
// them inline. Each adapter is pluggable.

const pool = require('../../db/pool');
const logger = require('../../lib/logger');

// ─── Channel adapters (stubs — wire to your providers) ──────────────────────
const channels = {
  inapp: async ({ user_id, title, body, link }) => {
    const r = await pool.query(
      `INSERT INTO notifications (user_id, type, title, body, link)
       VALUES ($1, 'inapp', $2, $3, $4) RETURNING id`,
      [user_id, title, body, link || null]
    );
    return { id: r.rows[0].id, status: 'delivered' };
  },

  email: async ({ to, subject, html }) => {
    if (!to) return { status: 'failed', error: 'no recipient' };
    // No hardcoded domain fallback here on purpose — see lib/email.js's
    // FROM_ADDR comment. SMTP_USER is the one address guaranteed to belong to
    // a domain this deployment can actually send from.
    const FROM = process.env.EMAIL_FROM || process.env.SMTP_USER || '';

    // Resend (preferred when RESEND_API_KEY is set)
    if (process.env.RESEND_API_KEY) {
      try {
        const { Resend } = require('resend');
        const resend = new Resend(process.env.RESEND_API_KEY);
        const r = await resend.emails.send({ from: FROM, to, subject, html });
        return { status: 'sent', provider_id: r.data?.id || `resend_${Date.now()}` };
      } catch (err) {
        logger.error({ err, to, subject }, 'resend email failed');
        return { status: 'failed', error: err.message };
      }
    }

    // SMTP fallback — delegates to lib/email.js rather than keeping a second
    // copy of the transporter setup. The second copy is what broke this
    // channel: it read a "secure" flag from SMTP_SECURE, a variable nothing
    // in .env.example or the Render setup docs ever told anyone to set, so a
    // Hostinger deploy on port 465 (implicit TLS) connected with secure:false
    // and failed. lib/email.js has always derived it correctly from the port.
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
      const emailLib = require('../../lib/email');
      const result = await emailLib.sendRaw({ to, subject, html }, { to, subject, kind: 'notification' });
      if (result.sent) return { status: 'sent', provider_id: result.messageId };
      logger.error({ to, subject, reason: result.reason }, 'smtp email failed');
      return { status: 'failed', error: result.reason };
    }

    // No provider configured. Previously this returned status: 'sent' with a
    // fake provider_id — indistinguishable, everywhere this result is read
    // (notification_log, callers checking res.email.status), from an email
    // that actually went out. That is precisely the failure mode described as
    // "confirmation emails are not being delivered" with nothing in the logs
    // to explain why: the log line existed, but the STATUS lied about it.
    logger.warn({ to, subject }, 'email not_configured (set RESEND_API_KEY or SMTP_* to enable)');
    return { status: 'not_configured', provider_id: null };
  },

  whatsapp: async ({ to, template, variables }) => {
    if (!to) return { status: 'failed', error: 'no recipient' };
    // One copy of the Twilio transport, shared with the whatsapp worker — see
    // whatsappDelivery.js. The notification log records exactly what it returns.
    const { sendText } = require('../../services/whatsappDelivery');
    return sendText({ to, template, variables });
  },

  sms: async ({ to, body }) => {
    if (!to) return { status: 'failed', error: 'no recipient' };

    const sid   = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from  = process.env.TWILIO_SMS_FROM;
    if (sid && token && from) {
      try {
        const params = new URLSearchParams({ From: from, To: to, Body: body });
        const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
          },
          body: params.toString(),
        });
        const data = await res.json();
        if (!res.ok) {
          logger.error({ status: res.status, data }, 'twilio sms failed');
          return { status: 'failed', error: data.message || 'twilio error' };
        }
        return { status: 'sent', provider_id: data.sid };
      } catch (err) {
        logger.error({ err: err.message }, 'twilio sms exception');
        return { status: 'failed', error: err.message };
      }
    }

    logger.warn({ to }, 'sms not_configured (set TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_SMS_FROM)');
    return { status: 'not_configured', provider_id: null };
  },

  push: async ({ device_token, title, body }) => {
    if (!device_token) return { status: 'failed', error: 'no token' };

    const serverKey = process.env.FCM_SERVER_KEY;
    if (serverKey) {
      try {
        const res = await fetch('https://fcm.googleapis.com/fcm/send', {
          method: 'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `key=${serverKey}`,
          },
          body: JSON.stringify({
            to: device_token,
            notification: { title, body },
          }),
        });
        const data = await res.json();
        if (!res.ok || data.failure) {
          logger.error({ data }, 'fcm push failed');
          return { status: 'failed', error: data.results?.[0]?.error || 'fcm error' };
        }
        return { status: 'sent', provider_id: data.multicast_id?.toString() };
      } catch (err) {
        logger.error({ err: err.message }, 'fcm push exception');
        return { status: 'failed', error: err.message };
      }
    }

    logger.warn({ title }, 'push not_configured (set FCM_SERVER_KEY)');
    return { status: 'not_configured', provider_id: null };
  },
};

// ─── Notification templates ─────────────────────────────────────────────────
const templates = {
  payment_received: ({ name, amount, currency = '₹' }) => ({
    title: 'Payment received',
    body: `Hi ${name}, we received your payment of ${currency}${amount}. Thanks!`,
    email: {
      subject: 'Payment receipt — MY PT STUDIO',
      html: `<p>Hi ${name},</p><p>We received your payment of <b>${currency}${amount}</b>.</p>`,
    },
    whatsapp: { template: 'payment_received', variables: [name, `${currency}${amount}`] },
  }),
  membership_expiring: ({ name, days, plan }) => ({
    title: `Membership expiring in ${days} days`,
    body: `Your ${plan} plan ends in ${days} days. Renew to keep training.`,
    email: {
      subject: `Your membership expires in ${days} days`,
      html: `<p>Hi ${name},</p><p>Your <b>${plan}</b> ends in <b>${days} days</b>.</p>`,
    },
    whatsapp: { template: 'membership_expiring', variables: [name, String(days), plan] },
  }),
  class_reminder: ({ name, class_name, time }) => ({
    title: `${class_name} starts soon`,
    body: `Hi ${name}, reminder: ${class_name} at ${time}.`,
    whatsapp: { template: 'class_reminder', variables: [name, class_name, time] },
  }),
  booking_confirmed: ({ name, class_name, time }) => ({
    title: 'Booking confirmed',
    body: `Hi ${name}, you're booked for ${class_name} at ${time}.`,
    whatsapp: { template: 'booking_confirmed', variables: [name, class_name, time] },
  }),
  waitlist_promoted: ({ name, class_name, time }) => ({
    title: 'A spot opened up!',
    body: `Hi ${name}, you've been moved from the waitlist to confirmed for ${class_name} at ${time}.`,
    whatsapp: { template: 'waitlist_promoted', variables: [name, class_name, time] },
  }),
};

/**
 * Deliver one notification through one channel: resolve template args, call
 * the channel adapter, and write the attempt to notification_log. Shared by
 * the inline fallback path (send) and the notifications worker.
 */
async function deliverChannel(ch, type, recipient, data) {
  const tpl = templates[type]?.({ ...data, name: recipient.name });
  if (!tpl) throw new Error(`Unknown notification template: ${type}`);

  let adapterArgs;
  switch (ch) {
    case 'inapp':    adapterArgs = { user_id: recipient.user_id, title: tpl.title, body: tpl.body, link: data.link }; break;
    case 'email':    adapterArgs = { to: recipient.email, ...tpl.email }; break;
    case 'whatsapp': adapterArgs = { to: recipient.phone, ...tpl.whatsapp }; break;
    case 'sms':      adapterArgs = { to: recipient.phone, body: tpl.body }; break;
    case 'push':     adapterArgs = { device_token: recipient.device_token, title: tpl.title, body: tpl.body }; break;
    default: throw new Error(`Unknown channel: ${ch}`);
  }

  let res;
  try {
    res = await channels[ch](adapterArgs);
  } catch (err) {
    res = { status: 'failed', error: err.message };
  }

  // Log the attempt
  try {
    await pool.query(
      `INSERT INTO notification_log (recipient_user_id, recipient_member_id, channel, template, payload, status, provider_id, error, sent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $6='sent' OR $6='delivered' THEN NOW() END)`,
      [
        recipient.user_id || null,
        recipient.member_id || null,
        ch, type, data,
        res.status,
        res.provider_id || null,
        res.error || null,
      ]
    );
  } catch {
    logger.warn('notification_log table may not exist yet');
  }
  return res;
}

/**
 * Send a notification to a recipient through one or more channels.
 *
 * With Redis available each channel is enqueued as its own job on the
 * 'notifications' queue (fan-out: one failure retries without blocking the
 * other channels) and this returns {status:'queued', jobId}. Without Redis —
 * or if the enqueue fails — delivery degrades to the inline adapter, so a
 * queue outage costs latency, never a lost message.
 *
 * @param {string} type - template key
 * @param {object} recipient - { user_id, member_id, email, phone, device_token, name }
 * @param {object} data - template variables
 * @param {string[]} via - channels to use (default: ['inapp'])
 * @param {object} [opts]
 * @param {string} [opts.organizationId] - the studio this send belongs to,
 *   taken from trusted server context (req.user.organization_id), NEVER from
 *   anything the caller supplied. Stamped onto the job so the worker can check
 *   it against the recipient's authoritative organization before delivering.
 * @param {'tenant'|'platform'} [opts.scope] - 'platform' marks a send that
 *   legitimately crosses studios (the renewal sweep). Declared, so that "no
 *   organization" is a statement rather than an omission.
 */
async function send(type, recipient, data, via = ['inapp'], opts = {}) {
  if (!templates[type]) throw new Error(`Unknown notification template: ${type}`);

  const { organizationId = null, scope = organizationId ? 'tenant' : undefined } = opts;

  const results = {};
  for (const ch of via) {
    if (!channels[ch]) continue;

    let queued = null;
    try {
      const redis = require('../../lib/redis');
      if (await redis.ensureReady()) {
        const { enqueueNotification } = require('../../services/notificationFanout');
        queued = await enqueueNotification(ch, type, recipient, data, {}, { organizationId, scope });
      }
    } catch (err) {
      logger.warn({ err: err.message, ch, type }, 'notify enqueue failed — sending inline');
    }

    results[ch] = queued
      ? { status: 'queued', jobId: queued.id }
      : await deliverChannel(ch, type, recipient, data);
  }
  return results;
}

/**
 * The tenant check a queued notification passes before it is delivered.
 *
 * The rule is the one knowledgeBase.js already follows for the AI queue: a job
 * payload is not evidence of anything. The organization stamped on the job is
 * compared against the organization the RECIPIENT actually belongs to, read
 * back out of the database at processing time. They must agree.
 *
 * Three cases deliberately pass rather than throw, and each is a different
 * thing:
 *
 *   · scope === 'platform' — the renewal sweep and its kin, which are supposed
 *     to address every studio. Declared at enqueue, never inferred.
 *   · no organizationId at all — a job enqueued by an older build that was
 *     already on the queue when this shipped. Rejecting those would drop real
 *     messages during a single deploy for no security gain, since the old jobs
 *     are exactly as trustworthy as they were yesterday. Logged, not failed.
 *   · nothing to re-derive from — a recipient that is only an email address or
 *     a phone number has no row to look up, and delivering to an address is not
 *     a tenant-scoped act. There is no mismatch to detect, so there is nothing
 *     to refuse.
 *
 * A genuine mismatch — the payload says studio A, the recipient belongs to
 * studio B — throws, which fails the job and puts it in the Command Center's
 * failed list, and writes an audit row first so the attempt survives the retry.
 */
async function assertJobTenant(job) {
  const { organizationId, scope, recipient = {}, ch, type } = job.data || {};

  if (scope === 'platform') return;
  if (!organizationId) {
    logger.warn({ jobId: job.id, ch, type }, 'notification job carries no organization — legacy job, delivering unverified');
    return;
  }

  // Re-derive from the most specific identifier available. A client id is
  // preferred over a user id: the in-app channel addresses users, but the
  // broadcast path names clients, and pt_clients is where the tenant boundary
  // actually lives.
  let actual;
  if (recipient.member_id) {
    const { rows } = await pool.query(
      'SELECT organization_id FROM pt_clients WHERE id = $1', [recipient.member_id]
    );
    if (rows.length) actual = rows[0].organization_id;
  }
  if (actual === undefined && recipient.user_id) {
    const { rows } = await pool.query(
      'SELECT organization_id FROM users WHERE id = $1', [recipient.user_id]
    );
    if (rows.length) actual = rows[0].organization_id;
  }

  if (actual === undefined) return;               // nothing to compare against
  if (String(actual) === String(organizationId)) return;

  // Audited BEFORE the throw. A failed job is retried, and the retry would
  // otherwise be the only trace left of a cross-tenant attempt.
  try {
    await pool.query(
      `INSERT INTO activity_log
         (user_id, user_name, action, entity_type, entity_id, new_data, organization_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        null,
        'notifications worker',
        'notification.tenant_mismatch_rejected',
        'notification',
        String(recipient.member_id || recipient.user_id || ''),
        JSON.stringify({ job_organization_id: organizationId, recipient_organization_id: actual, channel: ch, template: type }),
        organizationId,
      ]
    );
  } catch (err) {
    logger.error({ err: err.message }, 'failed to audit notification tenant mismatch');
  }

  logger.error(
    { jobId: job.id, ch, type, job_org: organizationId, recipient_org: actual },
    'notification_tenant_mismatch — refusing to deliver across studios',
  );
  throw new Error('Notification tenant mismatch: recipient belongs to a different organization');
}

/**
 * Worker processor: deliver a single queued notification job (one channel).
 * Throws on unknown template/channel so BullMQ marks the job failed instead of
 * silently completing it.
 */
async function processNotificationJob(job) {
  const { ch, type, recipient, data } = job.data || {};
  if (!channels[ch]) throw new Error(`Unknown notification channel: ${ch}`);
  if (!templates[type]) throw new Error(`Unknown notification template: ${type}`);
  await assertJobTenant(job);
  return deliverChannel(ch, type, recipient, data);
}

/**
 * Resolve a member into a recipient object with all contact info, within one
 * studio. Throws if the id does not belong to `organizationId`.
 */
async function recipientFromMember(memberId, organizationId) {
  // ── Why this takes an organization id, and why it reads pt_clients ─────────
  //
  // It used to loop over ['clients', 'members'] with `WHERE c.id = $1` and no
  // tenant predicate of any kind. Its one caller is POST /api/v1/notifications/
  // broadcast, which takes `member_ids` straight out of the request body behind
  // requireRole('admin','manager') — the TENANT studio-owner role. So the id was
  // caller-chosen and the lookup was platform-wide: a studio passing another
  // studio's client id would have had that client's name, email and phone
  // resolved, and a notification delivered to them.
  //
  // That was not exploitable, for a reason that is not reassuring: BOTH of those
  // tables are the abandoned legacy ones, both are empty in production, and
  // neither has an organization_id column to filter on even in principle (see
  // __tests__/clients.legacy-table.test.js, and the note in server.js about the
  // v3 routes deleted for exactly this shape). Every call threw 'Recipient not
  // found'. It was safe by being dead, which lasts exactly until somebody
  // populates a table.
  //
  // pt_clients is the table the product actually writes, it carries
  // organization_id (079, NOT NULL since 155) and the user_id link (154) that
  // the in-app channel needs to address a row at a person. So this resolves
  // there, scoped, and fails closed when no organization is known rather than
  // falling back to a platform-wide read.
  if (!organizationId) {
    const err = new Error('Cannot resolve a recipient without an organization context');
    err.status = 403;
    err.code = 'NO_TENANT';
    throw err;
  }

  const { rows } = await pool.query(
    `SELECT c.id AS member_id, c.user_id, c.name, c.email, c.mobile AS phone,
            c.organization_id
       FROM pt_clients c
      WHERE c.id = $1
        AND c.organization_id = $2
        AND c.deleted_at IS NULL`,
    [memberId, organizationId]
  );
  // Deliberately the same error whether the id does not exist or belongs to
  // another studio — telling those apart is exactly what a caller probing ids
  // wants to learn.
  if (!rows.length) throw new Error('Recipient not found');
  return rows[0];
}

/**
 * Inbox: fetch unread/recent notifications for current user.
 */
async function inbox(userId, { unreadOnly = false, limit = 50 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, type, title, body, link, read_at, created_at
     FROM notifications
     WHERE user_id = $1 ${unreadOnly ? 'AND read_at IS NULL' : ''}
     ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

async function markRead(notifId, userId) {
  await pool.query(
    `UPDATE notifications SET read_at = NOW() WHERE id = $1 AND user_id = $2`,
    [notifId, userId]
  );
}

async function markAllRead(userId) {
  await pool.query(
    `UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL`,
    [userId]
  );
}

module.exports = { send, deliverChannel, processNotificationJob, assertJobTenant, recipientFromMember, inbox, markRead, markAllRead, templates, channels };

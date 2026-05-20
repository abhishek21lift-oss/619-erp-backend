// src/modules/notifications/notifications.service.js
// Multi-channel notification orchestrator: email + WhatsApp + SMS + push + in-app.
//
// In production, channel adapters push to a queue (BullMQ). For demo we call
// them inline. Each adapter is pluggable.

const pool = require('../../db/pool');

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
    // TODO: integrate Resend/SES.
    // Example with Resend:
    //   await resend.emails.send({ from: 'no-reply@619fitness.com', to, subject, html });
    if (!to) return { status: 'failed', error: 'no recipient' };
    console.log('[email]', to, subject);
    return { status: 'sent', provider_id: `email_${Date.now()}` };
  },

  whatsapp: async ({ to, template, variables }) => {
    // TODO: integrate Meta Cloud API or Gupshup.
    // Templates must be pre-approved in WhatsApp Business.
    if (!to) return { status: 'failed', error: 'no recipient' };
    console.log('[wa]', to, template, variables);
    return { status: 'sent', provider_id: `wa_${Date.now()}` };
  },

  sms: async ({ to, body }) => {
    // TODO: integrate MSG91 / Twilio.
    if (!to) return { status: 'failed', error: 'no recipient' };
    console.log('[sms]', to, body);
    return { status: 'sent', provider_id: `sms_${Date.now()}` };
  },

  push: async ({ device_token, title, body }) => {
    // TODO: integrate FCM.
    if (!device_token) return { status: 'failed', error: 'no token' };
    console.log('[push]', title);
    return { status: 'sent', provider_id: `push_${Date.now()}` };
  },
};

// ─── Notification templates ─────────────────────────────────────────────────
const templates = {
  payment_received: ({ name, amount, currency = '₹' }) => ({
    title: 'Payment received',
    body: `Hi ${name}, we received your payment of ${currency}${amount}. Thanks!`,
    email: {
      subject: 'Payment receipt — 619 Fitness',
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
 * Send a notification to a recipient through one or more channels.
 * @param {string} type - template key
 * @param {object} recipient - { user_id, member_id, email, phone, device_token, name }
 * @param {object} data - template variables
 * @param {string[]} via - channels to use (default: ['inapp'])
 */
async function send(type, recipient, data, via = ['inapp']) {
  const tpl = templates[type]?.({ ...data, name: recipient.name });
  if (!tpl) throw new Error(`Unknown notification template: ${type}`);

  const results = {};
  for (const ch of via) {
    let adapterArgs;
    switch (ch) {
      case 'inapp':    adapterArgs = { user_id: recipient.user_id, title: tpl.title, body: tpl.body, link: data.link }; break;
      case 'email':    adapterArgs = { to: recipient.email, ...tpl.email }; break;
      case 'whatsapp': adapterArgs = { to: recipient.phone, ...tpl.whatsapp }; break;
      case 'sms':      adapterArgs = { to: recipient.phone, body: tpl.body }; break;
      case 'push':     adapterArgs = { device_token: recipient.device_token, title: tpl.title, body: tpl.body }; break;
      default: continue;
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
      // notification_log table may not exist yet
      console.warn('[notifications] failed to log notification (table may not exist)');
    }
    results[ch] = res;
  }
  return results;
}

/**
 * Resolve a member into a recipient object with all contact info.
 */
async function recipientFromMember(memberId) {
  // Try the clients table first (619 ERP schema), fall back to members
  for (const table of ['clients', 'members']) {
    try {
      const col = table === 'clients' ? 'id' : 'id';
      const { rows } = await pool.query(
        `SELECT c.id AS member_id, c.name, c.email, c.mobile AS phone, NULL AS user_id
         FROM ${table} c WHERE c.id = $1`,
        [memberId]
      );
      if (rows.length > 0) return rows[0];
    } catch {
      // table may not exist, try next
    }
  }
  throw new Error('Recipient not found');
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

module.exports = { send, recipientFromMember, inbox, markRead, templates };

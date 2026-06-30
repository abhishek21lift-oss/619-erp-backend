'use strict';
const { z }    = require('zod');
const pool     = require('../../../db/pool');
const { toolRegistry } = require('../registry/ToolRegistry');
const { PermissionValidator } = require('../middleware/PermissionValidator');
const notificationsSvc = require('../../modules/notifications/notifications.service');

// ─── Tool implementations ────────────────────────────────────────────────────

async function sendWhatsApp({ client_id, message }, context) {
  PermissionValidator.requireRole(context, 'admin', 'manager', 'trainer', 'staff');

  const { rows: [client] } = await pool.query(
    `SELECT id, first_name || ' ' || last_name AS name, mobile, trainer_id
     FROM pt_clients WHERE id = $1 AND deleted_at IS NULL`,
    [client_id]
  );
  if (!client) throw new Error('Client not found');
  if (context.isTrainer()) PermissionValidator.requireTrainerOwnership(context, client.trainer_id);
  if (!client.mobile) throw new Error('Client has no mobile number on record');

  const result = await notificationsSvc.send({
    channel:  'whatsapp',
    to:       client.mobile,
    body:     message,
    user_id:  null,
  });
  return { success: true, client_name: client.name, mobile: client.mobile, result };
}

async function sendBulkWhatsApp({ client_ids, message, filters }, context) {
  PermissionValidator.requireRole(context, 'admin', 'manager');

  let targetClients = [];

  if (client_ids?.length) {
    const { rows } = await pool.query(
      `SELECT id, first_name || ' ' || last_name AS name, mobile
       FROM pt_clients WHERE id = ANY($1) AND deleted_at IS NULL AND mobile IS NOT NULL`,
      [client_ids]
    );
    targetClients = rows;
  } else if (filters) {
    // Filter-based bulk send (e.g. all active clients with dues)
    const conditions = ['c.deleted_at IS NULL', 'c.mobile IS NOT NULL'];
    const params = [];
    let p = 1;

    if (filters.status)  { conditions.push(`c.status = $${p++}`);    params.push(filters.status); }
    if (filters.has_dues) conditions.push(`c.balance < 0`);
    if (filters.expiring_within_days) {
      const cutoff = new Date(Date.now() + filters.expiring_within_days * 86400000).toISOString().slice(0, 10);
      conditions.push(`c.pt_end_date <= $${p++}`); params.push(cutoff);
    }

    const { rows } = await pool.query(
      `SELECT id, first_name || ' ' || last_name AS name, mobile
       FROM pt_clients c WHERE ${conditions.join(' AND ')} LIMIT 200`,
      params
    );
    targetClients = rows;
  }

  let sent = 0, failed = 0;
  for (const client of targetClients) {
    try {
      await notificationsSvc.send({ channel: 'whatsapp', to: client.mobile, body: message, user_id: null });
      sent++;
    } catch { failed++; }
  }

  return {
    total_recipients: targetClients.length,
    sent, failed,
    preview_recipients: targetClients.slice(0, 5).map(c => c.name),
  };
}

async function sendEmail({ client_id, subject, html_body }, context) {
  PermissionValidator.requireRole(context, 'admin', 'manager', 'trainer', 'staff');

  const { rows: [client] } = await pool.query(
    `SELECT id, first_name || ' ' || last_name AS name, email, trainer_id
     FROM pt_clients WHERE id = $1 AND deleted_at IS NULL`,
    [client_id]
  );
  if (!client) throw new Error('Client not found');
  if (!client.email) throw new Error('Client has no email on record');

  const result = await notificationsSvc.send({
    channel:  'email',
    to:       client.email,
    subject,
    html:     html_body,
    user_id:  null,
  });
  return { success: true, client_name: client.name, email: client.email, result };
}

async function sendReminder({ type, filters, message_template }, context) {
  PermissionValidator.requireRole(context, 'admin', 'manager');

  // Supported reminder types: 'dues', 'expiry', 'session'
  const templates = {
    dues:   (name, amount) => `Hi ${name}, your outstanding balance is ₹${amount}. Please clear dues at the earliest. - 619 Fitness`,
    expiry: (name, date)   => `Hi ${name}, your membership expires on ${date}. Contact us to renew. - 619 Fitness`,
    session:(name, date)   => `Hi ${name}, your next PT session is on ${date}. See you there! - 619 Fitness`,
  };

  let clients = [];
  if (type === 'dues') {
    const { rows } = await pool.query(
      `SELECT id, first_name || ' ' || last_name AS name, mobile, balance
       FROM pt_clients WHERE deleted_at IS NULL AND balance < 0 AND mobile IS NOT NULL LIMIT 100`
    );
    clients = rows;
  } else if (type === 'expiry') {
    const cutoff = new Date(Date.now() + (filters?.days || 7) * 86400000).toISOString().slice(0, 10);
    const today  = new Date().toISOString().slice(0, 10);
    const { rows } = await pool.query(
      `SELECT id, first_name || ' ' || last_name AS name, mobile, pt_end_date
       FROM pt_clients WHERE deleted_at IS NULL AND status='active'
         AND pt_end_date BETWEEN $1 AND $2 AND mobile IS NOT NULL LIMIT 100`,
      [today, cutoff]
    );
    clients = rows;
  }

  let sent = 0, failed = 0;
  for (const c of clients) {
    try {
      const msg = message_template
        ? message_template.replace('{{name}}', c.name)
        : (type === 'dues'
          ? templates.dues(c.name, Math.abs(c.balance))
          : templates.expiry(c.name, c.pt_end_date));
      await notificationsSvc.send({ channel: 'whatsapp', to: c.mobile, body: msg, user_id: null });
      sent++;
    } catch { failed++; }
  }

  return { type, total: clients.length, sent, failed };
}

// ─── Registration ────────────────────────────────────────────────────────────

toolRegistry
  .register('communication.sendWhatsApp',
    sendWhatsApp,
    z.object({
      client_id: z.union([z.string(), z.number()]),
      message:   z.string().min(1).max(1600),
    }),
    ['admin','manager','trainer','staff'],
    true  // write action
  )
  .register('communication.sendBulkWhatsApp',
    sendBulkWhatsApp,
    z.object({
      client_ids: z.array(z.union([z.string(), z.number()])).optional(),
      message:    z.string().min(1).max(1600),
      filters:    z.object({
        status:               z.string().optional(),
        has_dues:             z.boolean().optional(),
        expiring_within_days: z.number().int().optional(),
      }).optional(),
    }),
    ['admin','manager'],
    true  // write action
  )
  .register('communication.sendEmail',
    sendEmail,
    z.object({
      client_id: z.union([z.string(), z.number()]),
      subject:   z.string().min(1).max(200),
      html_body: z.string().min(1),
    }),
    ['admin','manager','trainer','staff'],
    true  // write action
  )
  .register('communication.sendReminder',
    sendReminder,
    z.object({
      type:             z.enum(['dues','expiry','session']),
      filters:          z.object({ days: z.number().int().optional() }).optional(),
      message_template: z.string().optional(),
    }),
    ['admin','manager'],
    true  // write action
  );

module.exports = { sendWhatsApp, sendBulkWhatsApp, sendEmail, sendReminder };

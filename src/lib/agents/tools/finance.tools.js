'use strict';
const { z }    = require('zod');
const pool     = require('../../../db/pool');
const { toolRegistry } = require('../registry/ToolRegistry');
const { PermissionValidator } = require('../middleware/PermissionValidator');

// ─── Tool implementations ────────────────────────────────────────────────────

async function getRevenue({ from, to }, context) {
  PermissionValidator.requireMinRole(context, 'manager');
  const fromDate = from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const toDate   = to   || new Date().toISOString().slice(0, 10);

  const [pt, gym] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS count
       FROM pt_payments WHERE date BETWEEN $1 AND $2`,
      [fromDate, toDate]
    ),
    pool.query(
      `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS count
       FROM payments WHERE date BETWEEN $1 AND $2 AND deleted_at IS NULL`,
      [fromDate, toDate]
    ),
  ]);
  return {
    period:  { from: fromDate, to: toDate },
    pt_revenue:  { total: Number(pt.rows[0].total),  count: Number(pt.rows[0].count)  },
    gym_revenue: { total: Number(gym.rows[0].total), count: Number(gym.rows[0].count) },
    combined_total: Number(pt.rows[0].total) + Number(gym.rows[0].total),
  };
}

async function getDues({ limit = 50 }, context) {
  PermissionValidator.requireMinRole(context, 'manager');

  const conditions = ['c.deleted_at IS NULL', 'c.balance < 0'];
  const params = [];
  let p = 1;
  if (context.isTrainer() && context.trainerId) {
    conditions.push(`c.trainer_id = $${p++}`); params.push(context.trainerId);
  }

  const { rows } = await pool.query(
    `SELECT c.id, c.first_name || ' ' || c.last_name AS name,
            c.mobile, c.balance AS outstanding_amount, c.trainer_name
     FROM pt_clients c
     WHERE ${conditions.join(' AND ')}
     ORDER BY c.balance ASC
     LIMIT $${p}`,
    [...params, limit]
  );

  const total_outstanding = rows.reduce((s, r) => s + Math.abs(Number(r.outstanding_amount)), 0);
  return { clients_with_dues: rows.length, total_outstanding, clients: rows };
}

async function getPaymentHistory({ client_id, limit = 20 }, context) {
  const { rows } = await pool.query(
    `SELECT id, amount, date, payment_mode, notes, receipt_no, created_at
     FROM pt_payments
     WHERE client_id = $1
     ORDER BY date DESC, created_at DESC
     LIMIT $2`,
    [client_id, limit]
  );
  return { client_id, count: rows.length, payments: rows };
}

async function recordPTPayment({ client_id, amount, payment_mode = 'cash', notes, date }, context) {
  PermissionValidator.requireRole(context, 'admin', 'manager', 'trainer', 'staff', 'reception', 'receptionist');

  // Verify client exists
  const { rows: [client] } = await pool.query(
    `SELECT id, first_name || ' ' || last_name AS name, trainer_id, trainer_name
     FROM pt_clients WHERE id = $1 AND deleted_at IS NULL`,
    [client_id]
  );
  if (!client) throw new Error('Client not found');
  if (context.isTrainer()) PermissionValidator.requireTrainerOwnership(context, client.trainer_id);

  const paymentDate = date || new Date().toISOString().slice(0, 10);
  const amt = parseFloat(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('Amount must be a positive number');

  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');

    const { rows } = await tx.query(
      `INSERT INTO pt_payments (client_id, trainer_id, amount, date, payment_mode, notes, type)
       VALUES ($1, (SELECT trainer_id FROM pt_clients WHERE id=$1), $2, $3, $4, $5, 'pt')
       RETURNING id, amount, date, payment_mode`,
      [client_id, amt, paymentDate, payment_mode, notes || null]
    );

    // Update client balance
    await tx.query(
      `UPDATE pt_clients SET paid_amount = paid_amount + $1, balance_amount = GREATEST(balance_amount - $1, 0), updated_at = NOW() WHERE id = $2`,
      [amt, client_id]
    );

    await tx.query('COMMIT');
    return { success: true, payment: rows[0], client_name: client.name };
  } catch (err) {
    await tx.query('ROLLBACK');
    throw err;
  } finally {
    tx.release();
  }
}

async function getTrainerRevenue({ from, to, limit = 20 }, context) {
  PermissionValidator.requireMinRole(context, 'manager');
  const fromDate = from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const toDate   = to   || new Date().toISOString().slice(0, 10);

  const { rows } = await pool.query(
    `SELECT t.first_name || ' ' || t.last_name AS trainer_name,
            COUNT(p.id) AS payments,
            COALESCE(SUM(p.amount), 0) AS revenue,
            COUNT(DISTINCT p.client_id) AS clients
     FROM pt_trainers t
     LEFT JOIN pt_payments p ON p.trainer_id = t.id AND p.date BETWEEN $1 AND $2
     WHERE t.deleted_at IS NULL
     GROUP BY t.id, trainer_name
     ORDER BY revenue DESC
     LIMIT $3`,
    [fromDate, toDate, limit]
  );
  return { period: { from: fromDate, to: toDate }, trainers: rows };
}

// ─── Registration ────────────────────────────────────────────────────────────

toolRegistry
  .register('finance.getRevenue',
    getRevenue,
    z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
    ['admin','manager'],
    false
  )
  .register('finance.getDues',
    getDues,
    z.object({ limit: z.number().int().max(200).optional() }),
    ['admin','manager','trainer'],
    false
  )
  .register('finance.getPaymentHistory',
    getPaymentHistory,
    z.object({
      client_id: z.union([z.string(), z.number()]),
      limit:     z.number().int().max(100).optional(),
    }),
    ['admin','manager','trainer','staff'],
    false
  )
  .register('finance.recordPTPayment',
    recordPTPayment,
    z.object({
      client_id:    z.union([z.string(), z.number()]),
      amount:       z.number().positive(),
      payment_mode: z.string().optional(),
      notes:        z.string().optional(),
      date:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
    ['admin','manager','trainer','staff','reception','receptionist'],
    true  // write action
  )
  .register('finance.getTrainerRevenue',
    getTrainerRevenue,
    z.object({
      from:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      limit: z.number().int().max(50).optional(),
    }),
    ['admin','manager'],
    false
  );

module.exports = { getRevenue, getDues, getPaymentHistory, recordPTPayment, getTrainerRevenue };

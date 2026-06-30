'use strict';
const { z }    = require('zod');
const pool     = require('../../../db/pool');
const { toolRegistry } = require('../registry/ToolRegistry');
const { PermissionValidator } = require('../middleware/PermissionValidator');

// ─── Tool implementations ────────────────────────────────────────────────────

async function getActive({ client_id }, context) {
  const { rows } = await pool.query(
    `SELECT id, plan_name, start_date, end_date, duration_months,
            selling_price, amount_paid, balance_amount, trainer_name, status, source, created_at
     FROM pt_client_subscriptions
     WHERE client_id = $1 AND status = 'active'
     ORDER BY start_date DESC NULLS LAST, created_at DESC`,
    [client_id]
  );
  return { client_id, subscriptions: rows };
}

async function getExpiring({ days = 7, limit = 50 }, context) {
  PermissionValidator.requireMinRole(context, 'manager');
  const cutoff = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const today  = new Date().toISOString().slice(0, 10);

  const { rows } = await pool.query(
    `SELECT c.id, c.first_name || ' ' || c.last_name AS name,
            c.mobile, c.pt_end_date AS end_date, c.trainer_name, c.status
     FROM pt_clients c
     WHERE c.deleted_at IS NULL
       AND c.status = 'active'
       AND c.pt_end_date IS NOT NULL
       AND c.pt_end_date BETWEEN $1 AND $2
     ORDER BY c.pt_end_date ASC
     LIMIT $3`,
    [today, cutoff, limit]
  );
  return { expiring_within_days: days, count: rows.length, clients: rows };
}

async function getHistory({ client_id }, context) {
  const [subs, renewals] = await Promise.all([
    pool.query(
      `SELECT plan_name, start_date, end_date, duration_months,
              selling_price, amount_paid, balance_amount, status, source, created_at
       FROM pt_client_subscriptions WHERE client_id = $1
       ORDER BY start_date ASC NULLS LAST, created_at ASC`,
      [client_id]
    ),
    pool.query(
      `SELECT old_package, new_package, new_start_date, new_end_date,
              duration_months, final_amount, paid_amount, balance_amount, renewed_at
       FROM pt_client_renewals WHERE client_id = $1
       ORDER BY renewed_at DESC`,
      [client_id]
    ),
  ]);
  return {
    client_id,
    subscriptions: subs.rows,
    renewals:      renewals.rows,
  };
}

async function renewSubscription({ client_id, package_type, duration_months, final_amount, paid_amount, notes, pt_start_date }, context) {
  PermissionValidator.requireRole(context, 'admin', 'manager', 'trainer', 'staff');

  const { rows: [client] } = await pool.query(
    `SELECT id, first_name || ' ' || last_name AS name, trainer_id, trainer_name,
            package_type AS current_package, pt_end_date
     FROM pt_clients WHERE id = $1 AND deleted_at IS NULL`,
    [client_id]
  );
  if (!client) throw new Error('Client not found');
  if (context.isTrainer()) PermissionValidator.requireTrainerOwnership(context, client.trainer_id);

  const months   = parseInt(duration_months) || 3;
  const startDt  = pt_start_date || (client.pt_end_date
    ? new Date(client.pt_end_date).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10));

  const endDate = new Date(startDt);
  endDate.setMonth(endDate.getMonth() + months);
  const endDt = endDate.toISOString().slice(0, 10);

  const finalAmt = parseFloat(final_amount) || 0;
  const paidNow  = parseFloat(paid_amount)  || 0;
  const balance  = Math.max(finalAmt - paidNow, 0);

  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');

    // Update pt_clients
    await tx.query(
      `UPDATE pt_clients SET
         package_type = $2, pt_start_date = $3, pt_end_date = $4,
         duration_months = $5, base_amount = $6, paid_amount = paid_amount + $7,
         balance_amount = $8, status = 'active', updated_at = NOW()
       WHERE id = $1`,
      [client_id, package_type || client.current_package, startDt, endDt, months, finalAmt, paidNow, balance]
    );

    // Log renewal
    await tx.query(
      `INSERT INTO pt_client_renewals
         (client_id, client_name, trainer_name, old_package, new_package,
          old_end_date, new_start_date, new_end_date, duration_months,
          base_amount, discount, final_amount, paid_amount, balance_amount, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12,$13,$14)`,
      [client_id, client.name, client.trainer_name,
       client.current_package, package_type || client.current_package,
       client.pt_end_date, startDt, endDt, months,
       finalAmt, finalAmt, paidNow, balance, notes || null]
    );

    // Add to subscriptions history
    await tx.query(
      `INSERT INTO pt_client_subscriptions
         (client_id, plan_name, start_date, end_date, duration_months,
          selling_price, amount_paid, balance_amount, trainer_name, status, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active','renewal')
       ON CONFLICT DO NOTHING`,
      [client_id, package_type || client.current_package, startDt, endDt, months,
       finalAmt, paidNow, balance, client.trainer_name]
    );

    await tx.query('COMMIT');
    return {
      success: true, client_name: client.name,
      new_end_date: endDt, duration_months: months,
      final_amount: finalAmt, paid_amount: paidNow, balance,
    };
  } catch (err) {
    await tx.query('ROLLBACK');
    throw err;
  } finally {
    tx.release();
  }
}

// ─── Registration ────────────────────────────────────────────────────────────

toolRegistry
  .register('subscription.getActive',
    getActive,
    z.object({ client_id: z.union([z.string(), z.number()]) }),
    ['admin','manager','trainer','staff'],
    false
  )
  .register('subscription.getExpiring',
    getExpiring,
    z.object({
      days:  z.number().int().min(1).max(90).optional(),
      limit: z.number().int().max(200).optional(),
    }),
    ['admin','manager'],
    false
  )
  .register('subscription.getHistory',
    getHistory,
    z.object({ client_id: z.union([z.string(), z.number()]) }),
    ['admin','manager','trainer','staff'],
    false
  )
  .register('subscription.renew',
    renewSubscription,
    z.object({
      client_id:       z.union([z.string(), z.number()]),
      package_type:    z.string().optional(),
      duration_months: z.number().int().min(1).max(60),
      final_amount:    z.number().min(0),
      paid_amount:     z.number().min(0),
      notes:           z.string().optional(),
      pt_start_date:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
    ['admin','manager','trainer','staff'],
    true  // write action
  );

module.exports = { getActive, getExpiring, getHistory, renewSubscription };

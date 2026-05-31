// src/modules/pt-os/pt-os.service.js
// PT OS business logic â€” commission engine, calculations, aggregations

const pool = require('../../db/pool');

// â”€â”€â”€ Commission Engine â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Calculate + upsert monthly commission for all active PT clients
async function calculateMonthlyCommissions(month) {
  const monthStart = `${month}-01`;
  const client = await pool.connect();
  try {
    // Get the first and last day of the target month
    const mStart = new Date(monthStart + 'T00:00:00Z');
    const mEnd = new Date(mStart.getFullYear(), mStart.getMonth() + 1, 1);
    const mEndStr = mEnd.toISOString().slice(0, 10);

    // Get all active PT clients with trainers whose PT period covers this month
    const { rows: clients } = await pool.query(`
      SELECT c.id, c.name, c.trainer_id, c.trainer_name,
             c.monthly_pt_amount, c.trainer_commission,
             t.incentive_rate
      FROM clients c
      JOIN trainers t ON t.id = c.trainer_id
      WHERE c.deleted_at IS NULL
        AND c.status IN ('active','frozen')
        AND c.trainer_id IS NOT NULL
        AND c.pt_start_date IS NOT NULL
        AND (c.pt_end_date IS NULL OR c.pt_end_date >= $1)
        AND c.pt_start_date <= $2
        AND c.monthly_pt_amount > 0
    `, [mStart.toISOString().slice(0, 10), mEndStr]);

    const results = [];
    for (const cl of clients) {
      const commission = Number(cl.trainer_commission);
      // Upsert commission record
      const { rows } = await pool.query(`
        INSERT INTO pt_commissions
          (trainer_id, trainer_name, client_id, client_name,
           month, commission_amt, incentive_rate, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')
        ON CONFLICT (trainer_id, client_id, month)
        DO UPDATE SET commission_amt = EXCLUDED.commission_amt,
                      incentive_rate = EXCLUDED.incentive_rate,
                      updated_at = NOW()
        RETURNING *
      `, [
        cl.trainer_id, cl.trainer_name,
        cl.id, cl.name,
        monthStart, commission, cl.incentive_rate,
      ]);
      results.push(rows[0]);
    }
    return { count: results.length, total: results.reduce((s, r) => s + Number(r.commission_amt), 0) };
  } finally {
    client.release();
  }
}

// â”€â”€â”€ Get trainer payout summary for a month â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function getTrainerPayouts(month) {
  const monthStart = `${month}-01`;
  const { rows } = await pool.query(`
    SELECT
      t.id AS trainer_id,
      t.name AS trainer_name,
      COUNT(DISTINCT pc.client_id) AS commission_clients,
      COALESCE(SUM(pc.commission_amt), 0) AS total_commission,
      COALESCE(pp.net_amount, 0) AS paid_amount,
      COALESCE(pp.status, 'pending') AS payout_status,
      pp.id AS payout_id
    FROM trainers t
    LEFT JOIN pt_commissions pc ON pc.trainer_id = t.id AND pc.month = $1
    LEFT JOIN pt_payouts pp ON pp.trainer_id = t.id AND pp.month = $1
    WHERE t.deleted_at IS NULL AND t.status = 'active'
    GROUP BY t.id, t.name, pp.net_amount, pp.status, pp.id
    ORDER BY total_commission DESC
  `, [monthStart]);
  return rows;
}

// â”€â”€â”€ Balance sheet â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function getBalanceSheet(trainerId) {
  const where = [];
  const params = [];
  if (trainerId) {
    params.push(trainerId);
    where.push(`c.trainer_id = $${params.length}`);
  }
  const whereSql = where.length ? `AND ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(`
    SELECT c.id, c.client_id, c.name, c.mobile, c.trainer_name,
           c.package_type, c.final_amount, c.paid_amount, c.balance_amount,
           c.pt_end_date, (c.pt_end_date - CURRENT_DATE) AS days_left,
           c.status,
           CASE
             WHEN c.balance_amount > 0 AND c.pt_end_date < CURRENT_DATE THEN 'OVERDUE'
             WHEN c.balance_amount > 0 THEN 'DUE'
             ELSE 'CLEAR'
           END AS due_status,
           c.monthly_pt_amount, c.trainer_commission
    FROM clients c
    WHERE c.deleted_at IS NULL AND c.balance_amount > 0
      ${whereSql}
    ORDER BY c.balance_amount DESC
  `, params);
  return rows;
}

// â”€â”€â”€ Active clients (optionally filtered by trainer) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function getActiveClients(trainerId) {
  const where = ['c.deleted_at IS NULL', "c.status IN ('active','frozen')", 'c.pt_start_date IS NOT NULL'];
  const params = [];
  if (trainerId) {
    params.push(trainerId);
    where.push(`c.trainer_id = $${params.length}`);
  }
  const { rows } = await pool.query(`
    SELECT c.id, c.client_id, c.name, c.gender, c.mobile,
           c.trainer_id, c.trainer_name,
           c.package_type, c.base_amount, c.discount, c.final_amount,
           c.paid_amount, c.balance_amount, c.joining_date,
           c.duration_months, c.pt_start_date, c.pt_end_date,
           (c.pt_end_date - CURRENT_DATE) AS days_left,
           c.status, c.monthly_pt_amount, c.trainer_commission
    FROM clients c
    WHERE ${where.join(' AND ')}
    ORDER BY c.name
  `, params);
  return rows;
}

// â”€â”€â”€ PT Dashboard stats â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function getDashboardStats() {
  const { rows: [totals] } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'active' AND pt_start_date IS NOT NULL)::INT AS active_pt_clients,
      COUNT(*) FILTER (WHERE status = 'expired')::INT AS expired_clients,
      COUNT(*) FILTER (WHERE balance_amount > 0)::INT AS clients_with_balance,
      COALESCE(SUM(monthly_pt_amount) FILTER (WHERE status = 'active' AND pt_start_date IS NOT NULL), 0) AS total_monthly_pt_revenue,
      COALESCE(SUM(trainer_commission) FILTER (WHERE status = 'active' AND pt_start_date IS NOT NULL), 0) AS total_monthly_commission,
      COALESCE(SUM(balance_amount), 0) AS total_outstanding
    FROM clients
    WHERE deleted_at IS NULL
  `);

  // Trainer counts
  const { rows: trainerStats } = await pool.query(`
    SELECT
      t.id, t.name,
      COUNT(c.id) FILTER (WHERE c.status = 'active')::INT AS active_clients,
      COALESCE(SUM(c.monthly_pt_amount) FILTER (WHERE c.status = 'active'), 0) AS monthly_revenue,
      COALESCE(SUM(c.trainer_commission) FILTER (WHERE c.status = 'active'), 0) AS monthly_commission
    FROM trainers t
    LEFT JOIN clients c ON c.trainer_id = t.id AND c.deleted_at IS NULL AND c.pt_start_date IS NOT NULL
    WHERE t.deleted_at IS NULL AND t.status = 'active'
    GROUP BY t.id, t.name
    ORDER BY active_clients DESC
  `);

  // Monthly revenue trend (last 6 months)
  const { rows: revenueTrend } = await pool.query(`
    SELECT
      TO_CHAR(DATE_TRUNC('month', date), 'Mon YYYY') AS label,
      DATE_TRUNC('month', date)::DATE AS month,
      COALESCE(SUM(amount), 0) AS revenue,
      COALESCE(SUM(incentive_amt), 0) AS incentives
    FROM payments
    WHERE date >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '5 months')
      AND deleted_at IS NULL
    GROUP BY DATE_TRUNC('month', date)
    ORDER BY month ASC
  `);

  return { ...totals, trainers: trainerStats, revenueTrend };
}

// â”€â”€â”€ Commission history for a trainer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function getCommissionHistory(trainerId) {
  const where = [];
  const params = [];
  if (trainerId) {
    params.push(trainerId);
    where.push(`pc.trainer_id = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(`
    SELECT pc.*, c.name AS client_name
    FROM pt_commissions pc
    JOIN clients c ON c.id = pc.client_id
    ${whereSql}
    ORDER BY pc.month DESC, pc.client_name
    LIMIT 200
  `, params);
  return rows;
}

// â”€â”€â”€ Create payout for a trainer for a given month â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function createPayout(trainerId, month, deductions, processedBy) {
  const monthStart = `${month}-01`;
  const { rows: [commData] } = await pool.query(`
    SELECT
      t.name AS trainer_name,
      COALESCE(SUM(pc.commission_amt), 0) AS total_commission
    FROM trainers t
    LEFT JOIN pt_commissions pc ON pc.trainer_id = t.id AND pc.month = $1
    WHERE t.id = $2 AND t.deleted_at IS NULL
    GROUP BY t.name
  `, [monthStart, trainerId]);

  if (!commData) throw new Error('Trainer not found');

  const totalCommission = Number(commData.total_commission);
  const netAmount = Math.max(0, totalCommission - (deductions || 0));

  const { rows } = await pool.query(`
    INSERT INTO pt_payouts
      (trainer_id, trainer_name, month, total_commission, deductions, net_amount, status, processed_by)
    VALUES ($1,$2,$3,$4,$5,$6,'pending',$7)
    ON CONFLICT (trainer_id, month)
    DO UPDATE SET total_commission = EXCLUDED.total_commission,
                  deductions = EXCLUDED.deductions,
                  net_amount = EXCLUDED.net_amount,
                  processed_by = EXCLUDED.processed_by,
                  updated_at = NOW()
    RETURNING *
  `, [trainerId, commData.trainer_name, monthStart, totalCommission, deductions || 0, netAmount, processedBy]);

  return rows[0];
}

// â”€â”€â”€ Mark payout as paid â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function markPayoutPaid(payoutId, paymentMethod, paymentRef, processedBy) {
  const { rows } = await pool.query(`
    UPDATE pt_payouts
    SET status = 'paid',
        payment_method = COALESCE($2, payment_method),
        payment_ref = COALESCE($3, payment_ref),
        paid_at = NOW(),
        processed_by = COALESCE($4, processed_by),
        updated_at = NOW()
    WHERE id = $1
    RETURNING *
  `, [payoutId, paymentMethod, paymentRef, processedBy]);

  // Mark related commissions as paid
  if (rows.length > 0) {
    const payout = rows[0];
    await pool.query(`
      UPDATE pt_commissions
      SET status = 'paid', updated_at = NOW()
      WHERE trainer_id = $1 AND month = $2 AND status = 'approved'
    `, [payout.trainer_id, payout.month]);
  }
  return rows[0];
}

module.exports = {
  calculateMonthlyCommissions,
  getTrainerPayouts,
  getBalanceSheet,
  getActiveClients,
  getDashboardStats,
  getCommissionHistory,
  createPayout,
  markPayoutPaid,
};

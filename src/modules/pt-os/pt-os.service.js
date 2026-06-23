const pool = require('../../db/pool');

async function calculateMonthlyCommissions(month) {
  const monthStart = `${month}-01`;
  const mStart = new Date(monthStart + 'T00:00:00Z');
  const mEnd = new Date(mStart.getFullYear(), mStart.getMonth() + 1, 1);
  const mEndStr = mEnd.toISOString().slice(0, 10);

  const { rows: clients } = await pool.query(`
    SELECT c.id, c.name, c.trainer_id, c.trainer_name,
           c.monthly_pt_amount, c.trainer_commission,
           t.incentive_rate
    FROM pt_clients c
    JOIN pt_trainers t ON t.id = c.trainer_id
    WHERE c.deleted_at IS NULL
      AND c.status IN ('active','frozen')
      AND c.trainer_id IS NOT NULL
      AND c.pt_start_date IS NOT NULL
      AND (c.pt_end_date IS NULL OR NULLIF(c.pt_end_date, '')::DATE >= $1::DATE)
      AND c.pt_start_date <= $2
      AND c.monthly_pt_amount > 0
  `, [mStart.toISOString().slice(0, 10), mEndStr]);

  const results = [];
  for (const cl of clients) {
    const commission = Number(cl.trainer_commission);
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
}

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
    FROM pt_trainers t
    LEFT JOIN pt_commissions pc ON pc.trainer_id = t.id AND pc.month = $1
    LEFT JOIN pt_payouts pp ON pp.trainer_id = t.id AND pp.month = $1
    WHERE t.deleted_at IS NULL AND t.status = 'active'
    GROUP BY t.id, t.name, pp.net_amount, pp.status, pp.id
    ORDER BY total_commission DESC
  `, [monthStart]);
  return rows;
}

async function getBalanceSheet(trainerId) {
  const where = [];
  const params = [];
  if (trainerId) {
    params.push(trainerId);
    where.push(`c.trainer_id = $${params.length}`);
  }
  const whereSql = where.length ? `AND ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(`
    SELECT c.id, c.client_id, c.unique_id, c.name, c.mobile, c.email, c.photo_url,
           c.weight, c.emergency_contact,
           c.trainer_name,
           c.package_type, c.final_amount, c.paid_amount, c.balance_amount,
           c.pt_end_date, (c.pt_end_date - CURRENT_DATE) AS days_left,
           c.status,
           CASE
             WHEN c.balance_amount > 0 AND c.pt_end_date < CURRENT_DATE THEN 'OVERDUE'
             WHEN c.balance_amount > 0 THEN 'DUE'
             ELSE 'CLEAR'
           END AS due_status,
           c.monthly_pt_amount, c.trainer_commission,
           COALESCE(pp.total_incentives, 0) AS total_earned_commission
    FROM pt_clients c
    LEFT JOIN (
      SELECT client_id, SUM(incentive_amt) AS total_incentives
      FROM pt_payments
      WHERE deleted_at IS NULL
      GROUP BY client_id
    ) pp ON pp.client_id = c.id
    WHERE c.deleted_at IS NULL
      ${whereSql}
    ORDER BY c.balance_amount DESC NULLS LAST
  `, params);
  return rows;
}

async function getActiveClients(trainerId) {
  // Returns ALL non-deleted PT clients so the "All Clients" page can show
  // every status. The frontend applies its own status filter on top.
  const where = ['c.deleted_at IS NULL'];
  const params = [];
  if (trainerId) {
    params.push(trainerId);
    where.push(`c.trainer_id = $${params.length}`);
  }
  const { rows } = await pool.query(`
    SELECT c.id, c.client_id, c.name, c.gender, c.mobile, c.email,
           c.photo_url, c.dob, c.weight, c.notes, c.address, c.emergency_contact,
           c.trainer_id, c.trainer_name,
           c.package_type, c.base_amount, c.discount, c.final_amount,
           c.paid_amount, c.balance_amount, c.joining_date,
           c.duration_months, c.pt_start_date, c.pt_end_date,
           CASE
             WHEN c.pt_end_date IS NOT NULL AND c.pt_end_date::TEXT != ''
             THEN c.pt_end_date::DATE - CURRENT_DATE
             ELSE NULL
           END AS days_left,
           c.status, c.monthly_pt_amount, c.trainer_commission,
           COALESCE(pp.total_incentives, 0) AS total_earned_commission
    FROM pt_clients c
    LEFT JOIN (
      SELECT client_id, SUM(incentive_amt) AS total_incentives
      FROM pt_payments
      WHERE deleted_at IS NULL
      GROUP BY client_id
    ) pp ON pp.client_id = c.id
    WHERE ${where.join(' AND ')}
    ORDER BY c.name
  `, params);
  return rows;
}

async function getDashboardStats() {
  const { rows: [totals] } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'active' AND pt_start_date IS NOT NULL)::INT AS active_pt_clients,
      COUNT(*) FILTER (WHERE status = 'expired')::INT AS expired_clients,
      COUNT(*) FILTER (WHERE balance_amount > 0)::INT AS clients_with_balance,
      COALESCE(SUM(trainer_commission) FILTER (WHERE status = 'active' AND pt_start_date IS NOT NULL), 0) AS total_monthly_commission,
      COALESCE(SUM(balance_amount), 0) AS total_outstanding
    FROM pt_clients
    WHERE deleted_at IS NULL
  `);

  // ISSUE-005: use actual collected payments (pt_payments) for current-month
  // revenue, not the contracted monthly_pt_amount from pt_clients.
  const { rows: [revenueRow] } = await pool.query(`
    SELECT COALESCE(SUM(amount), 0) AS total_monthly_pt_revenue
    FROM pt_payments
    WHERE date >= date_trunc('month', CURRENT_DATE)
      AND date < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
      AND deleted_at IS NULL
  `);
  totals.total_monthly_pt_revenue = revenueRow.total_monthly_pt_revenue;

  const { rows: trainerStats } = await pool.query(`
    SELECT
      t.id, t.name,
      COUNT(c.id) FILTER (WHERE c.status = 'active')::INT AS active_clients,
      COALESCE(SUM(c.monthly_pt_amount) FILTER (WHERE c.status = 'active'), 0) AS monthly_revenue,
      COALESCE(SUM(c.trainer_commission) FILTER (WHERE c.status = 'active'), 0) AS monthly_commission
    FROM pt_trainers t
    LEFT JOIN pt_clients c ON c.trainer_id = t.id AND c.deleted_at IS NULL AND c.pt_start_date IS NOT NULL
    WHERE t.deleted_at IS NULL AND t.status = 'active'
    GROUP BY t.id, t.name
    ORDER BY active_clients DESC
  `);

  const { rows: revenueTrend } = await pool.query(`
    SELECT
      TO_CHAR(DATE_TRUNC('month', date), 'Mon YYYY') AS label,
      DATE_TRUNC('month', date)::DATE AS month,
      COALESCE(SUM(amount), 0) AS revenue,
      COALESCE(SUM(incentive_amt), 0) AS incentives
    FROM pt_payments
    WHERE date >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '5 months')
      AND deleted_at IS NULL
    GROUP BY DATE_TRUNC('month', date)
    ORDER BY month ASC
  `);

  return { ...totals, trainers: trainerStats, revenueTrend };
}

async function getCommissionHistory(trainerId) {
  const where = ['c.deleted_at IS NULL'];
  const params = [];
  if (trainerId) {
    params.push(trainerId);
    where.push(`pc.trainer_id = $${params.length}`);
  }
  const { rows } = await pool.query(`
    SELECT pc.*, c.name AS client_name
    FROM pt_commissions pc
    JOIN pt_clients c ON c.id = pc.client_id
    WHERE ${where.join(' AND ')}
    ORDER BY pc.month DESC, pc.client_name
    LIMIT 200
  `, params);
  return rows;
}

async function createPayout(trainerId, month, deductions, processedBy) {
  const monthStart = `${month}-01`;
  const { rows: [commData] } = await pool.query(`
    SELECT
      t.name AS trainer_name,
      COALESCE(SUM(pc.commission_amt), 0) AS total_commission
    FROM pt_trainers t
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

  if (rows.length > 0) {
    const payout = rows[0];
    await pool.query(`
      UPDATE pt_commissions
      SET status = 'paid', updated_at = NOW()
      WHERE trainer_id = $1 AND month = $2 AND status IN ('pending', 'approved')
    `, [payout.trainer_id, payout.month]);
  }
  return rows[0];
}

/**
 * getOpsSummary — powers the "Today's Operations" and "Session Activity"
 * dashboard sections.  Returns:
 *   today_sessions   — all pt_sessions scheduled/completed today
 *   renewals_due     — active clients whose pt_end_date is within 7 days
 *   top_dues         — up to 5 clients with the highest outstanding balance
 *   session_stats    — this-month vs last-month completed session counts
 *   trainer_sessions — per-trainer session totals this month
 */
async function getOpsSummary() {
  const today = new Date().toISOString().slice(0, 10);

  const { rows: today_sessions } = await pool.query(`
    SELECT
      s.id, s.title, s.session_date::TEXT, s.start_time::TEXT, s.end_time::TEXT,
      s.status, s.notes,
      c.name  AS client_name,  c.photo_url AS client_photo,
      t.name  AS trainer_name
    FROM pt_sessions s
    LEFT JOIN pt_clients c  ON c.id = s.client_id
    LEFT JOIN pt_trainers t ON t.id = s.trainer_id
    WHERE s.session_date = $1 AND s.deleted_at IS NULL
    ORDER BY COALESCE(s.start_time, '00:00'::TIME)
  `, [today]);

  const { rows: renewals_due } = await pool.query(`
    SELECT
      id, name, mobile, trainer_name, package_type,
      pt_end_date::TEXT,
      (pt_end_date::DATE - CURRENT_DATE)::INT AS days_left,
      balance_amount,
      monthly_pt_amount
    FROM pt_clients
    WHERE deleted_at IS NULL
      AND status = 'active'
      AND pt_end_date IS NOT NULL
      AND pt_end_date::DATE BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
    ORDER BY pt_end_date ASC
    LIMIT 15
  `);

  const { rows: top_dues } = await pool.query(`
    SELECT
      id, name, mobile, trainer_name, balance_amount,
      pt_end_date::TEXT,
      CASE WHEN pt_end_date IS NOT NULL AND pt_end_date::DATE < CURRENT_DATE THEN 'overdue' ELSE 'due' END AS due_status
    FROM pt_clients
    WHERE deleted_at IS NULL AND balance_amount > 0
    ORDER BY balance_amount DESC
    LIMIT 5
  `);

  const { rows: [session_stats] } = await pool.query(`
    SELECT
      COUNT(*) FILTER (
        WHERE session_date >= DATE_TRUNC('month', CURRENT_DATE)
          AND session_date <  DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'
      )::INT AS this_month_total,
      COUNT(*) FILTER (
        WHERE session_date >= DATE_TRUNC('month', CURRENT_DATE)
          AND session_date <  DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'
          AND status = 'completed'
      )::INT AS this_month_completed,
      COUNT(*) FILTER (
        WHERE session_date >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'
          AND session_date <  DATE_TRUNC('month', CURRENT_DATE)
          AND status = 'completed'
      )::INT AS last_month_completed
    FROM pt_sessions
    WHERE deleted_at IS NULL
  `);

  const { rows: trainer_sessions } = await pool.query(`
    SELECT
      t.name AS trainer_name,
      COUNT(s.id) FILTER (WHERE s.status = 'completed')::INT AS completed,
      COUNT(s.id) FILTER (WHERE s.status = 'scheduled')::INT AS scheduled,
      COUNT(s.id) FILTER (WHERE s.status IN ('cancelled','no_show'))::INT AS missed
    FROM pt_trainers t
    LEFT JOIN pt_sessions s
      ON s.trainer_id = t.id
      AND s.session_date >= DATE_TRUNC('month', CURRENT_DATE)
      AND s.session_date <  DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'
      AND s.deleted_at IS NULL
    WHERE t.deleted_at IS NULL AND t.status = 'active'
    GROUP BY t.id, t.name
    ORDER BY completed DESC
  `);

  return { today_sessions, renewals_due, top_dues, session_stats, trainer_sessions };
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
  getOpsSummary,
};

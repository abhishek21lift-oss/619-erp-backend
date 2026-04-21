// src/routes/dashboard.js
const router = require('express').Router();
const pool   = require('../db/pool');
const { auth } = require('../middleware/auth');

router.get('/summary', auth, async (req, res) => {
  const isTrainer = req.user.role === 'trainer';
  const tid = isTrainer ? req.user.trainer_id : null;

  try {
    // Use parameterized queries — never string interpolation with user data
    const clientWhere   = tid ? 'WHERE trainer_id = $1' : '';
    const payWhere      = tid ? 'WHERE trainer_id = $1' : '';
    const params        = tid ? [tid] : [];

    const [clientStats, revStats, expiring, dues, recentPay, monthly, topTrainers, attendance] =
      await Promise.all([

        pool.query(`
          SELECT
            COUNT(*) FILTER (WHERE status='active')  AS active,
            COUNT(*) FILTER (WHERE status='expired') AS expired,
            COUNT(*)                                  AS total
          FROM clients ${clientWhere}`, params),

        pool.query(`
          SELECT
            COALESCE(SUM(amount) FILTER (WHERE date >= DATE_TRUNC('month',NOW())),0) AS month,
            COALESCE(SUM(amount) FILTER (WHERE date >= DATE_TRUNC('year',NOW())),0)  AS year,
            COALESCE(SUM(amount),0) AS total
          FROM payments ${payWhere}`, params),

        pool.query(`
          SELECT COUNT(*) AS count FROM clients
          WHERE status='active'
            AND pt_end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
            ${tid ? 'AND trainer_id=$1' : ''}`, params),

        pool.query(`
          SELECT COALESCE(SUM(balance_amount),0) AS total_dues
          FROM clients WHERE balance_amount > 0 ${tid ? 'AND trainer_id=$1' : ''}`, params),

        pool.query(`
          SELECT p.id, p.amount, p.method, p.date, p.receipt_no,
                 c.name AS client_name, t.name AS trainer_name
          FROM payments p
          LEFT JOIN clients c ON c.id = p.client_id
          LEFT JOIN trainers t ON t.id = p.trainer_id
          ${tid ? 'WHERE p.trainer_id=$1' : ''}
          ORDER BY p.created_at DESC LIMIT 8`, params),

        pool.query(`
          SELECT
            TO_CHAR(DATE_TRUNC('month', date::date), 'Mon YY') AS month,
            COALESCE(SUM(amount),0) AS revenue,
            COUNT(*) AS count
          FROM payments
          WHERE date >= NOW() - INTERVAL '6 months'
            ${tid ? 'AND trainer_id=$1' : ''}
          GROUP BY DATE_TRUNC('month', date::date)
          ORDER BY DATE_TRUNC('month', date::date)`, params),

        // Top trainers by this-month revenue (admin only)
        !tid ? pool.query(`
          SELECT t.id, t.name, t.specialization,
            COUNT(c.id) FILTER (WHERE c.status='active') AS active_clients,
            COALESCE(SUM(p.amount) FILTER (WHERE p.date >= DATE_TRUNC('month',NOW())),0) AS month_revenue
          FROM trainers t
          LEFT JOIN clients c ON c.trainer_id = t.id
          LEFT JOIN payments p ON p.trainer_id = t.id
          WHERE t.status = 'active'
          GROUP BY t.id, t.name, t.specialization
          ORDER BY month_revenue DESC LIMIT 5`) : Promise.resolve({ rows: [] }),

        // Attendance today
        pool.query(`
          SELECT COUNT(*) AS present FROM attendance
          WHERE date = CURRENT_DATE AND status='present' AND type='client'
            ${tid ? 'AND trainer_id=$1' : ''}`, params),
      ]);

    res.json({
      clients:       clientStats.rows[0],
      revenue:       revStats.rows[0],
      expiring_soon: parseInt(expiring.rows[0].count),
      total_dues:    parseFloat(dues.rows[0].total_dues),
      recent_payments: recentPay.rows,
      monthly_chart:   monthly.rows,
      top_trainers:    topTrainers.rows,
      attendance_today: parseInt(attendance.rows[0].present),
    });
  } catch (err) {
    console.error('Dashboard error:', err.message);
    res.status(500).json({ error: 'Dashboard query failed: ' + err.message });
  }
});

module.exports = router;

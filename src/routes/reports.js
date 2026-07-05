// src/routes/reports.js
const router = require('express').Router();
const pool = require('../db/pool');
const { auth, adminOnly } = require('../middleware/auth');

// GET /api/reports/monthly
// ISSUE-029: UNIONs gym payments with PT payments so the monthly
// revenue figures include both revenue streams.
router.get('/monthly', auth, async (req, res, next) => {
  try {
    const { year = new Date().getFullYear() } = req.query;
    const isTrainer = req.user.role === 'trainer';
    const tid = isTrainer ? req.user.trainer_id : null;
    const params = tid ? [parseInt(year), tid] : [parseInt(year)];
    const trainerWhere = tid ? 'AND p.trainer_id=$2' : '';

    const { rows } = await pool.query(`
      SELECT
        month_num,
        month_name,
        COUNT(*) AS payment_count,
        COALESCE(SUM(revenue), 0) AS revenue,
        COALESCE(SUM(incentives), 0) AS incentives
      FROM (
        SELECT
          EXTRACT(MONTH FROM p.date::date) AS month_num,
          TO_CHAR(DATE_TRUNC('month', p.date::date), 'Month') AS month_name,
          p.amount AS revenue,
          p.incentive_amt AS incentives
        FROM payments p
        WHERE EXTRACT(YEAR FROM p.date::date) = $1
          AND p.deleted_at IS NULL
          ${trainerWhere}
        UNION ALL
        SELECT
          EXTRACT(MONTH FROM p.date::date) AS month_num,
          TO_CHAR(DATE_TRUNC('month', p.date::date), 'Month') AS month_name,
          p.amount AS revenue,
          p.incentive_amt AS incentives
        FROM pt_payments p
        WHERE EXTRACT(YEAR FROM p.date::date) = $1
          AND p.deleted_at IS NULL
          ${trainerWhere}
      ) combined
      GROUP BY month_num, month_name
      ORDER BY month_num`, params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/trainer-summary (admin only)
// ISSUE-021: after migration 017/018, PT clients live in pt_clients and PT
// payments live in pt_payments. Both tables are joined so the summary
// includes gym clients + PT clients and gym payments + PT payments.
router.get('/trainer-summary', auth, adminOnly, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT t.id, t.name, t.specialization,
        COUNT(DISTINCT c.id)   FILTER (WHERE c.status='active'   AND c.deleted_at IS NULL)   +
        COUNT(DISTINCT ptc.id) FILTER (WHERE ptc.status='active' AND ptc.deleted_at IS NULL) AS active_clients,
        COUNT(DISTINCT c.id)   FILTER (WHERE c.deleted_at IS NULL)   +
        COUNT(DISTINCT ptc.id) FILTER (WHERE ptc.deleted_at IS NULL) AS total_clients,
        COALESCE(SUM(p.amount)   FILTER (WHERE p.date   >= DATE_TRUNC('month',NOW()) AND p.deleted_at IS NULL),   0) +
        COALESCE(SUM(ptp.amount) FILTER (WHERE ptp.date >= DATE_TRUNC('month',NOW()) AND ptp.deleted_at IS NULL), 0) AS month_revenue,
        COALESCE(SUM(p.amount)   FILTER (WHERE p.deleted_at IS NULL),   0) +
        COALESCE(SUM(ptp.amount) FILTER (WHERE ptp.deleted_at IS NULL), 0) AS total_revenue
      FROM trainers t
      LEFT JOIN clients     c   ON c.trainer_id   = t.id
      LEFT JOIN pt_clients  ptc ON ptc.trainer_id = t.id
      LEFT JOIN payments    p   ON p.trainer_id   = t.id
      LEFT JOIN pt_payments ptp ON ptp.trainer_id = t.id
      WHERE t.status = 'active'
      GROUP BY t.id, t.name, t.specialization
      ORDER BY total_revenue DESC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/trainers — alias for /trainer-summary (used by frontend Reports page)
// ISSUE-021: mirrors the fix above — includes pt_clients + pt_payments.
router.get('/trainers', auth, adminOnly, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT t.id, t.name, t.specialization,
        COUNT(DISTINCT c.id)   FILTER (WHERE c.status='active'   AND c.deleted_at IS NULL)   +
        COUNT(DISTINCT ptc.id) FILTER (WHERE ptc.status='active' AND ptc.deleted_at IS NULL) AS active_clients,
        COUNT(DISTINCT c.id)   FILTER (WHERE c.deleted_at IS NULL)   +
        COUNT(DISTINCT ptc.id) FILTER (WHERE ptc.deleted_at IS NULL) AS total_clients,
        COALESCE(SUM(p.amount)   FILTER (WHERE p.date   >= DATE_TRUNC('month',NOW()) AND p.deleted_at IS NULL),   0) +
        COALESCE(SUM(ptp.amount) FILTER (WHERE ptp.date >= DATE_TRUNC('month',NOW()) AND ptp.deleted_at IS NULL), 0) AS month_revenue,
        COALESCE(SUM(p.amount)   FILTER (WHERE p.deleted_at IS NULL),   0) +
        COALESCE(SUM(ptp.amount) FILTER (WHERE ptp.deleted_at IS NULL), 0) AS total_revenue
      FROM trainers t
      LEFT JOIN clients     c   ON c.trainer_id   = t.id
      LEFT JOIN pt_clients  ptc ON ptc.trainer_id = t.id
      LEFT JOIN payments    p   ON p.trainer_id   = t.id
      LEFT JOIN pt_payments ptp ON ptp.trainer_id = t.id
      WHERE t.status = 'active'
      GROUP BY t.id, t.name, t.specialization
      ORDER BY total_revenue DESC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/revenue — total collected revenue for a date range
// Unions gym payments + PT payments so the figure includes both streams.
// Called by api.reports.revenue() in the frontend.
router.get('/revenue', auth, async (req, res, next) => {
  try {
    const { from, to, year } = req.query;
    const conditions = ['p.deleted_at IS NULL'];
    const params = [];
    let p = 1;

    if (from) { conditions.push(`p.date >= $${p++}`); params.push(from); }
    if (to)   { conditions.push(`p.date <= $${p++}`); params.push(to); }
    if (year && !from && !to) {
      conditions.push(`EXTRACT(YEAR FROM p.date::date) = $${p++}`);
      params.push(parseInt(year));
    }

    const where = 'WHERE ' + conditions.join(' AND ');

    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::int                AS count,
        COALESCE(SUM(p.amount), 0)   AS total,
        COALESCE(SUM(p.incentive_amt), 0) AS total_incentives
      FROM (
        SELECT amount, incentive_amt, date, deleted_at FROM payments
        UNION ALL
        SELECT amount, incentive_amt, date, deleted_at FROM pt_payments
      ) p
      ${where}
    `, params);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/dues
router.get('/dues', auth, async (req, res, next) => {
  try {
    const tid = req.user.role === 'trainer' ? req.user.trainer_id : null;
    const params = [];
    let trainerFilter = '';
    if (tid) {
      params.push(tid);
      trainerFilter = ` AND trainer_id = $${params.length}`;
    }
    const { rows } = await pool.query(`
      SELECT id, client_id, name, mobile, trainer_name,
             balance_amount, pt_end_date, status
      FROM (
        SELECT c.id, c.client_id, c.name, c.mobile, c.trainer_name,
               c.balance_amount, c.pt_end_date, c.status, c.trainer_id
        FROM clients c
        WHERE c.balance_amount > 0 AND c.deleted_at IS NULL
        UNION ALL
        SELECT ptc.id, NULL AS client_id, ptc.name, ptc.mobile, ptc.trainer_name,
               ptc.balance_amount, ptc.pt_end_date, ptc.status, ptc.trainer_id
        FROM pt_clients ptc
        WHERE ptc.balance_amount > 0 AND ptc.deleted_at IS NULL
      ) combined
      WHERE 1=1${trainerFilter}
      ORDER BY balance_amount DESC LIMIT 100`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

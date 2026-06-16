// src/routes/reports.js
const router = require('express').Router();
const pool = require('../db/pool');
const { auth, adminOnly } = require('../middleware/auth');

// GET /api/reports/monthly
router.get('/monthly', auth, async (req, res, next) => {
  try {
    const { year = new Date().getFullYear() } = req.query;
    const isTrainer = req.user.role === 'trainer';
    const tid = isTrainer ? req.user.trainer_id : null;
    const params = tid ? [parseInt(year), tid] : [parseInt(year)];
    const trainerWhere = tid ? 'AND p.trainer_id=$2' : '';

    const { rows } = await pool.query(`
      SELECT
        EXTRACT(MONTH FROM p.date::date) AS month_num,
        TO_CHAR(DATE_TRUNC('month', p.date::date), 'Month') AS month_name,
        COUNT(*) AS payment_count,
        COALESCE(SUM(p.amount),0) AS revenue,
        COALESCE(SUM(p.incentive_amt),0) AS incentives
      FROM payments p
      WHERE EXTRACT(YEAR FROM p.date::date) = $1
        AND p.deleted_at IS NULL
        ${trainerWhere}
      GROUP BY month_num, month_name
      ORDER BY month_num`, params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/trainer-summary (admin only)
router.get('/trainer-summary', auth, adminOnly, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT t.id, t.name, t.specialization,
        COUNT(DISTINCT c.id) FILTER (WHERE c.status='active' AND c.deleted_at IS NULL) AS active_clients,
        COUNT(DISTINCT c.id) FILTER (WHERE c.deleted_at IS NULL) AS total_clients,
        COALESCE(SUM(p.amount) FILTER (WHERE p.date >= DATE_TRUNC('month',NOW()) AND p.deleted_at IS NULL),0) AS month_revenue,
        COALESCE(SUM(p.amount) FILTER (WHERE p.deleted_at IS NULL),0) AS total_revenue
      FROM trainers t
      LEFT JOIN clients  c ON c.trainer_id = t.id
      LEFT JOIN payments p ON p.trainer_id = t.id
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
router.get('/trainers', auth, adminOnly, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT t.id, t.name, t.specialization,
        COUNT(DISTINCT c.id) FILTER (WHERE c.status='active' AND c.deleted_at IS NULL) AS active_clients,
        COUNT(DISTINCT c.id) FILTER (WHERE c.deleted_at IS NULL) AS total_clients,
        COALESCE(SUM(p.amount) FILTER (WHERE p.date >= DATE_TRUNC('month',NOW()) AND p.deleted_at IS NULL),0) AS month_revenue,
        COALESCE(SUM(p.amount) FILTER (WHERE p.deleted_at IS NULL),0) AS total_revenue
      FROM trainers t
      LEFT JOIN clients  c ON c.trainer_id = t.id
      LEFT JOIN payments p ON p.trainer_id = t.id
      WHERE t.status = 'active'
      GROUP BY t.id, t.name, t.specialization
      ORDER BY total_revenue DESC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/dues
router.get('/dues', auth, async (req, res, next) => {
  try {
    const tid = req.user.role === 'trainer' ? req.user.trainer_id : null;
    const params = [];
    let where = 'c.balance_amount > 0 AND c.deleted_at IS NULL';
    if (tid) {
      params.push(tid);
      where += ` AND c.trainer_id = $${params.length}`;
    }
    const { rows } = await pool.query(`
      SELECT c.id, c.client_id, c.name, c.mobile, c.trainer_name,
             c.balance_amount, c.pt_end_date, c.status
      FROM clients c
      WHERE ${where}
      ORDER BY c.balance_amount DESC LIMIT 100`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

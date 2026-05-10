// src/modules/reports/reports.routes.js
// Filterable reports + CSV/PDF export.
//
// Note: PDF export here uses a simple HTML-to-buffer pattern; in production
// install `puppeteer` or `pdfkit`. Code stub shown.

const router = require('express').Router();
const pool = require('../../db/pool');
const { auth } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── Revenue report ─────────────────────────────────────────────────────────
// GET /api/v1/reports/revenue?from=&to=&group_by=month|trainer|plan
router.get('/revenue', auth, requireRole('admin','manager'), wrap(async (req, res) => {
  const { from, to, group_by = 'month' } = req.query;
  const params = [];
  const where = [];
  if (from) { params.push(from); where.push(`p.date >= $${params.length}`); }
  if (to)   { params.push(to);   where.push(`p.date <= $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  let sql;
  if (group_by === 'trainer') {
    sql = `
      SELECT t.id AS trainer_id, t.name AS label,
             COALESCE(SUM(p.amount), 0) AS revenue,
             COUNT(p.id) AS count
      FROM payments p LEFT JOIN trainers t ON t.id = p.trainer_id
      ${whereSql}
      GROUP BY t.id, t.name ORDER BY revenue DESC`;
  } else if (group_by === 'plan') {
    sql = `
      SELECT pl.id AS plan_id, pl.name AS label,
             COALESCE(SUM(p.amount), 0) AS revenue, COUNT(p.id) AS count
      FROM payments p
      LEFT JOIN member_memberships mm ON mm.id = p.membership_id
      LEFT JOIN plans pl ON pl.id = mm.plan_id
      ${whereSql}
      GROUP BY pl.id, pl.name ORDER BY revenue DESC`;
  } else {
    sql = `
      SELECT TO_CHAR(DATE_TRUNC('month', p.date), 'YYYY-MM') AS label,
             COALESCE(SUM(p.amount), 0) AS revenue, COUNT(p.id) AS count
      FROM payments p ${whereSql}
      GROUP BY DATE_TRUNC('month', p.date) ORDER BY DATE_TRUNC('month', p.date)`;
  }

  const { rows } = await pool.query(sql, params);
  res.json({ data: rows });
}));

// ── Trainer payouts ────────────────────────────────────────────────────────
// GET /api/v1/reports/trainer-payouts?month=2025-04
router.get('/trainer-payouts', auth, requireRole('admin','manager'), wrap(async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const { rows } = await pool.query(
    `SELECT * FROM v_trainer_monthly_earnings WHERE month = $1 ORDER BY total_payout DESC`,
    [month]
  );
  res.json({ data: rows });
}));

// ── Dues report ────────────────────────────────────────────────────────────
router.get('/dues', auth, requireRole('admin','manager'), wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT m.id, m.member_code, m.name, m.phone,
            mm.balance_amount, mm.end_date, pl.name AS plan_name,
            t.name AS trainer_name
     FROM members m
     JOIN member_memberships mm ON mm.member_id = m.id AND mm.status = 'active'
     JOIN plans pl ON pl.id = mm.plan_id
     LEFT JOIN trainers t ON t.id = m.primary_trainer_id
     WHERE mm.balance_amount > 0
     ORDER BY mm.balance_amount DESC`
  );
  const total = rows.reduce((s, r) => s + Number(r.balance_amount), 0);
  res.json({ data: rows, meta: { total_dues: total } });
}));

// ── Retention report (cohort-based) ────────────────────────────────────────
router.get('/retention', auth, requireRole('admin','manager'), wrap(async (req, res) => {
  // Simple: % of members active 30/60/90 days after joining
  const { rows } = await pool.query(`
    WITH cohorts AS (
      SELECT DATE_TRUNC('month', joining_date) AS cohort, id, joining_date, status
      FROM members WHERE deleted_at IS NULL
    )
    SELECT TO_CHAR(cohort, 'YYYY-MM') AS cohort,
           COUNT(*) AS new_members,
           ROUND(100.0 * COUNT(*) FILTER (WHERE status='active') / COUNT(*), 1) AS active_pct
    FROM cohorts
    GROUP BY cohort ORDER BY cohort DESC LIMIT 12
  `);
  res.json({ data: rows });
}));

// ── CSV export ─────────────────────────────────────────────────────────────
// GET /api/v1/reports/export?type=members|payments|trainers&format=csv
router.get('/export', auth, requireRole('admin','manager'), wrap(async (req, res) => {
  const { type = 'members', format = 'csv' } = req.query;
  let rows = [];
  if (type === 'members') {
    rows = (await pool.query(`
      SELECT m.member_code, m.name, m.phone, m.email, m.status, m.joining_date,
             t.name AS trainer, pl.name AS plan, mm.end_date, mm.balance_amount
      FROM members m
      LEFT JOIN trainers t ON t.id = m.primary_trainer_id
      LEFT JOIN v_member_active_membership v ON v.member_id = m.id
      LEFT JOIN member_memberships mm ON mm.id = v.membership_id
      LEFT JOIN plans pl ON pl.id = mm.plan_id
      WHERE m.deleted_at IS NULL
      ORDER BY m.created_at DESC`)).rows;
  } else if (type === 'payments') {
    rows = (await pool.query(`
      SELECT p.receipt_no, p.date, p.amount, p.method, p.client_name, p.trainer_name, p.notes
      FROM payments p ORDER BY p.date DESC LIMIT 5000`)).rows;
  } else if (type === 'trainer-payouts') {
    rows = (await pool.query(`SELECT * FROM v_trainer_monthly_earnings ORDER BY month DESC, total_payout DESC`)).rows;
  }

  if (format === 'csv') {
    if (rows.length === 0) return res.type('text/csv').send('');
    const headers = Object.keys(rows[0]);
    const escape = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v).replace(/"/g, '""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    };
    const csv = [
      headers.join(','),
      ...rows.map(r => headers.map(h => escape(r[h])).join(','))
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${type}-${Date.now()}.csv"`);
    return res.send(csv);
  }

  // PDF: TODO — install puppeteer/pdfkit. For now, return JSON.
  res.json({ data: rows, note: 'PDF export TODO; CSV implemented' });
}));

module.exports = router;

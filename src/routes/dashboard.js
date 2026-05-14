// src/routes/dashboard.js
//
// Dashboard summary endpoint.
//
// What changed vs. v3.0:
//   - Honors ?period=today|7d|30d|90d so the UI period tabs aren't decorative.
//   - All 13 sub-queries run in parallel via Promise.all (kept). The pool
//     size is the safety net for connection pressure under load — bumping
//     pool max in db/pool.js is the right knob if this becomes an issue.
//   - Errors no longer leak err.message to the client; they go through the
//     global error handler so production hides 5xx detail.
//   - Defensive parseInt / parseFloat — never NaN to the client.

const router = require('express').Router();
const pool   = require('../db/pool');
const { auth } = require('../middleware/auth');

const PERIOD_TO_INTERVAL = {
  today: '1 day',
  '7d':  '7 days',
  '30d': '30 days',
  '90d': '90 days',
};

router.get('/summary', auth, async (req, res, next) => {
  const periodKey = String(req.query.period || '30d');
  const intervalText = PERIOD_TO_INTERVAL[periodKey] || PERIOD_TO_INTERVAL['30d'];

  const isTrainer = req.user.role === 'trainer';
  const tid       = isTrainer ? req.user.trainer_id : null;
  const params    = tid ? [tid] : [];
  const tFilter   = tid ? 'AND trainer_id = $1' : '';
  const pFilter   = tid ? 'AND p.trainer_id = $1' : '';
  const tWhere    = tid ? 'WHERE trainer_id = $1' : '';

  try {
    const [
      clientStats,
      revStats,
      todaySale,
      periodRevenue,
      expiring,
      dues,
      recentPay,
      monthly,
      topTrainers,
      attendance,
      birthdays,
      anniversaries,
      pendingRenewals,
      activePT,
    ] = await Promise.all([

      /* ── 1. Client counts incl. new-this-month ──────────────────── */
      pool.query(`
        SELECT
          COUNT(*)                                                AS total,
          COUNT(*) FILTER (WHERE status = 'active')              AS active,
          COUNT(*) FILTER (WHERE status = 'expired')             AS expired,
          COUNT(*) FILTER (WHERE status = 'frozen')              AS frozen,
          COUNT(*) FILTER (WHERE created_at >= DATE_TRUNC('month', NOW())) AS new_this_month
        FROM clients
        ${tWhere}`, params),

      /* ── 2. Revenue totals (month / year / all-time) ────────────── */
      pool.query(`
        SELECT
          COALESCE(SUM(amount) FILTER (WHERE date >= DATE_TRUNC('month', NOW())), 0) AS month,
          COALESCE(SUM(amount) FILTER (WHERE date >= DATE_TRUNC('year',  NOW())), 0) AS year,
          COALESCE(SUM(amount), 0)                                                   AS total
        FROM payments
        ${tWhere}`, params),

      /* ── 3. Today's sale ────────────────────────────────────────── */
      pool.query(`
        SELECT COALESCE(SUM(amount), 0) AS today
        FROM payments
        WHERE date = CURRENT_DATE
          ${tFilter}`, params),

      /* ── 4. Revenue for selected period ─────────────────────────── */
      pool.query(`
        SELECT COALESCE(SUM(amount), 0) AS revenue
        FROM payments
        WHERE date >= CURRENT_DATE - INTERVAL '${intervalText}'
          ${tFilter}`, params),

      /* ── 5. Expiring subscriptions (next 7 days) ────────────────── */
      pool.query(`
        SELECT COUNT(*) AS count
        FROM clients
        WHERE status = 'active'
          AND pt_end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
          ${tFilter}`, params),

      /* ── 6. Outstanding dues ────────────────────────────────────── */
      pool.query(`
        SELECT COALESCE(SUM(balance_amount), 0) AS total_dues
        FROM clients
        WHERE balance_amount > 0
          ${tFilter}`, params),

      /* ── 7. Recent payments ─────────────────────────────────────── */
      pool.query(`
        SELECT p.id, p.amount, p.method, p.date, p.receipt_no,
               c.name AS client_name, t.name AS trainer_name
        FROM   payments p
        LEFT JOIN clients  c ON c.id = p.client_id
        LEFT JOIN trainers t ON t.id = p.trainer_id
        WHERE  1=1
          ${pFilter}
        ORDER  BY p.created_at DESC
        LIMIT  8`, params),

      /* ── 8. Monthly chart (last 6 months) ───────────────────────── */
      pool.query(`
        SELECT
          TO_CHAR(DATE_TRUNC('month', date::date), 'Mon YY') AS month,
          COALESCE(SUM(amount), 0)                            AS revenue,
          COUNT(*)                                            AS count
        FROM payments
        WHERE date >= NOW() - INTERVAL '6 months'
          ${tFilter}
        GROUP  BY DATE_TRUNC('month', date::date)
        ORDER  BY DATE_TRUNC('month', date::date)`, params),

      /* ── 9. Top 5 trainers by this-month revenue (admin only) ───── */
      !tid ? pool.query(`
        SELECT t.id, t.name, t.specialization,
          COUNT(c.id) FILTER (WHERE c.status = 'active') AS active_clients,
          COALESCE(SUM(p.amount) FILTER (
            WHERE p.date >= DATE_TRUNC('month', NOW())
          ), 0) AS month_revenue
        FROM   trainers t
        LEFT JOIN clients  c ON c.trainer_id = t.id
        LEFT JOIN payments p ON p.trainer_id = t.id
        WHERE  t.status = 'active'
        GROUP  BY t.id, t.name, t.specialization
        ORDER  BY month_revenue DESC
        LIMIT  5`)
      : Promise.resolve({ rows: [] }),

      /* ── 10. Attendance today ───────────────────────────────────── */
      pool.query(`
        SELECT COUNT(*) AS present
        FROM   attendance
        WHERE  date   = CURRENT_DATE
          AND  status = 'present'
          AND  type   = 'client'
          ${tFilter}`, params),


      /* ── 11. Birthdays today ────────────────────────────────────── */
      pool.query(`
        SELECT COUNT(*) AS count
        FROM   clients
        WHERE  status = 'active'
          AND  dob IS NOT NULL
          AND  EXTRACT(DOY FROM dob::date) = EXTRACT(DOY FROM CURRENT_DATE)
          ${tFilter}`, params),

      /* ── 12. Anniversaries today ────────────────────────────────── */
      pool.query(`
        SELECT COUNT(*) AS count
        FROM   clients
        WHERE  status     = 'active'
          AND  joining_date IS NOT NULL
          AND  EXTRACT(DOY  FROM joining_date::date) = EXTRACT(DOY  FROM CURRENT_DATE)
          AND  EXTRACT(YEAR FROM joining_date::date) < EXTRACT(YEAR FROM CURRENT_DATE)
          ${tFilter}`, params),

      /* ── 13. Pending renewals (expired within last 30 days) ─────── */
      pool.query(`
        SELECT COUNT(*) AS count
        FROM   clients
        WHERE  status      = 'expired'
          AND  pt_end_date >= CURRENT_DATE - INTERVAL '30 days'
          ${tFilter}`, params),

      /* ── 14. Active PT subscriptions ────────────────────────────── */
      pool.query(`
        SELECT COUNT(*) AS count
        FROM   clients
        WHERE  status = 'active'
          AND  pt_end_date >= CURRENT_DATE
          ${tFilter}`, params),
    ]);

    const cli = clientStats.rows[0];
    const rev = revStats.rows[0];

    res.json({
      period: periodKey,

      clients: {
        total:          intOrZero(cli.total),
        active:         intOrZero(cli.active),
        expired:        intOrZero(cli.expired),
        frozen:         intOrZero(cli.frozen),
        new_this_month: intOrZero(cli.new_this_month),
      },

      revenue: {
        today:  numOrZero(todaySale.rows[0].today),
        month:  numOrZero(rev.month),
        year:   numOrZero(rev.year),
        total:  numOrZero(rev.total),
        period: numOrZero(periodRevenue.rows[0].revenue),
      },

      expiring_soon:       intOrZero(expiring.rows[0].count),
      total_dues:          numOrZero(dues.rows[0].total_dues),
      attendance_today:    intOrZero(attendance.rows[0].present),
      birthdays_today:     intOrZero(birthdays.rows[0].count),
      anniversaries_today: intOrZero(anniversaries.rows[0].count),
      pending_renewals:    intOrZero(pendingRenewals.rows[0].count),
      active_pt_clients:   intOrZero(activePT.rows[0].count),

      recent_payments: recentPay.rows,
      monthly_chart:   monthly.rows,
      top_trainers:    topTrainers.rows,
    });

  } catch (err) {
    // Hand off to the global handler (server.js) so prod hides err.message
    // for 5xx responses. Logging happens there too.
    next(err);
  }
});

function intOrZero(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}
function numOrZero(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

// GET /api/dashboard/badges
//
// Lightweight counts the sidebar uses to render NEW/badge pills next to
// nav items. The frontend (frontend/src/components/Sidebar.tsx) already
// fetches this endpoint and silently swallows a 404 — adding a real
// implementation just turns the silent failures into accurate badges.
//
// Response shape (all keys optional, integers, never null):
//   {
//     leadsCount, followupsToday, expiringCount,
//     birthdaysToday, duesCount, pendingLeaves
//   }
router.get('/badges', auth, async (req, res, next) => {
  try {
    const isTrainer = req.user.role === 'trainer';
    const tid       = isTrainer ? req.user.trainer_id : null;
    const params    = tid ? [tid] : [];
    const tFilter   = tid ? 'AND trainer_id = $1' : '';

    const [leads, followupsToday, expiring, birthdays, dues] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS count FROM clients
          WHERE status = 'lead' ${tFilter}`,
        params,
      ),
      pool.query(
        `SELECT COUNT(*) AS count FROM clients
          WHERE status = 'lead'
            AND COALESCE(next_followup_date::date, CURRENT_DATE) <= CURRENT_DATE
            ${tFilter}`,
        params,
      ).catch(() => ({ rows: [{ count: 0 }] })),  // table column may be absent
      pool.query(
        `SELECT COUNT(*) AS count FROM clients
          WHERE status = 'active'
            AND pt_end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
            ${tFilter}`,
        params,
      ),
      pool.query(
        `SELECT COUNT(*) AS count FROM clients
          WHERE status = 'active' AND dob IS NOT NULL
            AND EXTRACT(DOY FROM dob::date) = EXTRACT(DOY FROM CURRENT_DATE)
            ${tFilter}`,
        params,
      ),
      pool.query(
        `SELECT COUNT(*) AS count FROM clients
          WHERE balance_amount > 0 ${tFilter}`,
        params,
      ),
    ]);

    // pendingLeaves comes from a (currently optional) leave_requests table;
    // swallow "does not exist" so the endpoint stays useful before that
    // migration ships.
    let pendingLeaves = 0;
    try {
      const r = await pool.query(
        `SELECT COUNT(*) AS count FROM leave_requests WHERE status = 'pending'`,
      );
      pendingLeaves = intOrZero(r.rows[0].count);
    } catch (_) {
      pendingLeaves = 0;
    }

    res.json({
      leadsCount:      intOrZero(leads.rows[0].count),
      followupsToday:  intOrZero(followupsToday.rows[0].count),
      expiringCount:   intOrZero(expiring.rows[0].count),
      birthdaysToday:  intOrZero(birthdays.rows[0].count),
      duesCount:       intOrZero(dues.rows[0].count),
      pendingLeaves,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

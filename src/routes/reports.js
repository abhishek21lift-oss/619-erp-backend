// src/routes/reports.js
const router = require('express').Router();
const pool = require('../db/pool');
const { auth, adminOnly } = require('../middleware/auth');
const { tenantScope } = require('../lib/tenant-db');

// Null-safe tenant param: a tenant user gets their org id (queries then filter
// `organization_id = $x`); a platform super admin operating platform-wide gets
// NULL, and `$x IS NULL OR organization_id = $x` matches every row. A super
// admin targeting one org via x-org-id gets that org id and is filtered.
function orgParam(req) {
  const scope = tenantScope(req);
  return scope.applyFilter ? scope.orgId : null;
}

// GET /api/reports/monthly
// Monthly revenue from PT payments only (legacy `payments` table is empty).
router.get('/monthly', auth, async (req, res, next) => {
  try {
    const { year = new Date().getFullYear() } = req.query;
    const isTrainer = req.user.role === 'trainer';
    const tid = isTrainer ? req.user.trainer_id : null;
    const params = tid ? [parseInt(year), tid] : [parseInt(year)];
    const trainerWhere = tid ? 'AND p.trainer_id=$2' : '';
    // Tenant isolation: scope PT revenue to the caller's org (null-safe for
    // platform super admins).
    params.push(orgParam(req));
    const ptOrgWhere = `AND ($${params.length}::uuid IS NULL OR p.organization_id = $${params.length})`;

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
        FROM pt_payments p
        WHERE EXTRACT(YEAR FROM p.date::date) = $1
          AND p.deleted_at IS NULL
          ${trainerWhere}
          ${ptOrgWhere}
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
// Trainer summary from PT clients and PT payments only (legacy tables are empty).
router.get('/trainer-summary', auth, adminOnly, async (req, res, next) => {
  try {
    // Tenant isolation: scope to the caller's org via the driving `trainers`
    // table (null-safe for platform super admins). The client/payment joins
    // hang off trainer_id, so scoping trainers scopes the whole summary.
    const { rows } = await pool.query(`
      SELECT t.id, t.name, t.specialization,
        COUNT(ptc.id) FILTER (WHERE ptc.status='active' AND ptc.deleted_at IS NULL) AS active_clients,
        COUNT(ptc.id) FILTER (WHERE ptc.deleted_at IS NULL) AS total_clients,
        COALESCE(SUM(ptp.amount) FILTER (WHERE ptp.date >= DATE_TRUNC('month',NOW()) AND ptp.deleted_at IS NULL), 0) AS month_revenue,
        COALESCE(SUM(ptp.amount) FILTER (WHERE ptp.deleted_at IS NULL), 0) AS total_revenue
      FROM trainers t
      LEFT JOIN pt_clients  ptc ON ptc.trainer_id = t.id
      LEFT JOIN pt_payments ptp ON ptp.trainer_id = t.id
      WHERE t.status = 'active'
        AND ($1::uuid IS NULL OR t.organization_id = $1)
      GROUP BY t.id, t.name, t.specialization
      ORDER BY total_revenue DESC`,
      [orgParam(req)]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/trainers — alias for /trainer-summary (used by frontend Reports page)
// Trainer summary from PT clients and PT payments only (legacy tables are empty).
router.get('/trainers', auth, adminOnly, async (req, res, next) => {
  try {
    // Tenant isolation: scope to the caller's org via the driving `trainers`
    // table (null-safe for platform super admins).
    const { rows } = await pool.query(`
      SELECT t.id, t.name, t.specialization,
        COUNT(ptc.id) FILTER (WHERE ptc.status='active' AND ptc.deleted_at IS NULL) AS active_clients,
        COUNT(ptc.id) FILTER (WHERE ptc.deleted_at IS NULL) AS total_clients,
        COALESCE(SUM(ptp.amount) FILTER (WHERE ptp.date >= DATE_TRUNC('month',NOW()) AND ptp.deleted_at IS NULL), 0) AS month_revenue,
        COALESCE(SUM(ptp.amount) FILTER (WHERE ptp.deleted_at IS NULL), 0) AS total_revenue
      FROM trainers t
      LEFT JOIN pt_clients  ptc ON ptc.trainer_id = t.id
      LEFT JOIN pt_payments ptp ON ptp.trainer_id = t.id
      WHERE t.status = 'active'
        AND ($1::uuid IS NULL OR t.organization_id = $1)
      GROUP BY t.id, t.name, t.specialization
      ORDER BY total_revenue DESC`,
      [orgParam(req)]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/revenue — total collected revenue for a date range
// From PT payments only (legacy `payments` table is empty).
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

    // Tenant isolation: scope PT revenue to the caller's org.
    params.push(orgParam(req));
    const orgIdx = params.length;

    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::int                AS count,
        COALESCE(SUM(p.amount), 0)   AS total,
        COALESCE(SUM(p.incentive_amt), 0) AS total_incentives
      FROM pt_payments p
      ${where}
        AND ($${orgIdx}::uuid IS NULL OR organization_id = $${orgIdx})
    `, params);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/dues/summary
//
// The authoritative outstanding figures, aggregated in the database.
//
// GET /dues below returns the top 100 debtors by balance — the right thing for
// a table and the wrong thing for a total. The Outstanding Dues page was
// summing those rows in the browser, so once a studio passed 100 debtors its
// headline "Outstanding" silently became "outstanding among the hundred who
// owe the most" while still being presented as the whole number. The risk-band
// counts beside it had the same fault.
//
// This runs the IDENTICAL population as /dues — same union, same
// balance_amount > 0, same soft-delete filter, same trainer scope, same org
// scope — differing only in having no LIMIT and returning aggregates instead
// of rows. It is a separate route rather than a change to /dues so the array
// response stays untouched: three pages consume that (finance/dues, reports,
// insights/revenue) and none of them have to change.
//
// The risk thresholds arrive as query params rather than being hard-coded
// here. They are already defined in the page (riskLevel() in finance/dues),
// and a second copy on the server is how the two drift apart later.
router.get('/dues/summary', auth, async (req, res, next) => {
  try {
    const tid = req.user.role === 'trainer' ? req.user.trainer_id : null;
    const params = [];
    let trainerFilter = '';
    if (tid) {
      params.push(tid);
      trainerFilter = ` AND trainer_id = $${params.length}`;
    }

    params.push(orgParam(req));
    const orgIdx = params.length;

    // Defaults match the page's current bands; a caller may override them.
    const high = Number.isFinite(Number(req.query.high)) ? Number(req.query.high) : 10000;
    const medium = Number.isFinite(Number(req.query.medium)) ? Number(req.query.medium) : 3000;
    params.push(high);
    const highIdx = params.length;
    params.push(medium);
    const medIdx = params.length;

    const { rows } = await pool.query(`
      SELECT
        COALESCE(SUM(balance_amount), 0)                           AS total_outstanding,
        COUNT(*)::int                                              AS debtor_count,
        COUNT(*) FILTER (WHERE balance_amount >= $${highIdx})::int      AS high_risk_count,
        COUNT(*) FILTER (WHERE balance_amount >= $${medIdx}
                           AND balance_amount <  $${highIdx})::int      AS medium_risk_count
      FROM pt_clients
      WHERE balance_amount > 0 AND deleted_at IS NULL
        AND ($${orgIdx}::uuid IS NULL OR organization_id = $${orgIdx})
      ${trainerFilter}`,
      params
    );

    const r = rows[0] || {};
    res.json({
      total_outstanding: Number(r.total_outstanding || 0),
      debtor_count: Number(r.debtor_count || 0),
      high_risk_count: Number(r.high_risk_count || 0),
      medium_risk_count: Number(r.medium_risk_count || 0),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/dues
//
// Capped at 100 rows (see the LIMIT below). Anything needing a TOTAL rather
// than a page of rows must use /dues/summary above — summing what this returns
// gives the top hundred debtors, not the studio.
router.get('/dues', auth, async (req, res, next) => {
  try {
    const tid = req.user.role === 'trainer' ? req.user.trainer_id : null;
    const params = [];
    let trainerFilter = '';
    if (tid) {
      params.push(tid);
      trainerFilter = ` AND trainer_id = $${params.length}`;
    }
    // Tenant isolation: scope PT dues to the caller's org.
    params.push(orgParam(req));
    const orgIdx = params.length;
    const { rows } = await pool.query(`
      SELECT id, client_id, name, mobile, trainer_name, photo_url,
             balance_amount, pt_end_date, status
      FROM pt_clients
      WHERE balance_amount > 0 AND deleted_at IS NULL
        AND ($${orgIdx}::uuid IS NULL OR organization_id = $${orgIdx})
        ${trainerFilter}
      ORDER BY balance_amount DESC LIMIT 100`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── Monthly revenue target ──────────────────────────────────────────────────
//
// A studio admin commits to one revenue figure per calendar month. Once set it
// cannot be changed — that is enforced by a UNIQUE (organization_id, period)
// constraint and by the deliberate absence of any update route, NOT by
// disabling an input on the client.
//
// `achieved` reuses the EXACT query that GET /monthly aggregates (pt_payments,
// same date column, same soft-delete filter, same org scope). If the two ever
// diverged, the hero card and the chart directly below it would show different
// numbers for the same month, which destroys trust in both.

/** Sum of this month's revenue for the caller's scope. */
async function currentMonthRevenue(req) {
  const params = [orgParam(req)];
  const { rows } = await pool.query(`
    SELECT COALESCE(SUM(p.amount), 0) AS achieved
    FROM pt_payments p
   WHERE p.deleted_at IS NULL
     AND date_trunc('month', p.date::date) = date_trunc('month', CURRENT_DATE)
     AND ($1::uuid IS NULL OR p.organization_id = $1)`, params);
  return Number(rows[0]?.achieved ?? 0);
}

// GET /api/reports/revenue-target — this month's target, progress and lock state.
router.get('/revenue-target', auth, async (req, res, next) => {
  try {
    const orgId = orgParam(req);
    const [{ rows }, achieved] = await Promise.all([
      pool.query(
        `SELECT t.id, t.period, t.target_amount, t.created_at, u.name AS set_by_name
           FROM revenue_targets t
           LEFT JOIN users u ON u.id = t.set_by
          WHERE t.period = date_trunc('month', CURRENT_DATE)::date
            AND ($1::uuid IS NULL OR t.organization_id = $1)
          LIMIT 1`,
        [orgId],
      ),
      currentMonthRevenue(req),
    ]);

    const row = rows[0] || null;
    const target = row ? Number(row.target_amount) : null;

    res.json({
      data: {
        period: row?.period ?? new Date().toISOString().slice(0, 7) + '-01',
        target_amount: target,
        achieved,
        // Never negative: once the target is beaten "remaining" is zero, not a
        // negative number the UI would have to special-case.
        balance: target !== null ? Math.max(0, target - achieved) : null,
        surplus: target !== null ? Math.max(0, achieved - target) : null,
        pct: target !== null && target > 0 ? Math.min(999, (achieved / target) * 100) : null,
        // The single flag the client renders from — it must not infer the lock
        // from the presence of a value and get it subtly wrong.
        locked: Boolean(row),
        set_by_name: row?.set_by_name ?? null,
        set_at: row?.created_at ?? null,
        // Only an admin may set it; surfaced so the UI shows the right message
        // to a trainer rather than a form that will 403.
        can_set: req.user.role === 'admin' || req.user.role === 'super_admin',
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/reports/revenue-target — set this month's target. Once only.
router.post('/revenue-target', auth, adminOnly, async (req, res, next) => {
  try {
    const orgId = orgParam(req);
    if (!orgId) {
      // A platform super admin with no x-org-id has no studio to set a target
      // for. Fail loudly rather than writing an orphan row.
      return res.status(400).json({ error: 'Select an organization first' });
    }

    const amount = Number(req.body?.target_amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(422).json({ error: 'Enter a target amount greater than zero' });
    }
    // Matches NUMERIC(12,2): anything larger would be a fat-finger, and letting
    // it through returns a confusing 500 from the column overflow instead.
    if (amount > 9999999999) {
      return res.status(422).json({ error: 'That target is unrealistically large' });
    }

    const { rows } = await pool.query(
      `INSERT INTO revenue_targets (organization_id, period, target_amount, set_by)
       VALUES ($1, date_trunc('month', CURRENT_DATE)::date, $2, $3)
       ON CONFLICT (organization_id, period) DO NOTHING
       RETURNING id, period, target_amount, created_at`,
      [orgId, amount.toFixed(2), req.user.id],
    );

    // DO NOTHING + no returned row means a target already existed for this
    // month. This is the lock firing, and it is race-safe: two concurrent
    // requests cannot both insert, because the unique index arbitrates.
    if (!rows[0]) {
      return res.status(409).json({
        error: 'This month’s target is already set and cannot be changed until next month',
        code: 'TARGET_ALREADY_SET',
      });
    }

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

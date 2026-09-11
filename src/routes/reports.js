// src/routes/reports.js — COMPATIBILITY SURFACE over the canonical Metric Engine.
//
// Canonical: src/modules/insights/metric-engine.js + metric-definitions.js.
// This router owns NO formulas: every handler delegates to the engine so
// /api/reports/* and /api/insights/* can never disagree. New clients must use
// /api/insights/* (see src/modules/insights/insights.routes.js); these routes
// stay mounted with `Deprecation: true` + Sunset-style Link headers until the
// migration is proven safe. Response shapes are frozen — do not "improve" them
// here, change the canonical endpoint and map here if needed.
const router = require('express').Router();
const pool = require('../db/pool');
const { auth, adminOnly } = require('../middleware/auth');
const { tenantScope } = require('../lib/tenant-db');
const engine = require('../modules/insights/metric-engine');

// Null-safe tenant param: a tenant user gets their org id (queries then filter
// `organization_id = $x`); a platform super admin operating platform-wide gets
// NULL, and `$x IS NULL OR organization_id = $x` matches every row. A super
// admin targeting one org via x-org-id gets that org id and is filtered.
function orgParam(req) {
  const scope = tenantScope(req);
  return scope.applyFilter ? scope.orgId : null;
}

// GET /api/reports/monthly — canonical: metric-engine.getMonthlyRevenue
// (finance/pt_payments, deleted_at IS NULL, org-scoped). Shape frozen.
router.get('/monthly', auth, async (req, res, next) => {
  try {
    res.set('Deprecation', 'true');
    res.set('Link', '</api/insights/revenue/monthly>; rel="successor-version"');
    const { year = new Date().getFullYear() } = req.query;
    const isTrainer = req.user.role === 'trainer';
    const tid = isTrainer ? req.user.trainer_id : null;
    const scope = tenantScope(req);
    const rows = await engine.getMonthlyRevenue({
      year,
      orgId: scope.applyFilter ? scope.orgId : null,
      trainerId: tid,
    });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/trainer-summary (admin only) — canonical:
// metric-engine.getTrainerSummary. Shape frozen.
router.get('/trainer-summary', auth, adminOnly, async (req, res, next) => {
  try {
    res.set('Deprecation', 'true');
    res.set('Link', '</api/insights/trainers>; rel="successor-version"');
    const scope = tenantScope(req);
    res.json(await engine.getTrainerSummary({
      orgId: scope.applyFilter ? scope.orgId : null,
    }));
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/trainers — DEPRECATED alias for /trainer-summary.
// Same canonical source (metric-engine.getTrainerSummary). Kept for
// compatibility; new code must call /api/insights/trainers.
router.get('/trainers', auth, adminOnly, async (req, res, next) => {
  try {
    res.set('Deprecation', 'true');
    res.set('Link', '</api/insights/trainers>; rel="successor-version"');
    const scope = tenantScope(req);
    res.json(await engine.getTrainerSummary({
      orgId: scope.applyFilter ? scope.orgId : null,
    }));
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/revenue — canonical: metric-engine.getRevenue.
// Shape frozen: { count, total, total_incentives }.
router.get('/revenue', auth, async (req, res, next) => {
  try {
    res.set('Deprecation', 'true');
    res.set('Link', '</api/insights/revenue>; rel="successor-version"');
    const { from, to, year } = req.query;
    const scope = tenantScope(req);
    // Preserve legacy year-only behaviour: year without from/to means Jan 1 - Dec 31.
    let f = from, tt = to;
    if (year && !from && !to) {
      f = `${parseInt(year, 10)}-01-01`;
      tt = `${parseInt(year, 10)}-12-31`;
    }
    const r = await engine.getRevenue({
      from: f, to: tt,
      orgId: scope.applyFilter ? scope.orgId : null,
      trainerId: req.user.role === 'trainer' ? req.user.trainer_id || null : null,
    });
    res.json({ count: r.count, total: r.total, total_incentives: r.total_incentives });
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
    res.set('Deprecation', 'true');
    res.set('Link', '</api/insights/dues/summary>; rel="successor-version"');
    const tid = req.user.role === 'trainer' ? req.user.trainer_id : null;
    const scope = tenantScope(req);
    const high = Number.isFinite(Number(req.query.high)) ? Number(req.query.high) : 10000;
    const medium = Number.isFinite(Number(req.query.medium)) ? Number(req.query.medium) : 3000;
    res.json(await engine.getDuesSummary({
      high, medium,
      orgId: scope.applyFilter ? scope.orgId : null,
      trainerId: tid,
    }));
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/dues — top-100 debtor ROWS (tables only).
// Totals must use /dues/summary. Canonical rows: metric-engine.getDuesRows.
router.get('/dues', auth, async (req, res, next) => {
  try {
    res.set('Deprecation', 'true');
    res.set('Link', '</api/insights/dues>; rel="successor-version"');
    const tid = req.user.role === 'trainer' ? req.user.trainer_id : null;
    const scope = tenantScope(req);
    res.json(await engine.getDuesRows({
      orgId: scope.applyFilter ? scope.orgId : null,
      trainerId: tid,
      limit: 100,
    }));
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
  // Canonical: same source as /monthly (pt_payments, deleted_at IS NULL).
  const scope = tenantScope(req);
  const now = new Date();
  const f = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
  const r = await engine.getRevenue({
    from: f, to: last,
    orgId: scope.applyFilter ? scope.orgId : null,
  });
  return Number(r.total ?? 0);
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

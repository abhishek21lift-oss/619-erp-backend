'use strict';
// GET /api/insights — the canonical metric surface.
//
// One request returns every headline figure for one window, all computed from
// definitions.js. That is the point: a dashboard that fetches its KPIs from
// four endpoints can render four numbers that were true at four different
// instants and were filtered four different ways, which is how the same
// studio came to show two different "active clients" on two screens.
//
// This file contains no SQL. It parses the window, calls the repository, and
// returns. Layering is enforced by architecture.layering.convention.test.js.
//
// ── What this does NOT do ──────────────────────────────────────────────────
//
// It does not replace /api/reports, /api/pt-os/dashboard or the finance
// endpoints, and nothing is deleted in the change that adds it. Those serve
// working screens; repointing them is a migration with its own risk, and the
// first step is having one definition to migrate TO. What it does is make the
// disagreement visible and fixable in one place.

const router = require('express').Router();
const { auth } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { tenantScope } = require('../../lib/tenant-db');
const repo = require('./insights.repository');
const { CATALOGUE } = require('./definitions');

// Insights are a studio-management view: money, retention, trainer load.
// Trainers see their own clients through the PT-OS screens, not the studio's
// commercial position. Matches the nav, which gates the Insights group on
// admin/manager.
const STAFF = requireRole('admin', 'manager');

/** Null-safe tenant param, identical in contract to routes/reports.js:11. */
function orgParam(req) {
  const scope = tenantScope(req);
  return scope.applyFilter ? scope.orgId : null;
}

const DAY = 86400000;
const MAX_WINDOW_DAYS = 1096; // three years

/**
 * Resolve `from`/`to` into two ISO dates, or throw a 400-shaped error.
 *
 * Validated rather than trusted: these land in `BETWEEN $2::date AND $3::date`,
 * and an unparseable value would otherwise reach Postgres as a cast error and
 * surface as a 500. Bounded because an open-ended window over the payment
 * ledger is an unbounded scan — the property boundedReads.convention.test.js
 * pins for every other aggregate in this codebase.
 */
function resolveWindow(query) {
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);

  const to = query.to ? String(query.to) : iso(today);
  const from = query.from
    ? String(query.from)
    : iso(new Date(today.getTime() - 29 * DAY));

  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    const err = new Error('from and to must be YYYY-MM-DD dates');
    err.status = 400;
    throw err;
  }
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const toMs = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
    const err = new Error('from and to must be real dates');
    err.status = 400;
    throw err;
  }
  if (fromMs > toMs) {
    const err = new Error('from must not be after to');
    err.status = 400;
    throw err;
  }
  if ((toMs - fromMs) / DAY > MAX_WINDOW_DAYS) {
    const err = new Error(`window must not exceed ${MAX_WINDOW_DAYS} days`);
    err.status = 400;
    throw err;
  }
  return { from, to };
}

/**
 * GET /api/insights/summary?from&to
 *
 * Every headline metric for one window, from one scope, at one instant.
 * `meta.window` is echoed back so a chart and a KPI rendered from this
 * response cannot disagree about which period they are showing — the
 * frontend previously derived its own default window per page, and four
 * pages derived four different ones.
 */
router.get('/summary', auth, STAFF, async (req, res, next) => {
  try {
    const { from, to } = resolveWindow(req.query);
    const orgId = orgParam(req);

    // Sequential rather than Promise.all: these share one pool, and five
    // concurrent connections per dashboard load is how a small pool starves
    // under a handful of users. None of them is slow enough to need it.
    const clients = await repo.clientStock(orgId);
    const renewal = await repo.renewalConversion(orgId, from, to);
    const money = await repo.revenue(orgId, from, to);
    const attend = await repo.attendance(orgId, from, to);
    const session = await repo.sessions(orgId, from, to);

    res.json({
      data: {
        active_clients: clients.active,
        lapsed_clients: clients.lapsed,
        enrolled_clients: clients.enrolled,
        outstanding: clients.outstanding,
        revenue_contracted_monthly: clients.contracted_monthly,

        terms_due: renewal.terms_due,
        terms_renewed: renewal.terms_renewed,
        renewal_rate_pct: renewal.renewal_rate_pct,

        revenue_collected: money.collected,
        incentives: money.incentives,
        payment_count: money.payment_count,

        attendance_total: attend.total,
        attendance_attended: attend.attended,
        attendance_unique_clients: attend.unique_clients,
        attendance_rate_pct: attend.attendance_rate_pct,

        sessions_delivered: session.delivered,
        sessions_booked: session.booked,
      },
      meta: { window: { from, to } },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/insights/definitions
 *
 * What each figure means, served from the same constant the queries are built
 * from. A UI that labels a number from here cannot describe it as something
 * the server did not compute — which is the failure this whole module exists
 * to fix, in its documentation layer as much as its SQL.
 *
 * Public to any signed-in staff member: it contains no studio data, only the
 * dictionary.
 */
router.get('/definitions', auth, (req, res) => {
  res.json({ data: CATALOGUE });
});

module.exports = router;

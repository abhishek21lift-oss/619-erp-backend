'use strict';
/**
 * Canonical Insights routes — ONE HTTP surface for Insights/Reports/Dashboard.
 *
 *   GET /api/insights/overview?from&to&year        — one dataset for KPIs+charts+tables
 *   GET /api/insights/revenue?from&to&year         — canonical revenue
 *   GET /api/insights/revenue/monthly?year=        — canonical monthly series
 *   GET /api/insights/dues/summary?high&medium     — canonical dues totals (no LIMIT)
 *   GET /api/insights/dues?limit=                  — top-N debtor rows (tables only)
 *   GET /api/insights/attendance?from&to&granularity — canonical attendance (present+late)
 *   GET /api/insights/attendance/today             — today summary
 *   GET /api/insights/renewals?from&to             — TRUE renewal conversion + pipeline counts
 *   GET /api/insights/renewals/rows?days&limit     — renewal pipeline rows (top-N)
 *   GET /api/insights/trainers                     — canonical trainer summary
 *   GET /api/insights/utilisation                  — session completion
 *   GET /api/insights/business                     — deterministic business insights (no LLM)
 *
 * Guards: mount adds [auth, requireStaff, requireFeature('insights')] in
 * server.js. Trainers are clamped to their own rows; members never reach here
 * (requireStaff). orgId comes from tenantScope — null only for platform-wide
 * super_admin.
 *
 * Compatibility: /api/reports stays mounted and delegates to the same
 * metric-engine (see routes/reports.js). New clients use /api/insights/*.
 */
const router = require('express').Router();
const { auth, adminOnly } = require('../../middleware/auth');
const { tenantScope } = require('../../lib/tenant-db');
const engine = require('./metric-engine');
const { buildBusinessInsights } = require('./insights-engine');

function orgParam(req) {
  const scope = tenantScope(req);
  return scope.applyFilter ? scope.orgId : null;
}

function trainerParam(req) {
  return req.user && req.user.role === 'trainer' ? req.user.trainer_id || null : null;
}

function ctx(req) {
  return { orgId: orgParam(req), trainerId: trainerParam(req) };
}

// GET /api/insights/overview — the page-level call. Prefer this.
router.get('/overview', auth, async (req, res, next) => {
  try {
    const { from, to, year } = req.query;
    res.json(await engine.getOverview({ from, to, year, ...ctx(req) }));
  } catch (err) { next(err); }
});

router.get('/revenue', auth, async (req, res, next) => {
  try {
    const { from, to } = req.query;
    res.json(await engine.getRevenue({ from, to, ...ctx(req) }));
  } catch (err) { next(err); }
});

router.get('/revenue/monthly', auth, async (req, res, next) => {
  try {
    const { year } = req.query;
    res.json(await engine.getMonthlyRevenue({ year: year || new Date().getFullYear(), ...ctx(req) }));
  } catch (err) { next(err); }
});

router.get('/dues/summary', auth, async (req, res, next) => {
  try {
    const high = Number.isFinite(Number(req.query.high)) ? Number(req.query.high) : 10000;
    const medium = Number.isFinite(Number(req.query.medium)) ? Number(req.query.medium) : 3000;
    res.json(await engine.getDuesSummary({ high, medium, ...ctx(req) }));
  } catch (err) { next(err); }
});

router.get('/dues', auth, async (req, res, next) => {
  try {
    res.set('X-Insights-Note', 'top-N rows only; totals must use /dues/summary');
    res.json(await engine.getDuesRows({ limit: req.query.limit, ...ctx(req) }));
  } catch (err) { next(err); }
});

router.get('/attendance', auth, async (req, res, next) => {
  try {
    const { from, to, granularity } = req.query;
    res.json(await engine.getAttendanceStats({ from, to, granularity, ...ctx(req) }));
  } catch (err) { next(err); }
});

router.get('/attendance/today', auth, async (req, res, next) => {
  try {
    res.json(await engine.getAttendanceToday(ctx(req)));
  } catch (err) { next(err); }
});

router.get('/renewals', auth, async (req, res, next) => {
  try {
    const { from, to } = req.query;
    res.json(await engine.getRenewals({ from, to, ...ctx(req) }));
  } catch (err) { next(err); }
});

router.get('/renewals/rows', auth, async (req, res, next) => {
  try {
    res.set('X-Insights-Note', 'pipeline rows only; conversion must use /renewals');
    res.json(await engine.getRenewalRows({ days: req.query.days, limit: req.query.limit, ...ctx(req) }));
  } catch (err) { next(err); }
});

// Admin/manager only — mirrors legacy /reports/trainer-summary (per-trainer
// revenue is not peer-visible data).
router.get('/trainers', auth, adminOnly, async (req, res, next) => {
  try {
    res.json(await engine.getTrainerSummary({ orgId: orgParam(req) }));
  } catch (err) { next(err); }
});

router.get('/utilisation', auth, async (req, res, next) => {
  try {
    res.json(await engine.getUtilization({ orgId: orgParam(req) }));
  } catch (err) { next(err); }
});

// GET /api/insights/business — deterministic insights, no LLM, same shape the
// AI endpoint attaches narrative to.
router.get('/business', auth, async (req, res, next) => {
  try {
    const { from, to, year } = req.query;
    const overview = await engine.getOverview({ from, to, year, ...ctx(req) });
    res.json({ window: overview.window, insights: buildBusinessInsights(overview), metrics: overview });
  } catch (err) { next(err); }
});

module.exports = router;

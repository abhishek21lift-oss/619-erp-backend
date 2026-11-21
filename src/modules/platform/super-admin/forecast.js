'use strict';
// Platform revenue forecast — super-admin API.
//
// The console could show what was collected (subscription-metrics) but not
// what is likely to be collected next. This module answers that question with
// two deliberately separate models, because they are good at different things
// and blending them would hide which one produced a number:
//
//   1. CASH TREND — least-squares over the last 12 months of paid subscription
//      payments. This is the money that actually arrived. It is lumpy (annual
//      plans land in one month), so the fit reports its own R² and a residual
//      band; a low R² is shown, not hidden.
//
//   2. MRR RUN-RATE — current MRR compounded by the observed net studio growth
//      (activations minus losses) over the last six months, clamped to a sane
//      monthly range. This is the recurring-revenue view and it does not try to
//      predict one-off annual cash.
//
// Neither model is allowed to invent history. With fewer than four months of
// payments the cash model returns no forecast and says why; the MRR model
// returns no forecast until there is at least one month of event history.
//
// No new table: both inputs already exist (subscription_payments,
// subscription_events, organizations + subscription_plans). A forecast is a
// read, not a fact to store.

const router = require('express').Router();
const { pool } = require('./shared');

const MIN_CASH_MONTHS = 4;
const MAX_MONTHS = 12;
const MAX_MONTHLY_GROWTH = 0.20;

function monthKey(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function labelFor(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Zero-filled month keys ending at the current month. */
function lastMonths(n) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    out.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
  }
  return out;
}

function futureMonths(n) {
  const out = [];
  const now = new Date();
  for (let i = 1; i <= n; i++) {
    out.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1))));
  }
  return out;
}

function leastSquares(ys) {
  const n = ys.length;
  const xs = ys.map((_, i) => i);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0; let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  const residuals = ys.map((y, i) => y - (intercept + slope * i));
  const sse = residuals.reduce((a, r) => a + r * r, 0);
  const sst = ys.reduce((a, y) => a + (y - my) ** 2, 0);
  const r2 = sst === 0 ? 0 : Math.max(0, Math.min(1, 1 - sse / sst));
  const se = n > 2 ? Math.sqrt(sse / (n - 2)) : 0;
  return { slope, intercept, r2, se, n };
}

function round(v) {
  return Math.round(Number(v) || 0);
}

// GET /revenue-forecast?months=6 — cash trend + MRR run-rate.
router.get('/revenue-forecast', async (req, res, next) => {
  try {
    const horizon = Math.min(Math.max(Number(req.query.months) || 6, 1), MAX_MONTHS);

    const [cashRows, mrrRow, eventRows, activeRow] = await Promise.all([
      // Cash actually collected, by month, for the last 12 months.
      pool.query(`
        SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
               COALESCE(SUM(amount_inr) FILTER (WHERE status = 'paid'), 0)::bigint AS paid_inr,
               count(*) FILTER (WHERE status = 'paid')::int AS payments
          FROM subscription_payments
         WHERE created_at >= date_trunc('month', now()) - interval '11 months'
         GROUP BY 1 ORDER BY 1`),

      // Current run-rate, same definition as /subscription-metrics.
      pool.query(`
        SELECT COALESCE(SUM(COALESCE(o.locked_price_inr, p.price_inr)::numeric
                            / NULLIF(p.duration_months, 0)), 0)::int AS mrr_inr,
               count(*)::int AS paying_studios
          FROM organizations o
          JOIN subscription_plans p ON p.code = o.plan_code
         WHERE o.subscription_status = 'active'
           AND o.status <> 'suspended'
           AND (o.current_period_end IS NULL OR o.current_period_end > now())`),

      // Studio flow. `activated` is a join, `cancelled`/`expired`/`frozen` are
      // a loss. Plan changes are deliberately excluded: they move MRR but do
      // not change the studio count, and this model is a count model.
      pool.query(`
        WITH months AS (
          SELECT generate_series(
            date_trunc('month', now()) - interval '5 months',
            date_trunc('month', now()),
            interval '1 month'
          )::date AS month
        )
        SELECT to_char(m.month, 'YYYY-MM') AS month,
               count(e.id) FILTER (WHERE e.event = 'activated')::int AS activations,
               count(e.id) FILTER (WHERE e.event IN ('cancelled','expired','frozen'))::int AS losses
          FROM months m
          LEFT JOIN subscription_events e
            ON date_trunc('month', e.created_at) = m.month
         GROUP BY 1 ORDER BY 1`),

      pool.query(`
        SELECT count(*)::int AS total
          FROM organizations o
         WHERE o.subscription_status = 'active'
           AND o.status <> 'suspended'
           AND (o.current_period_end IS NULL OR o.current_period_end > now())`),
    ]);

    // ── Cash history, zero-filled ─────────────────────────────────────────
    const cashMonths = lastMonths(12);
    const byMonth = new Map(cashRows.rows.map((r) => [r.month, r]));
    const history = cashMonths.map((m) => ({
      month: m,
      label: labelFor(m),
      revenue_inr: round(byMonth.get(m)?.paid_inr),
      payments: Number(byMonth.get(m)?.payments ?? 0),
    }));

    // The current month is incomplete. Fitting it as a full month would drag
    // the trend down every time somebody opened this screen early in the
    // month; the model uses completed months only, and the partial month is
    // returned separately so the UI can show it without it influencing the fit.
    const completed = history.slice(0, -1);
    const nonZero = completed.filter((h) => h.revenue_inr > 0);
    const fit = nonZero.length >= MIN_CASH_MONTHS ? leastSquares(completed.map((h) => h.revenue_inr)) : null;

    const cashForecast = fit ? futureMonths(horizon).map((m, i) => {
      const value = Math.max(0, fit.intercept + fit.slope * (fit.n - 1 + i + 1));
      // 95% band from the residual error, widened 12% per month of horizon.
      const half = 1.96 * fit.se * Math.sqrt(1 + 0.12 * i);
      return {
        month: m,
        label: labelFor(m),
        revenue_inr: round(value),
        low_inr: round(Math.max(0, value - half)),
        high_inr: round(value + half),
      };
    }) : [];

    const lastComplete = completed[completed.length - 1];
    const trailing3 = completed.slice(-3).reduce((a, h) => a + h.revenue_inr, 0) / 3;

    // ── MRR run-rate scenario ─────────────────────────────────────────────
    const events = eventRows.rows;
    const monthsWithData = events.filter((e) => Number(e.activations) + Number(e.losses) > 0).length;
    const activations = events.reduce((a, e) => a + Number(e.activations), 0);
    const losses = events.reduce((a, e) => a + Number(e.losses), 0);
    const activeStudios = Number(activeRow.rows[0]?.total ?? 0);
    const mrr = Number(mrrRow.rows[0]?.mrr_inr ?? 0);
    const payingStudios = Number(mrrRow.rows[0]?.paying_studios ?? 0);

    // Net monthly studio growth, relative to the current base. When the base is
    // zero there is no rate to compute, so the scenario is omitted rather than
    // divided by nothing.
    const rawGrowth = payingStudios > 0 && monthsWithData > 0
      ? (activations - losses) / Math.max(1, payingStudios) / monthsWithData
      : null;
    const growth = rawGrowth == null ? null : Math.max(-MAX_MONTHLY_GROWTH, Math.min(MAX_MONTHLY_GROWTH, rawGrowth));

    const mrrForecast = growth == null ? [] : futureMonths(horizon).map((m, i) => ({
      month: m,
      label: labelFor(m),
      mrr_inr: round(mrr * (1 + growth) ** (i + 1)),
    }));

    res.json({
      data: {
        generated_at: new Date().toISOString(),
        horizon_months: horizon,
        currency: 'INR',
        current: {
          mrr_inr: mrr,
          arr_inr: mrr * 12,
          paying_studios: payingStudios,
          active_studios: activeStudios,
          trailing_3m_cash_inr: round(trailing3),
          last_complete_month: lastComplete ? { month: lastComplete.month, revenue_inr: lastComplete.revenue_inr } : null,
        },
        history,
        cash_forecast: cashForecast,
        cash_model: fit ? {
          method: 'least_squares_12m',
          // The partial current month is excluded on purpose; say so.
          months_fitted: fit.n,
          partial_month_excluded: history[history.length - 1]?.month ?? null,
          slope_inr_per_month: round(fit.slope),
          r2: Math.round(fit.r2 * 1000) / 1000,
          residual_std_inr: round(fit.se),
        } : {
          method: 'least_squares_12m',
          months_fitted: completed.length,
          reason: `At least ${MIN_CASH_MONTHS} completed months with payments are needed to fit a trend.`,
        },
        mrr_forecast: mrrForecast,
        mrr_model: growth == null ? {
          method: 'net_studio_growth',
          reason: 'No paying studios or no subscription-event history to measure net growth.',
        } : {
          method: 'net_studio_growth',
          months_observed: monthsWithData,
          activations,
          losses,
          monthly_growth_pct: Math.round(growth * 1000) / 10,
          // Stated because the number is a scenario, not a prediction.
          clamped: rawGrowth !== growth,
          clamp_pct: MAX_MONTHLY_GROWTH * 100,
        },
      },
    });
  } catch (err) { next(err); }
});

// The router is the module's export contract (every domain module in this
// directory is mounted with router.use()). The model helpers ride along as
// properties so the unit test can exercise them without a database.
module.exports = router;
module.exports.leastSquares = leastSquares;
module.exports.lastMonths = lastMonths;
module.exports.futureMonths = futureMonths;

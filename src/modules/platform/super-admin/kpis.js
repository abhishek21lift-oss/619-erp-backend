'use strict';
// Platform Overview KPIs — the home screen's numbers.
const router = require('express').Router();
const { pool } = require('./shared');

const CACHE_TTL_MS = 5 * 60 * 1000;
let _cache = null;
let _inFlight = null;

router.get('/overview/kpis', async (req, res, next) => {
  try {
    const force = req.query.fresh === '1' || req.query.fresh === 'true';
    if (!force && _cache && Date.now() - _cache.at < CACHE_TTL_MS) {
      return res.json({ data: _cache.data, cached: true });
    }
    // Explicit fresh reads must not join an older cached/in-flight result.
    if (!force && _inFlight) {
      const data = await _inFlight;
      return res.json({ data, cached: true });
    }

    const run = (async () => {
      const { rows: [row] } = await pool.query(`
        WITH
          org_kpis AS (
            SELECT
              COUNT(*)::int AS total_studios,
              COUNT(*) FILTER (WHERE status = 'active')::int AS active_studios,
              COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_studios,
              COUNT(*) FILTER (WHERE subscription_status = 'trial'
                                AND (trial_ends_at IS NULL OR trial_ends_at > NOW()))::int AS trial_studios,
              COUNT(*) FILTER (WHERE status = 'suspended')::int AS suspended_studios
            FROM organizations
          ),
          owner_kpis AS (
            SELECT COUNT(DISTINCT u.id)::int AS total_owners
              FROM users u
             WHERE u.role = 'admin' AND u.deleted_at IS NULL
               AND EXISTS (SELECT 1 FROM organizations o WHERE o.id = u.organization_id)
          ),
          trainer_kpis AS (
            SELECT COUNT(*)::int AS total_trainers FROM trainers WHERE deleted_at IS NULL
          ),
          client_kpis AS (
            SELECT COUNT(*)::int AS total_clients,
                   COUNT(*) FILTER (WHERE status = 'active')::int AS active_clients,
                   COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days')::int AS new_clients_30d
              FROM pt_clients WHERE deleted_at IS NULL
          ),
          sub_kpis AS (
            SELECT COUNT(*) FILTER (WHERE subscription_status = 'active'
                                      AND (current_period_end IS NULL OR current_period_end > NOW()))::int AS active_subscriptions,
                   COUNT(*) FILTER (WHERE subscription_status = 'trial'
                                      AND (trial_ends_at IS NULL OR trial_ends_at > NOW()))::int AS trial_subscriptions,
                   COUNT(*) FILTER (WHERE subscription_status = 'active'
                                      AND current_period_end > NOW()
                                      AND current_period_end < NOW() + INTERVAL '7 days')::int AS expiring_in_7d
              FROM organizations
          ),
          revenue_kpis AS (
            SELECT COALESCE(SUM(COALESCE(o.locked_price_inr, p.price_inr)::numeric
                                / NULLIF(p.duration_months, 0)), 0)::numeric AS mrr_inr
              FROM organizations o
              JOIN subscription_plans p ON p.code = o.plan_code
             WHERE o.subscription_status = 'active'
               AND o.status <> 'suspended'
               AND (o.current_period_end IS NULL OR o.current_period_end > NOW())
          ),
          payment_kpis AS (
            SELECT COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_payments_30d
              FROM payment_orders WHERE created_at > NOW() - INTERVAL '30 days'
          ),
          alert_kpis AS (
            SELECT COUNT(*) FILTER (WHERE severity = 'critical' AND status = 'open')::int AS critical_alerts,
                   COUNT(*) FILTER (WHERE severity = 'high' AND status = 'open')::int AS high_alerts,
                   COUNT(*) FILTER (WHERE severity = 'medium' AND status = 'open')::int AS medium_alerts
              FROM system_alerts WHERE deleted_at IS NULL
          )
        SELECT ok.total_studios, ok.active_studios, ok.pending_studios, ok.trial_studios, ok.suspended_studios,
               own.total_owners, tk.total_trainers, ck.total_clients, ck.active_clients, ck.new_clients_30d,
               sk.active_subscriptions, sk.trial_subscriptions, sk.expiring_in_7d, rk.mrr_inr,
               pk.failed_payments_30d, ak.critical_alerts, ak.high_alerts, ak.medium_alerts
          FROM org_kpis ok CROSS JOIN owner_kpis own CROSS JOIN trainer_kpis tk CROSS JOIN client_kpis ck
          CROSS JOIN sub_kpis sk CROSS JOIN revenue_kpis rk CROSS JOIN payment_kpis pk CROSS JOIN alert_kpis ak
      `);
      const r = row || {};
      return {
        business: {
          total_studios: r.total_studios ?? 0, active_studios: r.active_studios ?? 0,
          pending_studios: r.pending_studios ?? 0, suspended_studios: r.suspended_studios ?? 0,
          trial_studios: r.trial_studios ?? 0, total_owners: r.total_owners ?? 0,
          total_trainers: r.total_trainers ?? 0, total_clients: r.total_clients ?? 0,
          active_clients: r.active_clients ?? 0, new_clients_30d: r.new_clients_30d ?? 0,
        },
        platform_revenue: {
          mrr_inr: Number(r.mrr_inr ?? 0), active_subscriptions: r.active_subscriptions ?? 0,
          trial_subscriptions: r.trial_subscriptions ?? 0, expiring_in_7d: r.expiring_in_7d ?? 0,
        },
        operations: { failed_payments_30d: r.failed_payments_30d ?? 0 },
        security: { critical_alerts: r.critical_alerts ?? 0, high_alerts: r.high_alerts ?? 0, medium_alerts: r.medium_alerts ?? 0 },
      };
    })();

    if (!force) _inFlight = run;
    try {
      const data = await run;
      _cache = { at: Date.now(), data };
      return res.json({ data, cached: false });
    } finally {
      if (!force) _inFlight = null;
    }
  } catch (err) { next(err); }
});

module.exports = router;

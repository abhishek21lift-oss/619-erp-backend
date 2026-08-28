'use strict';
// Platform Overview KPIs — the home screen's numbers.
//
// The home screen asks: "How is the platform performing right now?"
// and answers it from one payload, fetched once. The old
// `GET /overview` returns a per-studio list (which is still useful for
// the Studio Directory), but the home wants rolled-up numbers and a
// handful of risk indicators, not 247 rows.
//
// Five-minute cache in-process. The numbers change slowly enough that
// a stale KPI on a freshly-opened dashboard is fine, and a single
// triple-nested subquery for all of them is cheap against a single
// tenant database. The cache is a per-process map; a deployment that
// restarts reads fresh; a single platform admin never causes cache
// stampede because the cache key is fixed and the cost of a cache miss
// is one query.
//
// Mounted on the platform router. Inherits the auth chain.

const router = require('express').Router();
const { pool } = require('./shared');

const CACHE_TTL_MS = 5 * 60 * 1000;
let _cache = null;     // { at, data }
let _inFlight = null;  // dedupe concurrent refreshes

// ── GET /overview/kpis ────────────────────────────────────────────────────────
//
// One round-trip. The five sub-SELECTs are correlated counts, not joins,
// so the planner can satisfy them against the small per-table indexes
// that already exist. No N+1, no client-side aggregation, no per-tenant
// loop.
//
// `last_active` is the most-recent last_login across all users — that is
// the platform-level "is anything happening" signal, and is the number
// that changes most often, so it sits last in the projection.
router.get('/overview/kpis', async (_req, res, next) => {
  try {
    if (_cache && Date.now() - _cache.at < CACHE_TTL_MS) {
      return res.json({ data: _cache.data, cached: true });
    }
    if (_inFlight) {
      const data = await _inFlight;
      return res.json({ data, cached: true });
    }
    _inFlight = (async () => {
      const { rows: [row] } = await pool.query(`
        WITH
          org_kpis AS (
            SELECT
              COUNT(*)::int AS total_studios,
              COUNT(*) FILTER (WHERE status = 'active')::int    AS active_studios,
              COUNT(*) FILTER (WHERE status = 'pending')::int   AS pending_studios,
              COUNT(*) FILTER (WHERE status = 'suspended')::int AS suspended_studios,
              COUNT(*) FILTER (WHERE status = 'trial')::int     AS trial_studios
            FROM organizations
            WHERE deleted_at IS NULL
          ),
          owner_kpis AS (
            SELECT COUNT(DISTINCT u.id)::int AS total_owners
              FROM users u
             WHERE u.role = 'admin'
               AND u.deleted_at IS NULL
               AND EXISTS (SELECT 1 FROM organizations o WHERE o.id = u.organization_id)
          ),
          trainer_kpis AS (
            SELECT COUNT(*)::int AS total_trainers
              FROM trainers
             WHERE deleted_at IS NULL
          ),
          client_kpis AS (
            SELECT
              COUNT(*)::int                                                  AS total_clients,
              COUNT(*) FILTER (WHERE status = 'active')::int                 AS active_clients,
              COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days')::int AS new_clients_30d
              FROM pt_clients
             WHERE deleted_at IS NULL
          ),
          sub_kpis AS (
            SELECT
              COUNT(*) FILTER (WHERE status = 'active' AND ends_at > NOW())::int    AS active_subscriptions,
              COUNT(*) FILTER (WHERE status = 'trial'  AND ends_at > NOW())::int    AS trial_subscriptions,
              COUNT(*) FILTER (WHERE ends_at > NOW() AND ends_at < NOW() + INTERVAL '7 days')::int AS expiring_in_7d,
              COALESCE(SUM(amount_inr) FILTER (WHERE status = 'active' AND created_at > NOW() - INTERVAL '30 days'), 0)::numeric AS mrr_inr
              FROM subscriptions
          ),
          payment_kpis AS (
            SELECT COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_payments_30d
              FROM payment_orders
             WHERE created_at > NOW() - INTERVAL '30 days'
          ),
          alert_kpis AS (
            SELECT
              COUNT(*) FILTER (WHERE severity = 'critical' AND status = 'open')::int AS critical_alerts,
              COUNT(*) FILTER (WHERE severity = 'high'     AND status = 'open')::int AS high_alerts,
              COUNT(*) FILTER (WHERE severity = 'medium'   AND status = 'open')::int AS medium_alerts
              FROM system_alerts
          )
        SELECT
          ok.*, own.*, tk.*, ck.*, sk.*, pk.*, ak.*
        FROM org_kpis ok
        CROSS JOIN owner_kpis own
        CROSS JOIN trainer_kpis tk
        CROSS JOIN client_kpis ck
        CROSS JOIN sub_kpis sk
        CROSS JOIN payment_kpis pk
        CROSS JOIN alert_kpis ak
      `);
      const r = row;
      const data = {
        business: {
          total_studios:        r.total_studios        ?? 0,
          active_studios:       r.active_studios       ?? 0,
          pending_studios:      r.pending_studios      ?? 0,
          suspended_studios:    r.suspended_studios    ?? 0,
          trial_studios:        r.trial_studios        ?? 0,
          total_owners:         r.total_owners         ?? 0,
          total_trainers:       r.total_trainers       ?? 0,
          total_clients:        r.total_clients        ?? 0,
          active_clients:       r.active_clients       ?? 0,
          new_clients_30d:      r.new_clients_30d      ?? 0,
        },
        platform_revenue: {
          mrr_inr:              Number(r.mrr_inr ?? 0),
          active_subscriptions: r.active_subscriptions ?? 0,
          trial_subscriptions:  r.trial_subscriptions  ?? 0,
          expiring_in_7d:       r.expiring_in_7d       ?? 0,
        },
        operations: {
          failed_payments_30d:  r.failed_payments_30d  ?? 0,
        },
        security: {
          critical_alerts:      r.critical_alerts      ?? 0,
          high_alerts:          r.high_alerts          ?? 0,
          medium_alerts:        r.medium_alerts        ?? 0,
        },
      };
      return data;
    })();

    try {
      const data = await _inFlight;
      _cache = { at: Date.now(), data };
      return res.json({ data, cached: false });
    } finally {
      _inFlight = null;
    }
  } catch (err) { next(err); }
});

module.exports = router;

'use strict';
// Studio 360 — the deep-view endpoints behind /platform/studios/[id].
//
// Read-only. Every endpoint scopes by the UUID in `req.params.id`,
// which the route patterns constrain to a valid shape (`:id` is
// validated as a UUID by the route; we still re-validate here, in case
// a future mount point loses the constraint).
//
// The data served here is a rollup the platform admin reads but does
// not act on. Mutations on a tenant still go through
// `organizations.js` (PATCH/DELETE/POST), which is where the audit
// hooks live. The split is intentional: read-side endpoints are
// independent of the write-side, and an admin reading "this studio's
// memberships" should not be able to silently mutate the same rows
// through the same URL.
//
// Mounted on the platform router. Inherits the auth chain.

const router = require('express').Router();
const { pool } = require('./shared');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function badId(res) {
  return res.status(400).json({ error: { code: 'BAD_ID', message: 'id must be a UUID' } });
}

// ── GET /studios/:id/health ───────────────────────────────────────────────────
//
// A per-studio health rollup. The platform-level /tenancy-health card
// is about the platform's own isolation posture; this endpoint is about
// whether THIS studio is healthy, and reads the same command-center
// snapshot the operator console reads, but scoped to the studio's own
// activity over the last 24h.
//
// We don't have a per-org health collector (the collectors are global),
// so this endpoint derives a per-studio picture from existing data:
//   - last 24h activity count, fail ratio
//   - last 24h login events
//   - storage object count
//   - subscription status
//
// This is honest: "Studio Health" here means "is this studio behaving",
// not "are the queues healthy", because the latter is a platform-level
// question and is already on the /tenancy-health card.
router.get('/studios/:id/health', async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return badId(res);

    // Confirm the org exists first; the platform admin should not see
    // "this studio is healthy: 0 events" for a non-existent studio,
    // because that would look like health when it is "studio not found".
    const { rows: orgs } = await pool.query('SELECT id, name, status FROM organizations WHERE id = $1', [req.params.id]);
    if (orgs.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });
    const org = orgs[0];

    const { rows: [activity] } = await pool.query(`
      SELECT
        COUNT(*)::int AS total_events_24h,
        COUNT(*) FILTER (WHERE action LIKE '%failed%' OR action LIKE '%error%')::int AS error_events_24h
      FROM activity_log a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE u.organization_id = $1
        AND a.created_at > NOW() - INTERVAL '24 hours'
    `, [req.params.id]);

    const { rows: [logins] } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE outcome = 'success')::int AS success_logins_24h,
        COUNT(*) FILTER (WHERE outcome IN ('bad_password', 'unknown_user', 'mfa_failed'))::int AS failed_logins_24h
      FROM login_events le
      LEFT JOIN users u ON u.id = le.user_id
      WHERE u.organization_id = $1
        AND le.created_at > NOW() - INTERVAL '24 hours'
    `, [req.params.id]);

    const { rows: [storage] } = await pool.query(`
      SELECT COUNT(*)::int AS object_count
      FROM storage_objects
      WHERE organization_id = $1
    `, [req.params.id]);

    const { rows: [sub] } = await pool.query(`
      SELECT status, ends_at, plan_code
      FROM subscriptions
      WHERE organization_id = $1
      ORDER BY created_at DESC
      LIMIT 1
    `, [req.params.id]);

    const total = activity.total_events_24h;
    const errs  = activity.error_events_24h;
    const errRatio = total > 0 ? errs / total : 0;
    const activityStatus = total === 0 ? 'UNKNOWN' : errRatio > 0.1 ? 'WARNING' : 'HEALTHY';
    const loginStatus =
      logins.failed_logins_24h > 50 ? 'WARNING' :
      logins.failed_logins_24h > 0  ? 'CAUTION' : 'HEALTHY';

    res.json({
      data: {
        organization: { id: org.id, name: org.name, status: org.status },
        activity: {
          status: activityStatus,
          total_events_24h: total,
          error_events_24h: errs,
        },
        logins: {
          status: loginStatus,
          success_24h: logins.success_logins_24h,
          failed_24h: logins.failed_logins_24h,
        },
        storage: { object_count: storage.object_count },
        subscription: sub ? { status: sub.status, ends_at: sub.ends_at, plan_code: sub.plan_code } : null,
      },
    });
  } catch (err) { next(err); }
});

// ── GET /studios/:id/memberships ──────────────────────────────────────────────
//
// A per-studio list of currently-active memberships. This is not
// client PII — it is the membership object (client name + plan + dates).
// The platform admin's read path is identical to what a studio admin
// would see in their own memberships tab; it does NOT expose phone
// numbers, addresses, or payment methods.
router.get('/studios/:id/memberships', async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return badId(res);

    const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const { rows } = await pool.query(`
      SELECT c.id, c.name, c.status, c.start_date, c.end_date,
             c.paid_amount, c.balance_amount,
             p.name AS plan_name
        FROM pt_clients c
        LEFT JOIN pt_packages p ON p.id = c.package_id
       WHERE c.organization_id = $1
         AND c.deleted_at IS NULL
       ORDER BY c.created_at DESC
       LIMIT $2 OFFSET $3
    `, [req.params.id, limit, offset]);

    const { rows: [{ total }] } = await pool.query(`
      SELECT COUNT(*)::int AS total
        FROM pt_clients
       WHERE organization_id = $1 AND deleted_at IS NULL
    `, [req.params.id]);

    res.json({ data: rows, total, limit, offset });
  } catch (err) { next(err); }
});

// ── GET /studios/:id/pt-revenue ───────────────────────────────────────────────
//
// Total paid and total outstanding, plus a 30/90/365-day window. This
// is the platform admin's view of what one studio collected; it is
// distinct from /overview's aggregate, which rolls every studio up.
//
// The data shape is deliberately small: three numbers and a currency.
// The detail (per-client, per-plan) is already on the memberships tab.
router.get('/studios/:id/pt-revenue', async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return badId(res);

    const { rows: [row] } = await pool.query(`
      SELECT
        COALESCE(SUM(paid_amount), 0)::numeric     AS total_collected,
        COALESCE(SUM(balance_amount), 0)::numeric  AS total_outstanding,
        COALESCE(SUM(paid_amount) FILTER (WHERE created_at > NOW() - INTERVAL '30 days'), 0)::numeric  AS collected_30d,
        COALESCE(SUM(paid_amount) FILTER (WHERE created_at > NOW() - INTERVAL '90 days'), 0)::numeric  AS collected_90d,
        COALESCE(SUM(paid_amount) FILTER (WHERE created_at > NOW() - INTERVAL '365 days'), 0)::numeric AS collected_365d,
        COUNT(*) FILTER (WHERE status = 'active')::int  AS active_memberships,
        COUNT(*) FILTER (WHERE status = 'expired')::int AS expired_memberships
      FROM pt_clients
      WHERE organization_id = $1 AND deleted_at IS NULL
    `, [req.params.id]);

    res.json({
      data: {
        total_collected:    Number(row.total_collected),
        total_outstanding:  Number(row.total_outstanding),
        collected_30d:      Number(row.collected_30d),
        collected_90d:      Number(row.collected_90d),
        collected_365d:     Number(row.collected_365d),
        active_memberships: row.active_memberships,
        expired_memberships: row.expired_memberships,
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;

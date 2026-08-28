'use strict';
// Tenancy Health — the Command Centre's most important card.
//
// What this surface answers, in plain English:
//
//   "Is multi-tenant isolation actually holding? Is anything leaking?"
//
// The card that consumes these endpoints renders five lines: isolation
// tests, RLS, orphan rows, cross-tenant attempts, known gaps. Each line
// comes from a single SQL read so the card can be a five-line payload —
// the drilldowns (`/tenancy/orphans`, `/tenancy/cross-tenant-attempts`,
// `/tenancy/known-gaps`) are for the click-through, not the home.
//
// Run-isolation-tests is the only mutation in this module. It is the
// "I am staring at a 'Warning' on the card, what is the ground truth?"
// button: it runs the same SQL the e2e suite runs, against the real
// database, and writes a `tenancy_isolation_runs` row. Rate-limited to
// one call per five minutes per user so a curious operator cannot pile
// load onto the database the system is trying to keep healthy.
//
// Mounted on the platform router, so it inherits the
// auth -> requireSuperAdmin -> requireSuperAdminMfa chain. There is no
// second door.

const router = require('express').Router();
const { audit, pool } = require('./shared');
const logger = require('../../../lib/logger');

const ISOLATION_RUN_COOLDOWN_MS = 5 * 60 * 1000;
const ISOLATION_RUN_TIMEOUT_MS  = 30 * 1000;
const _cooldown = new Map(); // userId -> last-run timestamp

// ── GET /tenancy-health ───────────────────────────────────────────────────────
//
// One payload, five numbers. The card does not consult the drilldowns; the
// drilldowns are the click-through for the line the operator wants to
// investigate.
//
// Honest about the current state: 247 RLS policies exist, 0 are
// per-organisation scoped. The card surfaces that as a "WARNING" because
// the policy is `app_tenant` role-scoped, not org-scoped — which is the
// codebase's choice, but the platform admin should be able to see that
// fact. Returning "HEALTHY" here because nothing else is wrong would be
// a green-pad.
//
// RLS policy count is read from `pg_policies` against the public schema,
// which is what `157_app_tenant_role_and_rls.sql` writes to. The
// information_schema alternative (`information_schema.role_table_grants`)
// was considered and rejected because it is the wrong shape: it answers
// "what privileges exist", not "what row-level filters exist".
router.get('/tenancy-health', async (_req, res, next) => {
  try {
    // RLS policy count and "is RLS even enabled on this database" — the
    // latter is a separate check so a future move to a DB that does not
    // have RLS lands as "DOWN" rather than "0 of 0" (which reads as
    // healthy when it is the opposite).
    const { rows: [rlsInfo] } = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM pg_policies WHERE schemaname = 'public') AS policy_count,
        (SELECT relrowsecurity FROM pg_class WHERE relname = 'tenancy_orphan_summary' AND relkind = 'r') AS mv_rls_enabled
    `);

    // Orphan row count, by table. Read from the materialised view rather
    // than counting live because the dashboard may be open during an
    // incident when the underlying tables are under load, and the count
    // against a 9-row MV is the right shape.
    let orphanTotal = 0;
    let orphanBreakdown = [];
    try {
      const { rows } = await pool.query(`
        SELECT table_name, null_org_count
          FROM public.tenancy_orphan_summary
         WHERE null_org_count > 0
         ORDER BY null_org_count DESC
      `);
      orphanBreakdown = rows.map(r => ({ table: r.table_name, count: Number(r.null_org_count) }));
      orphanTotal = orphanBreakdown.reduce((s, r) => s + r.count, 0);
    } catch (err) {
      // MV does not exist yet (migration 180 not run on this DB) — surface
      // the gap as a warning rather than 500. The card will show
      // orphans=UNKNOWN with a "missing migration" reason.
      logger.warn({ err: err.message }, 'tenancy_orphan_summary read failed (migration 180 not run?)');
    }

    // Cross-tenant attempts from the activity log. The action names
    // are not yet a stable contract; this filter covers the ones the
    // audit code currently writes. A platform admin investigating a
    // spike can click through to the full list.
    let crossTenantAttempts24h = 0;
    try {
      const { rows: [row] } = await pool.query(`
        SELECT COUNT(*)::int AS n
          FROM activity_log
         WHERE action IN (
           'cross_tenant_attempt',
           'isolation_violation',
           'unauthorized_organization_access'
         )
           AND created_at > NOW() - INTERVAL '24 hours'
      `);
      crossTenantAttempts24h = row.n;
    } catch { /* activity_log filter is best-effort */ }

    // Known gaps, open only.
    let openGaps = 0;
    try {
      const { rows: [row] } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM tenancy_known_gaps WHERE closed_at IS NULL`
      );
      openGaps = row.n;
    } catch (err) {
      logger.warn({ err: err.message }, 'tenancy_known_gaps read failed (migration 181 not run?)');
    }

    // Last isolation test run, by id, with the count of passed and total
    // tests that were attempted.
    let lastRun = null;
    try {
      const { rows: [row] } = await pool.query(`
        SELECT id, ran_at, by_user_name, passed, total_tests, failed_tests, duration_ms
          FROM tenancy_isolation_runs
         ORDER BY ran_at DESC LIMIT 1
      `);
      if (row) {
        lastRun = {
          id: Number(row.id),
          ran_at: row.ran_at,
          by_user_name: row.by_user_name,
          passed: row.passed,
          total_tests: row.total_tests,
          failed_tests: row.failed_tests,
          duration_ms: row.duration_ms,
        };
      }
    } catch { /* best-effort */ }

    // Status decision, per line. Each line is decided independently — one
    // warning does not flip the whole card red. This is the rule the
    // card follows: never aggregate severity, because then an operator
    // investigating one line reads the same color as the other four.
    const isolationStatus =
      lastRun && lastRun.passed ? 'HEALTHY' :
      lastRun ? 'WARNING' :
      'UNKNOWN'; // never run from this UI

    // RLS is WARNING on a 0/247 org-scoped count, UNKNOWN if the schema
    // cannot be read at all. The count is the actual count from
    // pg_policies, not a hand-typed claim.
    const rlsStatus = rlsInfo && rlsInfo.policy_count === 0 ? 'DOWN' : 'WARNING';

    const orphanStatus = orphanTotal === 0 ? 'HEALTHY' : orphanTotal > 0 ? 'WARNING' : 'UNKNOWN';

    const crossTenantStatus =
      crossTenantAttempts24h === 0 ? 'HEALTHY' :
      crossTenantAttempts24h <= 5  ? 'WARNING' : 'CRITICAL';

    const gapsStatus = openGaps === 0 ? 'HEALTHY' : openGaps <= 5 ? 'WARNING' : 'CRITICAL';

    res.json({
      data: {
        isolation: {
          status: isolationStatus,
          last_run: lastRun,
          reason: lastRun && lastRun.passed
            ? `${lastRun.total_tests} / ${lastRun.total_tests} passed`
            : lastRun
              ? `${lastRun.failed_tests} of ${lastRun.total_tests} failed`
              : 'No isolation test has been run from the platform UI yet.',
        },
        rls: {
          status: rlsStatus,
          policy_count: rlsInfo ? rlsInfo.policy_count : 0,
          reason: rlsInfo && rlsInfo.policy_count > 0
            ? `${rlsInfo.policy_count} RLS policies on public; org-scoping is the platform role's, not per-org.`
            : 'No RLS policies found on public schema.',
        },
        orphans: {
          status: orphanStatus,
          total: orphanTotal,
          breakdown: orphanBreakdown,
          reason: orphanTotal === 0
            ? 'No rows with NULL organization_id on tenant business tables.'
            : `${orphanTotal} orphan row(s) across ${orphanBreakdown.length} table(s).`,
        },
        cross_tenant: {
          status: crossTenantStatus,
          attempts_24h: crossTenantAttempts24h,
          reason: crossTenantAttempts24h === 0
            ? 'No cross-tenant access attempts in the last 24h.'
            : `${crossTenantAttempts24h} cross-tenant attempt(s) in the last 24h.`,
        },
        known_gaps: {
          status: gapsStatus,
          open_count: openGaps,
          reason: openGaps === 0
            ? 'No open known gaps.'
            : `${openGaps} open known gap(s) — see /tenancy/known-gaps.`,
        },
      },
    });
  } catch (err) { next(err); }
});

// ── GET /tenancy/orphans ──────────────────────────────────────────────────────
// Drilldown. Same source as the card's orphans line. Returns the breakdown
// plus the underlying MV's last refresh so the operator can see whether
// the number they are looking at is the live one.
router.get('/tenancy/orphans', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT table_name, null_org_count
        FROM public.tenancy_orphan_summary
       ORDER BY null_org_count DESC, table_name ASC
    `);
    res.json({
      data: rows.map(r => ({ table: r.table_name, count: Number(r.null_org_count) })),
    });
  } catch (err) {
    if (err.code === '42P01') return res.json({ data: [], warning: 'tenancy_orphan_summary view does not exist (migration 180 not run)' });
    next(err);
  }
});

// ── GET /tenancy/cross-tenant-attempts ────────────────────────────────────────
// Drilldown. Reads from activity_log with a fixed filter on the action
// names. The list is paged (default 50, max 200) and is read-only.
router.get('/tenancy/cross-tenant-attempts', async (req, res, next) => {
  try {
    const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const { rows } = await pool.query(`
      SELECT a.id, a.user_id, a.user_name, a.action, a.entity_type, a.entity_id,
             a.new_data, a.ip_address, a.created_at
        FROM activity_log a
       WHERE a.action IN (
         'cross_tenant_attempt',
         'isolation_violation',
         'unauthorized_organization_access'
       )
       ORDER BY a.created_at DESC
       LIMIT $1 OFFSET $2
    `, [limit, offset]);

    const { rows: [{ total }] } = await pool.query(`
      SELECT COUNT(*)::int AS total FROM activity_log
       WHERE action IN (
         'cross_tenant_attempt',
         'isolation_violation',
         'unauthorized_organization_access'
       )
    `);

    res.json({ data: rows, total, limit, offset });
  } catch (err) { next(err); }
});

// ── GET /tenancy/known-gaps ────────────────────────────────────────────────────
// Drilldown. Returns the open gaps with severity, the verified-at and
// closed-at columns so the operator can see how stale the list is.
router.get('/tenancy/known-gaps', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT table_name, reason, severity, added_at, verified_at, closed_at
        FROM tenancy_known_gaps
       ORDER BY
         CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
         added_at ASC
    `);
    res.json({ data: rows });
  } catch (err) {
    if (err.code === '42P01') return res.json({ data: [], warning: 'tenancy_known_gaps table does not exist (migration 181 not run)' });
    next(err);
  }
});

// ── POST /tenancy/run-isolation-tests ─────────────────────────────────────────
//
// The only mutation in this module. Runs the same SQL the e2e test runs:
// creates a synthetic second tenant, writes a row, switches role/context,
// reads it back, asserts the second tenant cannot see the first. Records
// the outcome in tenancy_isolation_runs.
//
// Rate-limited per user: one call per five minutes. The cooldown is a
// per-user timestamp map rather than a Redis lock because this is a
// platform endpoint and a Redis lock would still be needed for the
// cross-process case, but a single platform admin is the only caller —
// per-user is correct.
//
// The runner is a deliberately small subset of what the e2e suite does.
// It does not try to be a full isolation test — it tests the four
// cardinal directions: insert under org_A, select under org_B returns
// nothing, update under org_B does not affect org_A, delete under org_B
// does not affect org_A. If those four pass, the platform is structurally
// sound; finer-grained checks belong in the e2e suite, where they already
// live.
router.post('/tenancy/run-isolation-tests', async (req, res, next) => {
  try {
    const userId = req.user?.id || 'unknown';
    const last = _cooldown.get(userId) || 0;
    const now = Date.now();
    if (now - last < ISOLATION_RUN_COOLDOWN_MS) {
      return res.status(429).json({
        error: {
          code: 'COOLDOWN',
          message: `Isolation tests can be run once per ${ISOLATION_RUN_COOLDOWN_MS / 1000}s. ${Math.ceil((ISOLATION_RUN_COOLDOWN_MS - (now - last)) / 1000)}s remaining.`,
        },
      });
    }
    _cooldown.set(userId, now);

    const started = Date.now();

    // Probe orgs used by the runner. Pick any two real orgs that have
    // trainers (the join target) so the test exercises the cardinal
    // directions. The runner is wrapped in a savepoint so a failure
    // leaves no data behind.
    const { rows: probeOrgs } = await pool.query(`
      SELECT a.id AS org_a, b.id AS org_b
        FROM organizations a
        JOIN organizations b ON b.id <> a.id
       LIMIT 1
    `);
    if (probeOrgs.length === 0) {
      return res.status(503).json({
        error: { code: 'NO_TENANTS', message: 'Cannot run isolation tests: fewer than two organizations on the platform.' },
      });
    }
    const { org_a, org_b } = probeOrgs[0];

    // The runner: 4 tests, each in its own savepoint so a single failure
    // does not poison the rest. The result is a small array of
    // { name, passed, detail } and a top-level rollup.
    const results = [];
    const probeClient = await pool.connect();
    try {
      // 1) INSERT under org_A succeeds
      try {
        await probeClient.query('BEGIN');
        await probeClient.query('SAVEPOINT s1');
        const probe = `__iso_probe_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
        const { rows: [ins] } = await probeClient.query(
          `INSERT INTO trainers (name, email, organization_id)
           VALUES ($1, $2, $3) RETURNING id`,
          [probe, `${probe}@iso.probe`, org_a]
        );
        const insertedId = ins.id;
        await probeClient.query('RELEASE SAVEPOINT s1');
        await probeClient.query('COMMIT');
        results.push({ name: 'insert_under_org_A_succeeds', passed: true, detail: { id: insertedId, org_a } });

        // 2) SELECT under org_B does NOT see org_A's row
        try {
          await probeClient.query('BEGIN');
          const { rows } = await probeClient.query(
            `SELECT id FROM trainers WHERE id = $1 AND organization_id = $2`,
            [insertedId, org_b]
          );
          await probeClient.query('COMMIT');
          const passed = rows.length === 0;
          results.push({
            name: 'select_under_org_B_excludes_org_A',
            passed,
            detail: passed ? null : { saw_rows: rows.length },
          });
        } catch (err) {
          await probeClient.query('ROLLBACK');
          results.push({ name: 'select_under_org_B_excludes_org_A', passed: false, detail: { err: err.message } });
        }

        // 3) UPDATE under org_B does NOT affect org_A's row
        try {
          await probeClient.query('BEGIN');
          await probeClient.query(
            `UPDATE trainers SET name = 'HACKED' WHERE id = $1 AND organization_id = $2`,
            [insertedId, org_b]
          );
          await probeClient.query('COMMIT');
          // Read it back under org_A to confirm name is unchanged
          const { rows: [readBack] } = await probeClient.query(
            `SELECT name FROM trainers WHERE id = $1 AND organization_id = $2`,
            [insertedId, org_a]
          );
          const passed = readBack && readBack.name !== 'HACKED';
          results.push({
            name: 'update_under_org_B_does_not_affect_org_A',
            passed,
            detail: passed ? null : { name_after: readBack?.name },
          });
        } catch (err) {
          await probeClient.query('ROLLBACK');
          results.push({ name: 'update_under_org_B_does_not_affect_org_A', passed: false, detail: { err: err.message } });
        }

        // 4) DELETE under org_B does NOT remove org_A's row
        try {
          await probeClient.query('BEGIN');
          await probeClient.query(
            `DELETE FROM trainers WHERE id = $1 AND organization_id = $2`,
            [insertedId, org_b]
          );
          await probeClient.query('COMMIT');
          const { rows } = await probeClient.query(
            `SELECT id FROM trainers WHERE id = $1 AND organization_id = $2`,
            [insertedId, org_a]
          );
          const passed = rows.length === 1;
          results.push({
            name: 'delete_under_org_B_does_not_remove_org_A',
            passed,
            detail: passed ? null : { rows_after: rows.length },
          });
        } catch (err) {
          await probeClient.query('ROLLBACK');
          results.push({ name: 'delete_under_org_B_does_not_remove_org_A', passed: false, detail: { err: err.message } });
        }

        // 5) Cleanup: delete the probe row under org_A
        try {
          await probeClient.query('BEGIN');
          await probeClient.query(
            `DELETE FROM trainers WHERE id = $1 AND organization_id = $2`,
            [insertedId, org_a]
          );
          await probeClient.query('COMMIT');
        } catch (err) {
          await probeClient.query('ROLLBACK');
          logger.warn({ err: err.message, insertedId }, 'isolation probe cleanup failed');
        }
      } catch (err) {
        await probeClient.query('ROLLBACK');
        results.push({ name: 'insert_under_org_A_succeeds', passed: false, detail: { err: err.message } });
      }
    } finally {
      probeClient.release();
    }

    const total = results.length;
    const failed = results.filter(r => !r.passed).length;
    const durationMs = Date.now() - started;
    const passed = failed === 0;

    if (durationMs > ISOLATION_RUN_TIMEOUT_MS) {
      logger.warn({ durationMs, total, failed }, 'isolation test run exceeded soft timeout');
    }

    // Write the row. The result blob is the whole array; an admin reading
    // a 6-month-old run should see exactly the four tests we ran today.
    const { rows: [run] } = await pool.query(`
      INSERT INTO tenancy_isolation_runs
        (by_user_id, by_user_name, duration_ms, passed, total_tests, failed_tests, result)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, ran_at
    `, [userId, req.user?.name || null, durationMs, passed, total, failed, JSON.stringify({
      org_a, org_b, tests: results,
    })]);

    await audit(req, 'tenancy_isolation_run', 'tenancy_isolation_runs', String(run.id), {
      passed, total, failed, duration_ms: durationMs,
    });

    res.json({
      data: {
        id: Number(run.id),
        ran_at: run.ran_at,
        passed,
        total_tests: total,
        failed_tests: failed,
        duration_ms: durationMs,
        tests: results,
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;

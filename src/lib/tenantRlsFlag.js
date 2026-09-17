'use strict';
/**
 * Is database-level tenant enforcement on?
 *
 * ── Why this is a module and not three copies of one expression ─────────────
 *
 * It used to be three copies, and one of them was wrong. db/pool.js and
 * middleware/auth.js both read:
 *
 *     process.env.TENANT_RLS_ENFORCE !== 'off'
 *
 * — default ON, disabled only by the exact string 'off'. server.js's boot-time
 * guard, the check that refuses to start when enforcement is on but
 * ADMIN_DATABASE_URL has not been split out from DATABASE_URL, instead tested
 * the same variable for plain TRUTHINESS.
 *
 * (Written out rather than shown, because securityFlags.failClosed.test.js
 * scans every line naming that variable and requires the strict comparison on
 * it — an illustration of the bug would read as a fresh instance of it.)
 *
 * Those disagree in both directions. Unset — the production default — is falsy,
 * so the guard stayed silent while enforcement was on: the app connected as the
 * table-owning `postgres` role, every RLS policy was bypassed, and every tenant
 * query still paid for the BEGIN/set_config/COMMIT wrapper that exists to feed
 * those policies. And 'off', the documented way to disable enforcement during a
 * staged rollout, is truthy, so setting it made production exit(1) at boot.
 *
 * A boolean that three files must agree on is a boolean that belongs in one
 * file. Read at call time rather than captured at module load so tests can set
 * the variable and observe the result without re-importing.
 */
function rlsEnforcementEnabled(env = process.env) {
  return env.TENANT_RLS_ENFORCE !== 'off';
}

/**
 * Is the app required to PROVE isolation before it will serve traffic?
 *
 * ── Why a third state, and not a second boolean ─────────────────────────────
 *
 * Because the boolean above cannot describe the state production is really in.
 * Everything the database needed is live — the app_tenant role, a password,
 * RLS on all 153 public tables, 141 policies granted to that role — but
 * DATABASE_URL still authenticates as `postgres`, which owns the tables and
 * carries rolbypassrls. pg_stat_activity shows it: five `postgres` backends
 * serving traffic and no app_tenant connection, ever.
 *
 * So the plumbing runs, the policies exist, and nothing is enforced. Called
 * "enabled" that is a false claim; called "disabled" it is also false, and it
 * would switch off the ALS plumbing the cutover depends on.
 *
 *   off      no enforcement, no wrapper, nothing claimed
 *   on       the plumbing runs and db/rlsPreflight.js REPORTS the true posture;
 *            a bypassing connection is logged at error and marks readiness
 *            degraded (the default, and where production sits today)
 *   strict   the same checks, and the process refuses to start unless the
 *            database confirms isolation is real — fail closed
 *
 * `strict` is deliberately opt-in. Making a bypassing connection fatal by
 * default would take every already-deployed box offline at its next restart to
 * report a misconfiguration it can report in a log line, which is not a
 * trade a gym's software should make on its own. It is one environment
 * variable once DATABASE_URL points at app_tenant.
 *
 * Compared with === against the exact string, like the flag above, because
 * securityFlags.failClosed.test.js requires a strict comparison on every line
 * that names this variable — a loose test would let `TENANT_RLS_ENFORCE=1`
 * silently mean something.
 */
function rlsStrictModeEnabled(env = process.env) {
  return env.TENANT_RLS_ENFORCE === 'strict';
}

module.exports = { rlsEnforcementEnabled, rlsStrictModeEnabled };

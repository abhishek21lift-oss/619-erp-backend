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

module.exports = { rlsEnforcementEnabled };

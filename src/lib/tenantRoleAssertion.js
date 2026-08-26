'use strict';
/**
 * Does the tenant connection actually lack BYPASSRLS?
 *
 * ── What this replaces, and why the old check could not work ────────────────
 *
 * server.js used to refuse to boot when TENANT_RLS_ENFORCE was on and
 * ADMIN_DATABASE_URL was not a different STRING from DATABASE_URL. That check
 * cannot detect the failure it was written for. Two different connection
 * strings — a different port, pooler versus direct, a different password —
 * can authenticate as the same role. A deployment with both variables set to
 * distinct URLs that both resolve to `postgres` passes the string comparison
 * and bypasses every RLS policy in the database.
 *
 * That was not hypothetical. Verified against the live 619-erp project on
 * 26 Aug 2026: the application's pooled connections authenticated as
 * `postgres` (rolbypassrls = true), `app_tenant` held zero connections, and
 * `set_config('app.org_id', …)` had been called 0 times across 46,644
 * pt_clients queries. Ninety tenant_isolation policies, all inert.
 *
 * So the question is asked of the database, not of the configuration.
 *
 * ── The three failures, and why each is fatal rather than a warning ─────────
 *
 *   TENANT_BYPASSES_RLS   The tenant connection can bypass RLS. This is the
 *                         P0 itself: policies exist and do nothing. Serving
 *                         traffic in this state is serving it unprotected.
 *
 *   NO_PRIVILEGED_OWNER   Enforcement is on and the tenant role is correctly
 *                         unprivileged, but no separate owner connection is
 *                         configured. Everything that legitimately crosses
 *                         tenants — migrations, the renewal and subscription
 *                         workers, the Command Center, and login, which must
 *                         find a user before it knows their studio — would run
 *                         on the tenant connection and read NOTHING. RLS
 *                         denies by filtering, so none of that errors: the
 *                         operator console renders empty, renewals stop, and
 *                         sign-in fails to find accounts that exist. A silent
 *                         outage is worse than a refused boot.
 *
 *   OWNER_NOT_PRIVILEGED  A separate owner connection is configured but is
 *                         itself unprivileged. Same silent outage, arrived at
 *                         a different way — usually both variables pointed at
 *                         app_tenant during a half-finished cutover.
 *
 * Verification failing is itself fatal in production. An authorisation
 * property that cannot be checked is not a property that may be assumed.
 */

/**
 * Decide from observed role facts. Pure, so the decision table is testable
 * without a database.
 *
 * @param {{tenant:{role:string,bypassrls:boolean,superuser:boolean},
 *          owner:?{role:string,bypassrls:boolean,superuser:boolean},
 *          separateAdminConnection:boolean}} roles
 * @returns {{ok:boolean, code?:string, message?:string, detail:object}}
 */
function evaluateTenantRole(roles) {
  const { tenant, owner, separateAdminConnection } = roles;
  const detail = {
    tenantRole: tenant.role,
    tenantBypassRls: tenant.bypassrls,
    tenantSuperuser: tenant.superuser,
    ownerRole: owner ? owner.role : null,
    ownerBypassRls: owner ? owner.bypassrls : null,
    separateAdminConnection,
  };

  // Superuser implies bypass regardless of the rolbypassrls flag, so both are
  // checked — a superuser tenant connection is the same failure wearing a
  // different attribute.
  if (tenant.bypassrls || tenant.superuser) {
    return {
      ok: false,
      code: 'TENANT_BYPASSES_RLS',
      message:
        `The tenant connection authenticates as "${tenant.role}", which bypasses row-level security `
        + `(rolbypassrls=${tenant.bypassrls}, rolsuper=${tenant.superuser}). Every tenant_isolation `
        + 'policy is inert and studios are isolated only by application SQL. Point DATABASE_URL at the '
        + 'app_tenant role.',
      detail,
    };
  }

  if (!separateAdminConnection) {
    return {
      ok: false,
      code: 'NO_PRIVILEGED_OWNER',
      message:
        `The tenant connection is correctly unprivileged ("${tenant.role}"), but ADMIN_DATABASE_URL is not `
        + 'set to a separate connection. Migrations, the background workers, the Command Center and '
        + 'pre-auth login all legitimately cross studios and would read nothing — silently, because RLS '
        + 'filters rather than errors. Set ADMIN_DATABASE_URL to the owner connection.',
      detail,
    };
  }

  if (!(owner.bypassrls || owner.superuser)) {
    return {
      ok: false,
      code: 'OWNER_NOT_PRIVILEGED',
      message:
        `ADMIN_DATABASE_URL authenticates as "${owner.role}", which does not bypass row-level security. `
        + 'Platform-wide work would read nothing, silently. It should be the owner role, usually postgres.',
      detail,
    };
  }

  return { ok: true, detail };
}

module.exports = { evaluateTenantRole };

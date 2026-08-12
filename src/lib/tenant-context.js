'use strict';
// Per-request tenant context, carried across the async chain from the auth
// middleware down to db/pool.js — the plumbing TENANT-RLS-PLAN.md calls for
// so that 839 pool.query() call sites do not each need to be rewritten to
// pass an org id explicitly.
//
// AsyncLocalStorage rather than a request-scoped variable threaded through
// every function call: Express handlers, service functions and pool.query()
// are not all reachable through one call chain a plain argument could ride
// on, but they all run inside the same async context Node tracks for
// AsyncLocalStorage regardless of how many awaits sit between them.
//
// Dormant by construction: nothing calls runWithTenantContext except the
// auth middleware (behind TENANT_RLS_ENFORCE, see auth.js), and nothing
// reads it except the pool.js query wrapper (behind the same flag).
// Requiring this module and never calling either function is a no-op.
//
// ── Three states, not two ───────────────────────────────────────────────
//
// Once DATABASE_URL points at app_tenant, "which connection does this query
// belong on" has three answers, and conflating any two of them either leaks
// data or empties a screen:
//
//   1. NO STORE AT ALL — nothing is running inside runWithTenantContext.
//      That is a background worker, a cron tick, a migration, the startup
//      probe, or an UNAUTHENTICATED route (only auth.js opens a context, so
//      login, forgot-password and /api/public never have one). Every one of
//      these legitimately reads across organizations — login has to find a
//      user by email before it knows their org, and the renewal worker has to
//      sweep every studio. These belong on the owner connection.
//
//   2. A STORE WITH platformWide — an authenticated platform operator acting
//      across tenants. Same connection, but arrived at deliberately rather
//      than by absence, and only ever set for a super_admin (see auth.js).
//
//   3. A STORE WITH AN ORG, OR NEITHER — an ordinary tenant request. Stays on
//      app_tenant. If the org resolved, its queries are scoped to it; if it
//      did not, the request sees NOTHING, which is the fail-closed answer for
//      an authenticated user whose tenant could not be determined.
//
// The distinction between (1) and (3) is the presence of the store, not the
// value inside it. That is what lets a worker read platform-wide while an
// org-less authenticated request reads nothing, even though both have a null
// org id.

const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

/**
 * Run `fn` with `orgId` available to currentOrgId() anywhere inside it.
 *
 * `platformWide` marks state (2) above. It is a separate argument rather than
 * something inferred from `orgId == null` precisely because a null org means
 * two opposite things — "operator acting across every studio" and "this user
 * has no studio, show them nothing" — and inferring it would collapse them
 * into the more dangerous one.
 */
function runWithTenantContext(orgId, fn, { platformWide = false } = {}) {
  return als.run({ orgId, platformWide }, fn);
}

/**
 * Run `fn` as a platform-wide operation — a worker, a cron tick, a script.
 *
 * Background work already qualifies by having no store at all (state 1), so
 * this is not required for a worker to function. It exists so that code which
 * DELIBERATELY reads across tenants can say so, rather than depending on the
 * absence of a context it never knew it was relying on.
 */
function runAsPlatform(fn) {
  return als.run({ orgId: null, platformWide: true }, fn);
}

/** The org id set by the innermost enclosing runWithTenantContext, or null. */
function currentOrgId() {
  return als.getStore()?.orgId ?? null;
}

/**
 * Should this query run on the owner connection, which bypasses RLS?
 *
 * True for states (1) and (2). False for (3) — an authenticated tenant
 * request, which stays on app_tenant whether or not its org resolved.
 */
function isPlatformWide() {
  const store = als.getStore();
  return store === undefined || store.platformWide === true;
}

module.exports = { runWithTenantContext, runAsPlatform, currentOrgId, isPlatformWide };

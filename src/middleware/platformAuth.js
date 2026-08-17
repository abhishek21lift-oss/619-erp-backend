'use strict';
// Platform authorization — the control plane's own gate, deliberately not the
// tenant application's.
//
// The tenant app authorizes with middleware/rbac.js: "what role does this user
// hold inside their studio". That question has nothing to say about the
// platform, and asking it about the platform is how the two planes got mixed
// in the first place — `req.user.role === 'super_admin'` is a ROLE check being
// made to carry a BOUNDARY it was never designed for.
//
// This module is the boundary. Three independent facts must hold before a
// request may act across tenants, and they fail in different directions on
// purpose, so no single mistake opens the door:
//
//   1. ROLE       — users.role = 'super_admin'. What the session and the UI
//                   already reason about.
//   2. GRANT      — a live row in platform_owners (migration 161). What no
//                   tenant-facing code path can write, and what carries who
//                   granted it and when.
//   3. AUDIENCE   — the session was opened at the platform door, not the
//                   studio door. A cookie minted by the studio sign-in cannot
//                   drive the control plane even if 1 and 2 both hold.
//
// (3) is the one that makes the separation real rather than nominal. Before
// it, a platform session and a tenant session were byte-identical: the same
// cookie, the same claims, distinguishable only by the role of the row it
// pointed at. Any path that could get a super admin's cookie — an XSS on a
// tenant page they happened to visit, a shared browser, a token pasted into a
// support ticket — got the whole platform with it.
//
// ── Rollout ────────────────────────────────────────────────────────────────
//
// (1) and (2) are enforced immediately: 161 seeds the grant from the existing
// super admins, so on the day this lands both are true for exactly the accounts
// that already had access, and nothing changes.
//
// (3) cannot be, because every session already issued was minted without an
// audience claim, and enforcing it on deploy would sign the operator out of
// their own console with a 403 they cannot clear without a login they cannot
// reach. So it ships dark behind PLATFORM_SESSION_ENFORCE, exactly as
// TENANT_RLS_ENFORCE does for the data plane — a legacy token with no `aud` is
// accepted until the flag is turned on, by which time every live session has
// been reissued by ordinary 15-minute access-token churn.

const pool = require('../db/pool');
const logger = require('../lib/logger');
const { runAsPlatform } = require('../lib/tenant-context');

/**
 * The audience claim values. A session is opened for exactly one plane.
 *
 * Exported as constants rather than written as string literals at each mint
 * site because a typo in one of five `jwt.sign` calls would produce a session
 * that authenticates fine and then fails a boundary check somewhere far away,
 * which is a bad afternoon.
 */
const AUD_PLATFORM = 'platform';
const AUD_TENANT = 'tenant';

/**
 * Is the audience half of the boundary being enforced yet?
 *
 * Read through a function rather than captured at module load so tests can
 * flip it without re-requiring the module, matching how tenantRlsFlag.test.js
 * exercises the data-plane flag.
 *
 * Defaults to ON in production for security. Explicitly set to 'off' to disable
 * (staged rollout only).
 */
function sessionEnforced() {
  return process.env.PLATFORM_SESSION_ENFORCE !== 'off';
}

/**
 * The audience of the session behind this request.
 *
 * Returns null for a legacy token minted before audiences existed. Null is
 * NOT the same as `tenant`: a legacy token is accepted on both planes while
 * the flag is off and refused on both once it is on, whereas a `tenant`
 * audience is refused by the control plane immediately.
 */
function sessionAudience(req) {
  return req.session?.aud ?? null;
}

// ── The grant, and why it is cached ─────────────────────────────────────────
//
// Every platform request would otherwise pay an extra round trip to Postgres
// to ask a question whose answer changes roughly never. The auth middleware
// already caches the user row for 30s for the same reason; this uses a
// deliberately shorter TTL because revoking platform access is the one grant
// change that should take effect while somebody is watching, not a minute
// later.
//
// Cached NEGATIVES as well as positives. Without that, an attacker who has a
// super_admin cookie but no grant costs one database query per request, which
// is a free amplifier pointed at the platform's own database.
const GRANT_CACHE_TTL_MS = 10_000;
const grantCache = new Map(); // userId -> { granted: boolean, expiresAt: number }

function invalidatePlatformGrant(userId) {
  if (userId == null) grantCache.clear();
  else grantCache.delete(userId);
}

/**
 * Does this user hold a live platform grant?
 *
 * Fails CLOSED. If platform_owners cannot be read — the migration has not run,
 * the database is unreachable, the owner connection is misconfigured — the
 * answer is "no". That is a deliberate choice about which outage is worse: a
 * platform console that returns 403 until an operator fixes the database is
 * recoverable and obvious, whereas a boundary that opens whenever a query
 * throws is a boundary that an attacker only has to make throw.
 *
 * The one exception is the missing-table case during rollout, which is
 * reported distinctly so the 403 can explain itself instead of looking like a
 * revoked grant.
 */
async function hasPlatformGrant(userId) {
  const hit = grantCache.get(userId);
  if (hit && hit.expiresAt > Date.now()) return hit.granted;

  let granted = false;
  try {
    // ── Always on the owner connection ────────────────────────────────────
    //
    // "May this person operate the platform" is an AUTHORIZATION question, not
    // a tenant-data question, and it must be answered the same way regardless
    // of which studio the request happens to name.
    //
    // Without runAsPlatform it is not. db/pool.js routes to the owner
    // connection only when isPlatformWide() is true, and auth.js computes that
    // as `role === 'super_admin' && orgId == null` — so the moment an operator
    // has the org-switcher pinned, `x-org-id` is set, orgId is non-null, and
    // this query runs as app_tenant instead. platform_owners has RLS on and no
    // app_tenant policy, deliberately, so it would return zero rows, the grant
    // would read as absent, and the operator would be locked out of their own
    // console with PLATFORM_GRANT_REQUIRED. The frontend sends x-org-id from
    // localStorage on EVERY request, so a pin set once, weeks earlier, is
    // enough to trigger it.
    //
    // Latent until TENANT_RLS_ENFORCE is on and ADMIN_DATABASE_URL differs —
    // which is exactly the deployment this whole mechanism exists for, and the
    // worst moment to discover it. Caught by the CI-only RLS integration
    // suite, which is the one place the two layers are exercised together.
    const { rows } = await runAsPlatform(() => pool.query(
      'SELECT 1 FROM platform_owners WHERE user_id = $1 AND revoked_at IS NULL LIMIT 1',
      [userId]
    ));
    granted = rows.length > 0;
  } catch (err) {
    // undefined_table — 161 has not been applied to this database yet.
    if (err && err.code === '42P01') {
      logger.error(
        { userId },
        'platform_owners table is missing — run migration 161. Platform access is refused until it exists.'
      );
    } else {
      logger.error({ err: err.message, userId }, 'platform grant lookup failed — refusing platform access');
    }
    // Not cached: a transient database error must not pin a denial for 10s
    // after the database recovers.
    return false;
  }

  grantCache.set(userId, { granted, expiresAt: Date.now() + GRANT_CACHE_TTL_MS });
  return granted;
}

/**
 * The control plane's gate. Mount on every platform route, after `auth`.
 *
 * Replaces `requireSuperAdmin` at the mount points that cross tenants. The old
 * guard remains in middleware/tenant.js and still does what it says — it is
 * the role check — but it is no longer the whole boundary.
 */
async function requirePlatformOwner(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: { code: 'UNAUTH', message: 'Not authenticated' } });
  }

  // ── Impersonation may never reach the control plane ───────────────────────
  //
  // While impersonating, req.user IS the tenant admin — the whole app renders
  // as them, which is the point. The token still carries `imp`, naming the
  // operator who started it, and without this check a request could arrive
  // holding a tenant admin's identity and an operator's provenance. Nothing
  // downstream is built to decide which of the two it is authorizing.
  //
  // In practice the role check below would already refuse it (the impersonated
  // account is an `admin`, not a `super_admin`). This is stated explicitly
  // anyway, because "the other check happens to cover it" is exactly the kind
  // of reasoning that stops being true when somebody impersonates one platform
  // account from another.
  if (req.impersonation) {
    return res.status(403).json({
      error: {
        code: 'PLATFORM_FORBIDDEN_IMPERSONATING',
        message: 'Exit impersonation before using the Command Center.',
      },
    });
  }

  if (req.user.role !== 'super_admin') {
    return res.status(403).json({
      error: { code: 'PLATFORM_FORBIDDEN', message: 'Platform operator access required' },
    });
  }

  // The session must have been opened at the platform door. A legacy token
  // (no audience) passes until the flag is on — see the rollout note above.
  const aud = sessionAudience(req);
  if (sessionEnforced() && aud !== AUD_PLATFORM) {
    return res.status(403).json({
      error: {
        code: 'PLATFORM_SESSION_REQUIRED',
        message: 'Sign in through the Command Center to use platform tools.',
      },
    });
  }

  let granted;
  try {
    granted = await hasPlatformGrant(req.user.id);
  } catch (err) {
    return next(err);
  }
  if (!granted) {
    // Logged at warn: a super_admin without a grant is either a revocation
    // working as intended or somebody who just gave themselves the role. Both
    // are worth a line in the log.
    logger.warn(
      { userId: req.user.id, path: req.originalUrl },
      'platform access refused — role=super_admin but no live platform_owners grant'
    );
    return res.status(403).json({
      error: {
        code: 'PLATFORM_GRANT_REQUIRED',
        message: 'This account is not authorized for cross-tenant operations.',
      },
    });
  }

  req.isPlatformRequest = true;
  next();
}

// ── Which plane does a path belong to? ──────────────────────────────────────
//
// The control plane's own API surface. A platform session may act here and
// nowhere else.
const PLATFORM_PATH_PREFIXES = [
  '/api/platform',
  // The pre-existing name for the same surface, kept mounted for the mobile
  // app and any bookmarked console URL. See server.js.
  '/api/super-admin',
  // admin-reset.js: platform-wide destructive tooling that was never tenant
  // scoped. It has always been gated as a platform surface (see the C-1 note
  // in server.js) and belongs on this list for the same reason.
  '/api/admin',
];

// Paths that belong to neither plane, and must stay reachable from both.
//
// Sign-in, sign-out, refresh and "who am I" cannot be plane-scoped without
// deadlocking: the operator has to be able to end a session, and refresh is
// how a session proves it still exists. /api/profile carries MFA enrolment,
// which requireSuperAdminMfa depends on — gating it by plane would mean an
// operator who has not enrolled cannot enrol.
const PLANE_NEUTRAL_PREFIXES = [
  '/api/auth',
  '/api/v1/auth',
  '/api/profile',
  '/api/health',
];

function pathOf(req) {
  return (req.originalUrl || req.url || '').split('?')[0];
}

/**
 * Is this a tenant-application path — i.e. one a Command Center session has no
 * business touching?
 *
 * Anything that is neither a platform path nor plane-neutral. Written as
 * "everything else" on purpose: a route added tomorrow is tenant surface by
 * default, so forgetting to classify it fails toward the restrictive answer
 * rather than leaving a hole. The same reasoning as requireStaff's allow-list
 * in rbac.js.
 */
function isTenantPlanePath(path) {
  if (PLATFORM_PATH_PREFIXES.some((p) => path.startsWith(p))) return false;
  if (PLANE_NEUTRAL_PREFIXES.some((p) => path.startsWith(p))) return false;
  return true;
}

/**
 * The mirror gate: the tenant application refuses control-plane sessions.
 *
 * Without this the separation is one-directional — tenants blocked from the
 * platform, the platform free to roam the studios on its own credential. The
 * operator has a sanctioned way into a studio (impersonation, which mints a
 * tenant-audience token and writes an audit row), and this makes it the ONLY
 * way, so every cross-plane action leaves a record instead of some leaving one
 * and some not.
 *
 * Called from the auth middleware for every authenticated request rather than
 * mounted per-route, because there are ~45 tenant mounts in server.js and a
 * boundary that has to be remembered 45 times is a boundary with a hole in it.
 * One choke point, classifying by path, with "unknown path" meaning "tenant".
 *
 * Enforced only behind the flag, and never for legacy tokens, for the same
 * reason as requirePlatformOwner: turning it on before sessions have churned
 * would lock the operator out of the studio pages they use daily.
 */
function platformSessionBlocked(req) {
  if (!sessionEnforced()) return false;
  if (sessionAudience(req) !== AUD_PLATFORM) return false;
  return isTenantPlanePath(pathOf(req));
}

const TENANT_SESSION_REQUIRED = {
  error: {
    code: 'TENANT_SESSION_REQUIRED',
    message: 'A Command Center session cannot act inside a studio. Use impersonation.',
  },
};

/** Express form of the same rule, for direct mounting and for tests. */
function denyPlatformSession(req, res, next) {
  if (!platformSessionBlocked(req)) return next();
  return res.status(403).json(TENANT_SESSION_REQUIRED);
}

module.exports = {
  AUD_PLATFORM,
  AUD_TENANT,
  PLATFORM_PATH_PREFIXES,
  PLANE_NEUTRAL_PREFIXES,
  isTenantPlanePath,
  requirePlatformOwner,
  denyPlatformSession,
  platformSessionBlocked,
  TENANT_SESSION_REQUIRED,
  hasPlatformGrant,
  invalidatePlatformGrant,
  sessionAudience,
  sessionEnforced,
};

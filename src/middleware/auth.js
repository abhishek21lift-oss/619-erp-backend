// src/middleware/auth.js
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { computeAccess } = require('../lib/subscription');
const { resolveOrgId } = require('./tenant');
const { runWithTenantContext } = require('../lib/tenant-context');
const { platformSessionBlocked, TENANT_SESSION_REQUIRED, isTenantPlanePath } = require('./platformAuth');
const { ROLES, TENANT_ROLES, ALL_ROLES } = require('./rbac');

// Defaults to ON in production for security. Explicitly set to 'off' to disable
// (staged rollout only). See TENANT-RLS-PLAN.md and server.js startup validation.
// Shared predicate — see lib/tenantRlsFlag.js for why it is not inlined here.
const { rlsEnforcementEnabled } = require('../lib/tenantRlsFlag');
const { setRequestContext } = require('../lib/request-context');
const TENANT_RLS_ENFORCE = rlsEnforcementEnabled();

// Path prefixes that stay reachable even when a studio's subscription has lapsed,
// so the studio can still authenticate, view its billing/frozen screen, manage
// its own profile, and the platform operator can always get in.
const SUBSCRIPTION_ALLOWLIST = [
  '/api/auth', '/api/v1/auth', '/api/profile',
  '/api/subscription', '/api/health',
  // Both names for the control plane. A lapsed subscription is a TENANT
  // state; the platform operator has no subscription and must never be
  // billing-gated out of the console — least of all when the reason they are
  // opening it is that somebody's billing is broken.
  '/api/platform', '/api/super-admin',
];

// Returns the blocking access decision when a tenant user's studio may not use
// protected features, else null. Super admins and org-less users bypass.
function subscriptionBlocked(req) {
  const u = req.user;
  if (!u || !u.organization_id || u.role === 'super_admin') return null;
  // subscription columns are absent on the legacy fallback query — fail open.
  if (u.subscription_status === undefined && u.organization_status === undefined) return null;
  const access = computeAccess({
    status: u.organization_status,
    subscription_status: u.subscription_status,
    trial_ends_at: u.trial_ends_at,
    current_period_end: u.current_period_end,
  });
  req.subscriptionAccess = access;
  return access.allowed ? null : access;
}

// In-memory user cache. The token only carries `id`; we re-load the row
// on every request so role / trainer_id / is_active changes propagate
// instantly. To avoid hitting Postgres on every API call, cache the
// resolved user for a short TTL.
const USER_CACHE_TTL_MS = 30000;
const USER_CACHE_MAX    = 500;
const userCache = new Map(); // id -> { user, expiresAt }
function _cacheGet(id) {
  const hit = userCache.get(id);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) { userCache.delete(id); return null; }
  return hit.user;
}
function _cacheSet(id, user) {
  // M-03: proper LRU — delete+re-insert moves the key to the end of insertion order.
  // Then evict oldest entries until within the cap.
  userCache.delete(id);
  userCache.set(id, { user, expiresAt: Date.now() + USER_CACHE_TTL_MS });
  while (userCache.size > USER_CACHE_MAX) {
    userCache.delete(userCache.keys().next().value);
  }
}
function invalidateUserCache(userId) {
  if (userId == null) userCache.clear();
  else userCache.delete(userId);
}

// Periodic cleanup of expired entries (runs every 60s, never prevents exit)
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of userCache) {
    if (entry.expiresAt < now) userCache.delete(id);
  }
}, 60_000).unref();

async function auth(req, res, next) {
  let token = null;
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    token = header.slice(7);
  } else if (req.cookies && req.cookies.token) {
    token = req.cookies.token;
  }

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Only a session token is a session. The same secret also signs short-lived
    // single-purpose tokens (the WebAuthn step-up action token carries `id` and
    // `purpose`), and every session mint site writes token_version. A token
    // that names a purpose, or that has no token_version to revoke it by, is
    // refused here rather than accepted as a login — otherwise a five-minute
    // action token would work as a bearer session, and revocation (password
    // change, deactivation, the role migration's version bump) would not reach
    // a token that simply omitted the claim.
    if (decoded.purpose !== undefined || !Number.isInteger(decoded.token_version) || !decoded.id) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    let user = _cacheGet(decoded.id);
    if (!user) {
      // One query and no fallback. There used to be a second SELECT, run
      // whenever this one threw for ANY reason, that dropped the deleted_at
      // filter "for pre-migration databases" — so a transient error on this
      // query authenticated soft-deleted accounts. A failure here is a 401.
      //
      // organization_id carries the tenant boundary onto req.user; it is the
      // only source of the tenant for every tenant route. pt_client_id is the
      // client-account link (a DIFFERENT column from member_id, which points
      // at the dropped legacy `clients` table — see migration 154), and
      // requireClient and every /api/me query read it off req.user: taking a
      // client id from the request instead is the exact mistake the isolation
      // layer exists to prevent.
      const { rows } = await pool.query(
        `SELECT u.id, u.name, u.email, u.role, u.trainer_id, u.member_id, u.pt_client_id,
                u.organization_id, o.name AS organization_name, o.logo_url AS organization_logo_url,
                o.is_founder, o.founder_number,
                o.status AS organization_status, o.subscription_status,
                o.trial_ends_at, o.current_period_end,
                u.is_active, u.token_version
           FROM users u
           LEFT JOIN organizations o ON o.id = u.organization_id
          WHERE u.id = $1
            AND u.deleted_at IS NULL`,
        [decoded.id]
      );
      user = rows[0];
      if (!user || !user.is_active) {
        return res.status(401).json({ error: 'Account not found or disabled' });
      }
      // The account must hold one of the three roles, and a tenant role must
      // carry its tenant. Both are also database constraints (migration 208);
      // checked here as well so that a row which somehow violated them is a
      // refused session rather than a session with no role or no studio.
      if (!ALL_ROLES.includes(user.role)
          || (TENANT_ROLES.includes(user.role) && !user.organization_id)
          || (user.role === ROLES.SUPER_ADMIN && user.organization_id)) {
        return res.status(403).json({ error: { code: 'ACCOUNT_MISCONFIGURED', message: 'This account cannot sign in. Contact support.' } });
      }
      _cacheSet(user.id, user);
    }

    // Token revocation, checked on every request rather than only on a cache
    // miss: the cache holds the user row, and a revoked token must not ride
    // out the cache TTL on the strength of someone else's cache fill.
    if (user.token_version !== decoded.token_version) {
      return res.status(401).json({ error: 'Session expired, please log in again' });
    }

    req.user = user;

    // Name the actor on the correlation context, so every line this request
    // goes on to write says WHO as well as WHICH REQUEST. Set here rather than
    // in requestId.js because the context is opened before authentication — a
    // rejected login has to be traceable too, and at that point there is no
    // actor to name.
    //
    // The user ID only. Never the name and never the email: logger.js redacts
    // those wherever they appear precisely because they kept arriving through
    // request bodies, and adding them back deliberately on every line would
    // undo that.
    setRequestContext({ actor: user.id, org: user.organization_id || null });

    // Which plane this session was opened for — see middleware/platformAuth.js.
    //
    // Read off the token rather than derived from req.user.role, and that is
    // the entire point: the role says what this account IS, the audience says
    // which door it came through. Deriving one from the other would collapse
    // them back into the single check the platform boundary exists to replace.
    //
    // `aud` is absent on every token minted before audiences existed, and null
    // is carried through as null rather than defaulted, so platformAuth.js can
    // tell "legacy session" from "tenant session" and treat them differently
    // during rollout.
    req.session = { aud: decoded.aud ?? null };

    // A Command Center session may not act inside a studio.
    //
    // Enforced here, once, rather than mounted onto the ~45 tenant route
    // mounts in server.js — a boundary that has to be remembered forty-five
    // times is a boundary with a hole in it. denyPlatformSession classifies by
    // path and treats anything it does not recognise as tenant surface, so a
    // route added later is covered without being added to a list.
    //
    // Dormant until PLATFORM_SESSION_ENFORCE is on; see platformAuth.js.
    if (platformSessionBlocked(req)) {
      return res.status(403).json(TENANT_SESSION_REQUIRED);
    }

    // The platform operator has no authority inside a studio.
    //
    // This is the role half of the boundary above (which is the audience
    // half): super_admin is a control-plane role, and every tenant route —
    // including the ones whose only guard is `auth` — is refused to it here,
    // once. It used to pass every role gate and, with no x-org-id header, have
    // tenantScope() apply NO organization filter at all, which made it an
    // unaudited superuser over every studio's data. The only way for the
    // operator to see inside a studio now is impersonation, which is minted by
    // an audited platform endpoint and loads the studio's own account as
    // req.user — so a request that gets past this line is always acting as a
    // trainer or member of exactly one organization.
    if (user.role === ROLES.SUPER_ADMIN && isTenantPlanePath((req.originalUrl || req.url || '').split('?')[0])) {
      return res.status(403).json({
        error: { code: 'TENANT_ACCESS_DENIED', message: 'Platform accounts cannot act inside a studio. Use impersonation from the Command Center.' },
      });
    }

    // Super-admin impersonation: the token carries an `imp` claim minted by the
    // platform portal. req.user is already the impersonated account (loaded
    // above), so the whole app renders as them. While read-only (`ro`), reject
    // every mutating request — the operator must exit impersonation to make
    // changes.
    if (decoded.imp) {
      // The claim names the studio it was minted for. The account it loaded
      // must still belong to that studio and still be a tenant account — a
      // token for a user who has since moved or been re-roled is not a
      // licence to act wherever they are now.
      if (!TENANT_ROLES.includes(user.role) || String(decoded.imp.org) !== String(user.organization_id)) {
        return res.status(401).json({ error: 'Session expired, please log in again' });
      }
      req.impersonation = decoded.imp;
      const method = (req.method || 'GET').toUpperCase();
      if (decoded.imp.ro && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
        return res.status(403).json({
          error: {
            code: 'IMPERSONATION_READONLY',
            message: 'Read-only impersonation: changes are disabled. Enter full access from the Command Center to make changes.',
          },
        });
      }
    }

    // Subscription enforcement (SaaS billing). Compute the studio's access state
    // from its cached subscription snapshot and block protected routes when the
    // trial/subscription has lapsed or the studio is suspended. Super admins,
    // legacy org-less users, and impersonation sessions bypass. Timestamps drive
    // expiry, so this is correct even off a cached user row.
    if (!req.impersonation) {
      const blocked = subscriptionBlocked(req);
      if (blocked) {
        const path = (req.originalUrl || req.url || '').split('?')[0];
        const allowed = SUBSCRIPTION_ALLOWLIST.some((p) => path.startsWith(p));
        if (!allowed) {
          return res.status(402).json({
            error: { code: 'SUBSCRIPTION_INACTIVE', state: blocked.state, message: blocked.reason },
          });
        }
      }
    }

    // Tenant context for db/pool.js's RLS query wrapper. Resolution failure
    // must never block the request — the role guards (requireTrainer /
    // requireClient) are the authorization gate, and they refuse an account
    // with no organization on their own.
    if (TENANT_RLS_ENFORCE) {
      let orgId = null;
      try { orgId = resolveOrgId(req); } catch { /* see comment above */ }
      // The ONLY place platform-wide status is granted, and the only reason
      // it is safe: it requires the role loaded from the database on this
      // request — never a header, a body field or anything the caller sent.
      // A super_admin only gets this far on a platform or plane-neutral path
      // (the tenant plane was refused above).
      //
      // Everything downstream (db/pool.js) treats this as "use the owner
      // connection, which bypasses RLS", so a bug that set it for a tenant
      // user would hand them the whole platform. That is why it is computed
      // here, from req.user.role, and nowhere else.
      const platformWide = req.user.role === ROLES.SUPER_ADMIN;
      return runWithTenantContext(orgId, next, { platformWide });
    }

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expired, please log in again' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// The role guards live in rbac.js. They are re-exported so a route file can
// take its whole auth chain from one module; there is no second
// implementation and no alias with a legacy name.
const { requireTrainer, requireClient, requireTrainerOrSelf } = require('./rbac');

module.exports = {
  auth,
  requireTrainer,
  requireClient,
  requireTrainerOrSelf,
  invalidateUserCache,
};

'use strict';
// Multi-tenant isolation helpers.
//
// The tenant boundary is the `organizations` table. Every authenticated tenant
// account (trainer or member) carries `req.user.organization_id`, loaded from
// the database by auth.js on every request. That column is the ONLY source of
// a request's tenant: no header, query parameter or body field can name or
// change it.
//
// The platform operator (super_admin) is not a tenant account. auth.js refuses
// it on every tenant-plane path, so on the paths where it is allowed (the
// control plane and the plane-neutral auth/profile routes) it resolves to no
// organization at all.

// Platform operators have role 'super_admin' and no organization.
function isSuperAdmin(req) {
  return req.user?.role === 'super_admin';
}

// Resolve the organization the current request operates within.
//   - Tenant accounts: their own organization_id — a hard, non-overridable
//     boundary.
//   - Platform operators: null. They act across tenants only through the
//     control-plane routes, which name the studio in the URL and are guarded
//     by PLATFORM_GUARD; they never inherit a tenant from the request.
// Throws a 403-worthy error only when a tenant account has no organization.
function resolveOrgId(req) {
  if (isSuperAdmin(req)) return null;
  const orgId = req.user?.organization_id;
  if (!orgId) {
    const err = new Error('No organization context for this account');
    err.status = 403;
    err.code = 'NO_TENANT';
    throw err;
  }
  return orgId;
}

// Express guard: attaches req.orgId for downstream handlers. Refuses any
// request that has no tenant — including a platform operator, who has no
// business on a route that mounts this.
function tenantContext(req, res, next) {
  try {
    const orgId = resolveOrgId(req);
    if (!orgId) {
      return res.status(403).json({ error: { code: 'NO_TENANT', message: 'No organization context for this account' } });
    }
    req.orgId = orgId;
    next();
  } catch (err) {
    res.status(err.status || 403).json({ error: { code: err.code || 'NO_TENANT', message: err.message } });
  }
}

// Express guard: platform super-admin only (the Command Center).
function requireSuperAdmin(req, res, next) {
  if (!isSuperAdmin(req)) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Super admin access required' } });
  }
  next();
}

// Express guard: OPTIONAL 2FA requirement for the platform admin.
//
// Defaults to ON in production for security. Explicitly set to 'off' to disable
// (staged rollout only). When required and MFA can't be confirmed it fails closed.
// Mount AFTER requireSuperAdmin.
const pool = require('../db/pool');
const REQUIRE_SUPER_ADMIN_MFA = process.env.SUPER_ADMIN_REQUIRE_MFA !== 'off';
async function requireSuperAdminMfa(req, res, next) {
  if (!REQUIRE_SUPER_ADMIN_MFA) return next();
  try {
    const { rows } = await pool.query(
      'SELECT mfa_enabled FROM user_profiles WHERE user_id = $1', [req.user.id]
    );
    if (rows[0] && rows[0].mfa_enabled) return next();
  } catch {
    /* user_profiles missing/unavailable — fall through to deny */
  }
  return res.status(403).json({
    error: {
      code: 'MFA_SETUP_REQUIRED',
      message: 'Enable two-factor authentication in Settings before using the platform admin.',
    },
  });
}

module.exports = { isSuperAdmin, resolveOrgId, tenantContext, requireSuperAdmin, requireSuperAdminMfa };

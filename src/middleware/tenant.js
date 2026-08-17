'use strict';
// Multi-tenant isolation helpers (Phase 0 — foundation).
//
// The tenant boundary is the `organizations` table. Every authenticated user
// carries `req.user.organization_id` (populated by auth.js after migration
// 078). These helpers are the single source of truth for resolving and
// enforcing that boundary. In Phase 0 they are DORMANT — exported and unit-
// testable but only active where explicitly mounted — so nothing changes yet.
// Later phases wire `tenantContext` globally, add a tenant-scoped query guard,
// and layer Postgres RLS underneath for defence in depth.

const { targetOrgId } = require('../lib/tenant-db');

// Platform operators have role 'super_admin' and no organization; they may act
// across tenants (e.g. the hidden admin portal).
function isSuperAdmin(req) {
  return req.user?.role === 'super_admin';
}

// Resolve the organization the current request operates within.
//   - Normal users: their own organization_id — a hard, non-overridable boundary.
//   - Super admins: may target a specific org via the `x-org-id` header,
//     else operate platform-wide (null).
// Throws a 403-worthy error only when a non-super-admin has no organization.
function resolveOrgId(req) {
  if (isSuperAdmin(req)) {
    // Same rule as tenantScope(), from the same function, so the two cannot
    // drift. This resolution feeds the RLS GUC (auth.js sets app.org_id from
    // it) while handlers filter with tenantScope() — if they disagreed about
    // the target org, the database and the application would be scoped to
    // different tenants within one request. See targetOrgId's own comment.
    return targetOrgId(req);
  }
  const orgId = req.user?.organization_id;
  if (!orgId) {
    const err = new Error('No organization context for this account');
    err.status = 403;
    err.code = 'NO_TENANT';
    throw err;
  }
  return orgId;
}

// Express guard: attaches req.orgId / req.isSuperAdmin for downstream handlers.
function tenantContext(req, res, next) {
  try {
    req.isSuperAdmin = isSuperAdmin(req);
    req.orgId = resolveOrgId(req);
    next();
  } catch (err) {
    res.status(err.status || 403).json({ error: { code: err.code || 'NO_TENANT', message: err.message } });
  }
}

// Express guard: platform super-admin only (the hidden admin portal).
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

'use strict';
// Tenant-scope resolution for the multi-tenant data layer.
//
// Given an authenticated request, decide which organization's rows it may
// touch. There is exactly one rule, and it fails closed:
//
//   - The request's tenant is req.user.organization_id, loaded from the
//     database by auth.js. Nothing the caller sends can name or widen it.
//   - An account with no organization resolves to orgId = null, and since
//     `organization_id = NULL` matches no rows, it sees NOTHING rather than
//     leaking across tenants.
//
// There used to be a second rule: a platform super_admin with no `x-org-id`
// header skipped the filter entirely and saw every studio's rows, and with the
// header was scoped to whichever studio it named. The operator is now refused
// on every tenant route by auth.js, so that branch could only ever have been a
// way back in. It is gone, and so is the header: control-plane routes name the
// studio in their own URL and never read tenantScope().

function tenantScope(req) {
  const orgId = req.user?.organization_id || null;
  // Always filtered. `applyFilter` is kept in the return shape because the
  // four modules that inline their own copy of orgWhere() read it.
  return { orgId, applyFilter: true };
}

// The org id to stamp onto rows this request creates.
function orgIdOf(req) {
  return tenantScope(req).orgId;
}

/**
 * ` AND <col> = $N`, pushing the org id onto `params`.
 *
 * Always emits the filter. For an account with no organization it binds NULL,
 * which matches no rows — the fail-closed half of the rule above.
 *
 * Intended to follow a `WHERE 1=1`, which is the idiom the rest of this
 * codebase already uses for composable filters (see pt-os.routes.js).
 */
function orgWhere(req, params, col = 'organization_id') {
  params.push(tenantScope(req).orgId);
  return ` AND ${col} = $${params.length}`;
}

module.exports = { tenantScope, orgIdOf, orgWhere };

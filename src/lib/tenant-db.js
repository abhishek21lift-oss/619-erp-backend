'use strict';
// Tenant-scope resolution for the multi-tenant data layer (Phase 1).
//
// Given an authenticated request, decide which organization's rows it may
// touch and whether an organization_id filter must be applied to queries.
//
// Rules (fail-closed):
//   - Platform super_admin, no target header → sees everything (no filter).
//   - Platform super_admin with `x-org-id`   → filtered to that org.
//   - Any tenant user                        → filtered to their own org.
//       A tenant user missing an org resolves to orgId=null, and since
//       `organization_id = NULL` matches no rows, they see NOTHING rather
//       than leaking across tenants.

/**
 * The org a platform super admin is targeting, or null for platform-wide.
 *
 * The `x-org-id` header and nothing else. It is the only mechanism the API
 * actually sanctions — server.js allowlists exactly this header in CORS, and
 * it is what every filtering path reads.
 *
 * Exported so middleware/tenant.js resolves the target the same way rather
 * than keeping a second, wider rule of its own. It used to accept
 * `?organization_id=` and a body field too, which mattered more than it
 * looked: auth.js sets the RLS GUC `app.org_id` from that resolution while
 * handlers filter with tenantScope() below, so a super admin passing
 * ?organization_id=X would have had the DATABASE scoped to X while the
 * application still believed it was operating platform-wide. Two layers
 * disagreeing about the active tenant is the exact confusion defence in depth
 * exists to remove.
 *
 * A tenant target that can arrive in a request body is also the easiest kind
 * to set by accident — a mistyped client call or a CSRF-shaped request — for
 * no benefit, since nothing sends one.
 */
function targetOrgId(req) {
  return req.headers['x-org-id'] || null;
}

function tenantScope(req) {
  const isSuperAdmin = req.user?.role === 'super_admin';
  const orgId = isSuperAdmin
    ? targetOrgId(req)
    : (req.user?.organization_id || null);
  // Super admins operating platform-wide (no target) skip the filter;
  // everyone else — including super admins targeting a specific org, and
  // tenant users (even org-less ones, which then match no rows) — is filtered.
  const applyFilter = !isSuperAdmin || orgId !== null;
  return { isSuperAdmin, orgId, applyFilter };
}

// The org id to stamp onto rows this request creates.
function orgIdOf(req) {
  return tenantScope(req).orgId;
}

module.exports = { tenantScope, orgIdOf, targetOrgId };

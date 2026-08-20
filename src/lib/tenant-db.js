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

/**
 * ` AND <col> = $N`, pushing the org id onto `params`.
 *
 * Returns '' for a platform super admin operating platform-wide, so the same
 * handler serves both a studio and the operator console without branching.
 *
 * Four modules already had a private copy of exactly this function
 * (pt-os.routes.js, training/authz.js, leave.js, client-portal.routes.js).
 * This is that same contract, character for character, hoisted to the module
 * that already owns tenantScope() so the routes fixed in migration 174's
 * sweep do not each add a fifth, sixth and seventh copy. The existing four
 * are deliberately left alone — they are correct, they are covered by tests,
 * and rewriting working isolation code during a security fix is how a
 * security fix introduces a regression.
 *
 * Intended to follow a `WHERE 1=1`, which is the idiom the rest of this
 * codebase already uses for composable filters (see pt-os.routes.js).
 */
function orgWhere(req, params, col = 'organization_id') {
  const scope = tenantScope(req);
  if (!scope.applyFilter) return '';
  params.push(scope.orgId);
  return ` AND ${col} = $${params.length}`;
}

module.exports = { tenantScope, orgIdOf, targetOrgId, orgWhere };

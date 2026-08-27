// src/middleware/branch-scope.js
//
// Branch-scope middleware (Blueprint §2.13).
//
// Restricts non-admin / non-manager users to data from their assigned
// branch. Mount AFTER `auth` so req.user.branch_id is available.
//
//   admin / manager   → see all branches
//   reception / trainer / member → only their own branch_id
//
// Routes use `req.branchScope.appendTo(existingParams)` to inject the filter:
//
//   const { sql, params } = req.branchScope.appendTo([existingParam1]);
//   pool.query(`SELECT ... WHERE cond AND ${sql}`, params);
//
// appendTo() automatically numbers $N based on the existing parameter list,
// so the caller never has to manually track parameter offsets.

function makeBranchScope(isAdmin, branchId) {
  function appendTo(existingParams) {
    if (!branchId) {
      // Single-branch / admin / legacy install — no filter needed.
      // Admins see all branches (including legacy NULL branch_id rows).
      return { sql: 'TRUE', params: existingParams || [] };
    }
    const offset = (existingParams || []).length;
    return {
      // Non-admin users only see their own branch.
      // Legacy rows with NULL branch_id are NOT visible to them —
      // they must be backfilled to a branch or will be invisible.
      // See migration 168 for branch_id backfill.
      sql:    `branch_id = $${offset + 1}`,
      params: [...(existingParams || []), branchId],
    };
  }
  return { isAdmin, branchId, appendTo };
}

function branchScope(req, _res, next) {
  if (!req.user) {
    req.branchScope = makeBranchScope(false, null);
    return next();
  }

  const role = req.user.role;
  const isAdmin = role === 'admin' || role === 'manager';
  const branchId = isAdmin ? null : (req.user.branch_id || null);

  req.branchScope = makeBranchScope(isAdmin, branchId);
  next();
}

module.exports = { branchScope };

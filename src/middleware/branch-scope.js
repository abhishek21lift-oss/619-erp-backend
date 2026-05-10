// src/middleware/branch-scope.js
//
// Branch-scope middleware (Blueprint §2.13).
//
// Restricts non-admin / non-manager users to data from their assigned
// branch. Mount AFTER `auth` so req.user.branch_id is available.
//
//   admin / manager   → see all branches
//   reception / trainer / member → only their own branch_id
//   kiosk             → its branch_id (set by kiosk-token middleware)
//
// Routes downstream can read `req.branchScope`:
//
//   { isAdmin: boolean,
//     branchId: string | null,
//     sql:      "branch_id = $X OR branch_id IS NULL",
//     params:   [...] }
//
// and append `sql`, `params` to their queries. Single-branch installs
// where branch_id is NULL on every row keep working unchanged.

function branchScope(req, _res, next) {
  const role = req.user && req.user.role;
  const isAdmin = role === 'admin' || role === 'manager';

  if (isAdmin) {
    req.branchScope = { isAdmin: true,  branchId: null, sql: 'TRUE', params: [] };
    return next();
  }

  const branchId = (req.user && req.user.branch_id) || null;
  if (!branchId) {
    // Single-branch / legacy install — every row's branch_id is NULL.
    req.branchScope = { isAdmin: false, branchId: null, sql: 'TRUE', params: [] };
    return next();
  }
  req.branchScope = {
    isAdmin: false,
    branchId,
    // The `OR branch_id IS NULL` keeps legacy rows visible during the
    // multi-branch rollout. Drop the OR clause once every row is migrated.
    sql:    '(branch_id = $1 OR branch_id IS NULL)',
    params: [branchId],
  };
  next();
}

module.exports = { branchScope };

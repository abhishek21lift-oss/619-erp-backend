'use strict';
// A studio's branches — its locations — resolved inside one organization.
//
// Branches are rows in system_settings keyed 'branch_*' under the studio's
// organization_id (routes/settings.js owns them). A branch id that arrives in
// a request body is tenant data like any other foreign key: it is accepted
// only when it names one of THIS studio's branches. There is no per-user
// branch restriction — the trainer runs every location of their studio.

/** True when `branchId` is one of `orgId`'s branches. Never true without an org. */
async function branchInOrg(db, orgId, branchId) {
  if (!orgId || !branchId) return false;
  const { rowCount } = await db.query(
    `SELECT 1 FROM system_settings
      WHERE organization_id = $2 AND key = $1 AND key LIKE 'branch\\_%' AND type = 'json'`,
    [String(branchId), orgId]
  );
  return rowCount > 0;
}

module.exports = { branchInOrg };

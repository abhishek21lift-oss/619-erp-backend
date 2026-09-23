// src/middleware/rbac.js
// Role-Based Access Control. Use after auth() middleware.
//
// There are exactly three roles, and each belongs to exactly one plane:
//
//   trainer      — the studio owner. The single highest authority inside a
//                  tenant: members, memberships, payments, attendance, PT,
//                  workouts, diet, progress, WhatsApp and settings.
//   member       — a client of that studio, acting on their own records only.
//   super_admin  — the platform operator. Control plane only (/api/platform);
//                  auth.js refuses it on every tenant route, so it never
//                  reaches a guard in this file on the tenant plane.
//
// No role is an alias of another and nothing is normalised: a role this file
// does not name is refused, not mapped onto one it does. The staff roles the
// product used to have (admin, manager, reception, staff) were migrated to
// `trainer` by migration 208 and the users_role_check constraint no longer
// admits them, so a row carrying one cannot exist — and if one did, it would
// be refused here rather than quietly promoted.
//
// Usage:
//   router.get('/clients', auth, requireTrainer, handler);
//   router.get('/me',      auth, requireClient,  handler);

const ROLES = Object.freeze({
  TRAINER: 'trainer',
  MEMBER: 'member',
  SUPER_ADMIN: 'super_admin',
});

/** The roles that live inside a tenant. super_admin is not one of them. */
const TENANT_ROLES = Object.freeze([ROLES.TRAINER, ROLES.MEMBER]);

/** Every role the system recognises, on either plane. */
const ALL_ROLES = Object.freeze([ROLES.TRAINER, ROLES.MEMBER, ROLES.SUPER_ADMIN]);

function unauthenticated(res) {
  return res.status(401).json({ error: { code: 'UNAUTH', message: 'Not authenticated' } });
}

/**
 * The studio's back office: the trainer who owns this tenant, and nobody else.
 *
 * organization_id is checked here as well as by auth.js. A trainer with no
 * studio has no tenant to act in, and every handler behind this guard scopes
 * its queries by that id — letting one through would hand a handler a null
 * tenant to scope by.
 */
function requireTrainer(req, res, next) {
  if (!req.user) return unauthenticated(res);
  if (req.user.role !== ROLES.TRAINER || !req.user.organization_id) {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'This area is for the studio trainer.' },
    });
  }
  next();
}

/**
 * The mirror of requireTrainer: a client, acting on their own behalf.
 *
 * pt_client_id is the client-account link (see auth.js). A member without one
 * has no records to act on, so it is refused rather than let through to a
 * handler that would scope by null.
 */
function requireClient(req, res, next) {
  if (!req.user) return unauthenticated(res);
  if (req.user.role !== ROLES.MEMBER || !req.user.pt_client_id || !req.user.organization_id) {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'This area is for client accounts.' },
    });
  }
  next();
}

/**
 * The trainer, or the member whose own client record is named by
 * `req.params[paramName]`.
 *
 * The member branch compares against pt_client_id loaded from the database by
 * auth.js — never against anything the request supplied — so a member naming
 * another client's id is refused, whichever studio that client belongs to.
 * Handlers behind this guard must still scope by organization_id: this
 * decides WHO may ask, the query decides WHICH ROWS exist for them.
 */
function requireTrainerOrSelf(paramName = 'id') {
  return (req, res, next) => {
    if (!req.user) return unauthenticated(res);
    if (req.user.role === ROLES.TRAINER && req.user.organization_id) return next();
    if (
      req.user.role === ROLES.MEMBER
      && req.user.pt_client_id
      // Checked on both branches, as requireClient does. auth.js already
      // refuses a tenant role with no studio, so this is the second lock on
      // the same door rather than the only one — but a handler behind this
      // guard scopes by organization_id, and null scopes by nothing.
      && req.user.organization_id
      && req.params[paramName] === req.user.pt_client_id
    ) {
      return next();
    }
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Cannot access this resource' } });
  };
}

module.exports = {
  ROLES,
  TENANT_ROLES,
  ALL_ROLES,
  requireTrainer,
  requireClient,
  requireTrainerOrSelf,
};

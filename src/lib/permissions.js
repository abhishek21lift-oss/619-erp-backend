'use strict';
/**
 * The studio's role-permission matrix — the one definition of it.
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 *
 * The matrix has always been configurable and has never been enforced. Sixteen
 * `perm_*` toggles are written by PUT /api/settings/permissions, read back by
 * GET, and consumed by exactly one thing: `canSeeByPermission()` in the
 * frontend's Sidebar.tsx, which decides whether to render a nav link.
 *
 * A repository-wide search for `perm_` outside routes/settings.js and its tests
 * returned nothing on the backend. So with `perm_trainer_finance = false` a
 * trainer saw no Finance link — and GET /api/expenses, GET /api/invoices and
 * GET /api/reports/monthly all still answered, because those mounts gate on
 * requireStaff, which includes `trainer`. A studio owner who switched a toggle
 * off believed they had removed access and had removed a menu item.
 *
 * Frontend authorisation is not authorisation. This module is the server side.
 *
 * ── Keys, and the three that mean nothing ───────────────────────────────────
 *
 * PERM_KEYS carries all sixteen because routes/settings.js must keep round-
 * tripping every one — an owner's saved value should not vanish because the
 * enforcement layer has no use for it yet.
 *
 * ENFORCEABLE is the subset with a defined meaning, taken from the frontend
 * mapping rather than invented here, so a link that disappears and a request
 * that is refused agree about why:
 *
 *   commissions      /pt-os/commissions
 *   record_payment   /finance/record-payment
 *   finance          /finance/*
 *   reports          /reports/*, /insights/*   (note: insights maps to reports)
 *   pt_module        /pt-os/*
 *   settings         /settings/*
 *
 * The three left out, and why:
 *
 *   insights      Sidebar.tsx routes /insights through can('reports'), so
 *                 perm_*_insights has never been consulted by anything. Kept in
 *                 PERM_KEYS so a stored value survives; not enforced, because
 *                 enforcing a key the UI never honoured would refuse requests
 *                 for a screen the owner can still see the link to.
 *   staff_view    No caller, front or back.
 *   all_pt_clients  A SCOPE rule ("this trainer sees every client, not only
 *                 their own"), not an access gate. Handlers already narrow by
 *                 `role === 'trainer'` in their own queries; wiring this toggle
 *                 into that narrowing changes which ROWS come back, which is a
 *                 different change from refusing a request and does not belong
 *                 in a middleware that can only say yes or no.
 */

/** Every key the settings screen round-trips. Order is the screen's order. */
const PERM_KEYS = [
  'perm_trainer_pt_module', 'perm_trainer_finance', 'perm_trainer_reports',
  'perm_trainer_insights', 'perm_trainer_staff_view', 'perm_trainer_settings',
  'perm_trainer_all_pt_clients', 'perm_trainer_commissions', 'perm_trainer_record_payment',
  'perm_reception_pt_module', 'perm_reception_finance', 'perm_reception_reports',
  'perm_reception_insights', 'perm_reception_settings', 'perm_reception_staff_view',
  'perm_reception_record_payment',
];

/**
 * What a studio gets before it changes anything.
 *
 * These are the values the product ships with, and they are load-bearing in a
 * way defaults usually are not: a studio that has never opened the permissions
 * screen has no rows at all, so every check falls through to this table. It
 * must stay identical to DEFAULTS in the frontend's permissions-context.tsx —
 * permissions.defaults.test.js fails the build if the two drift.
 */
const PERM_DEFAULTS = {
  perm_trainer_pt_module: true,
  perm_trainer_finance: false,
  perm_trainer_reports: false,
  perm_trainer_insights: false,
  perm_trainer_staff_view: true,
  perm_trainer_settings: false,
  perm_trainer_all_pt_clients: false,
  perm_trainer_commissions: true,
  perm_trainer_record_payment: false,
  perm_reception_pt_module: false,
  perm_reception_finance: false,
  perm_reception_reports: false,
  perm_reception_insights: false,
  perm_reception_settings: false,
  perm_reception_staff_view: true,
  perm_reception_record_payment: true,
};

/** The features this module will actually refuse a request for. */
const ENFORCEABLE = ['pt_module', 'finance', 'reports', 'settings', 'commissions', 'record_payment'];

/**
 * Roles the matrix speaks about.
 *
 * `receptionist` and `reception` are the same role under two spellings — both
 * are in rbac.js's STAFF_ROLES and roles.ts aliases one to the other. The
 * matrix keys use `reception`, so the alias is resolved here rather than left
 * for each caller to remember; a check written against one spelling and not the
 * other is a silent hole, which is the whole failure mode this file addresses.
 */
const ROLE_ALIASES = { receptionist: 'reception' };

/**
 * Roles the matrix does NOT constrain, and why each is safe to skip.
 *
 *   admin / manager   run the studio; they are who configures the matrix. This
 *                     matches the frontend's can(), which returns true for both
 *                     before looking at any key.
 *   super_admin       the platform operator, gated by PLATFORM_GUARD elsewhere.
 *
 * `member` is deliberately NOT here. An earlier draft included it, reasoning
 * that requireStaff refuses clients before this gate ever runs — true of every
 * mount this is currently on, and not a property of the gate itself. Not every
 * mount carries requireStaff (/api/payments does not), so a gate that assumed
 * it would wave a client straight through the moment it was used somewhere new.
 * A member has no key in the matrix, so falling through to can()'s fail-closed
 * branch denies them, which is both correct and safe to rely on.
 */
const UNCONSTRAINED_ROLES = ['admin', 'manager', 'super_admin'];

/** `perm_trainer_finance` for ('trainer', 'finance'), or null if not a matrix role. */
function permKey(role, feature) {
  const r = ROLE_ALIASES[role] || role;
  if (r !== 'trainer' && r !== 'reception') return null;
  return `perm_${r}_${feature}`;
}

/**
 * May `role` use `feature`, given a studio's stored matrix?
 *
 * `matrix` holds only the keys a studio has actually saved; anything absent
 * falls through to PERM_DEFAULTS, and a key in neither is DENIED. That last
 * step is the fail-closed one: a feature name added to a route and misspelled,
 * or added before its keys exist, refuses the request rather than waving it
 * through — visible immediately, instead of a gate that silently permits
 * everything.
 */
function can(role, feature, matrix = {}) {
  if (UNCONSTRAINED_ROLES.includes(role)) return true;
  const key = permKey(role, feature);
  if (!key) return false;
  if (Object.prototype.hasOwnProperty.call(matrix, key)) return matrix[key] === true;
  if (Object.prototype.hasOwnProperty.call(PERM_DEFAULTS, key)) return PERM_DEFAULTS[key];
  return false;
}

module.exports = {
  PERM_KEYS, PERM_DEFAULTS, ENFORCEABLE, UNCONSTRAINED_ROLES, ROLE_ALIASES,
  permKey, can,
};

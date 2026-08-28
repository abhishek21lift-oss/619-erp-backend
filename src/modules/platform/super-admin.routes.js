'use strict';
// Super Admin platform API (multi-tenant SaaS).
//
// The hidden admin portal that only platform operators (role='super_admin')
// can reach. Mounted in server.js with `auth` + `requireSuperAdmin` +
// `requireSuperAdminMfa` applied at the mount point, so every handler in every
// router below runs as an authenticated super admin.
//
// SECURITY: platform-level only. Tenant admins (role='admin') never reach here.
// Every mutation is written to activity_log for audit.
//
// ── Why this file is only a mount list ──────────────────────────────────────
//
// It used to be 4,248 lines and 98 routes in one module (audit finding H-03).
// The domains below were already de-facto sections in that file — each had its
// own requires and helpers declared inline just above its routes — so the split
// follows seams that were already there rather than imposing new ones.
//
// Order follows the original file, with ONE deliberate exception: the two
// /organizations/:id/ai-limit routes sat in the middle of the invitations
// section and moved into ai.js, where they belong. They are now registered six
// positions earlier than before.
//
// That is safe because no two routes in this API shadow each other — no literal
// path is reachable only by being registered before a `:param` route that would
// swallow it. __tests__/superAdmin.routes.split.test.js asserts exactly that,
// so if a future route would depend on order, the invariant fails loudly rather
// than the endpoint quietly becoming unreachable.
//
// Sub-routers are mounted at the root path, so every URL is exactly what it
// was: `router.use(x)` adds no prefix.

const router = require('express').Router();

// Mounted before organizations, which owns PATCH/DELETE /users/:id.
//
// Nothing here actually collides — this module's routes are GET and the other's
// are PATCH/DELETE, so Express would resolve them correctly in either order —
// but /users/summary is a literal segment on a path where :param routes already
// live, and that is the shape that becomes unreachable when somebody later adds
// GET /users/:id without noticing. Ordering it first makes the answer right by
// construction rather than by the current method mix.
// superAdmin.routes.split.test.js asserts no route shadows another.
router.use(require('./super-admin/users'));
router.use(require('./super-admin/organizations'));
router.use(require('./super-admin/operations'));
router.use(require('./super-admin/impersonation'));
router.use(require('./super-admin/subscriptions'));
router.use(require('./super-admin/billing'));
router.use(require('./super-admin/features'));
router.use(require('./super-admin/announcements'));
router.use(require('./super-admin/security'));
router.use(require('./super-admin/analytics'));
router.use(require('./super-admin/ai'));
router.use(require('./super-admin/invitations'));
router.use(require('./super-admin/support'));
router.use(require('./super-admin/storage'));
router.use(require('./super-admin/registrations'));
router.use(require('./super-admin/mail'));
// Command Center. Mounted here rather than on its own /api path so it inherits
// this mount's auth -> requireSuperAdmin -> requireSuperAdminMfa chain. The
// console grows container-restart buttons in a later phase and must not have a
// second door to guard.
router.use(require('../command-center/command-center.routes'));

// Command Centre Phase 6 — Tenancy Health, platform KPIs, Studio 360 deep
// view, and global search. Each module is read-only except
// `tenancy.run-isolation-tests`, which is rate-limited per user and audited
// the same way every other platform mutation is. The mounts here are
// deliberately AFTER every other domain so the platform-owners / overview /
// users / audit routes still take precedence on any literal-segment conflict
// (none today, but the order is the cheap insurance).
router.use(require('./super-admin/tenancy'));
router.use(require('./super-admin/kpis'));
router.use(require('./super-admin/studios'));
router.use(require('./super-admin/search'));

module.exports = router;

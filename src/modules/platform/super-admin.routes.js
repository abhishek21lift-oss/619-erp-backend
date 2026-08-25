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
// This file is intentionally a mount list. Domain behavior belongs in the
// smaller routers under ./super-admin and the Command Center module.

const router = require('express').Router();

// Mounted before organizations, which owns PATCH/DELETE /users/:id.
// GET /users/summary is a literal segment and must remain ahead of any future
// GET /users/:id route. The route split test pins this invariant.
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

// Command Center inherits this mount's authentication + super-admin + MFA
// chain. It is deliberately not mounted behind a second, weaker door.
router.use(require('../command-center/command-center.routes'));
router.use(require('../command-center/risk.routes'));

module.exports = router;

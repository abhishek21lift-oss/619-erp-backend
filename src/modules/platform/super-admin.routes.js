'use strict';
// Super Admin platform API (multi-tenant SaaS).
//
// The hidden admin portal that only platform operators (role='super_admin')
// can reach. Mounted in server.js with auth + requireSuperAdmin +
// requireSuperAdminMfa applied at the mount point.
//
// SECURITY: platform-level only. Tenant admins never reach this router.
// Keep this file as a mount list; domain behavior belongs in its submodules.

const router = require('express').Router();

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

// Command Center inherits the same authenticated platform boundary. These
// routers are intentionally separate so operational features can evolve
// without turning the platform mount back into a monolith.
router.use(require('../command-center/command-center.routes'));
router.use(require('../command-center/risk.routes'));
router.use(require('../command-center/action-center.routes'));

module.exports = router;

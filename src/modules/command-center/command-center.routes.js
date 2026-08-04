// src/modules/command-center/command-center.routes.js
//
// Phase 1: the read-only snapshot surface.
//
// Mounted under /api/super-admin, so it inherits that mount's
// auth -> requireSuperAdmin -> requireSuperAdminMfa chain rather than declaring
// its own. This console will grow buttons that restart containers; it must
// never be reachable by a tenant admin, and the safest way to guarantee that is
// to not have a second door to guard.
'use strict';

const router = require('express').Router();
const { registerCollectors, registry, snapshot } = require('./index');

registerCollectors();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * GET /api/super-admin/command-center/snapshot
 *   ?cards=runtime,redis   subset
 *   ?fresh=1               bypass the per-collector TTL cache
 *
 * Always 200 when the process is alive. A card that failed reports its own
 * status inside the payload — an ops console that 500s during an incident is
 * an ops console that is useless during an incident.
 */
router.get('/command-center/snapshot', wrap(async (req, res) => {
  const only = String(req.query.cards || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const data = await snapshot.collect({ only, fresh: req.query.fresh === '1' });
  res.json({ data });
}));

/** The card names this build knows about, for the client to render a grid. */
router.get('/command-center/cards', wrap(async (_req, res) => {
  res.json({ data: { cards: registry.names(), statuses: Object.values(registry.STATUS) } });
}));

module.exports = router;

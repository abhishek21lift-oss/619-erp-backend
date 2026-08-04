// src/modules/command-center/command-center.routes.js
//
// The console's HTTP surface: read-only snapshots (Phase 1–2) and the
// allow-listed operational commands (Phase 5).
//
// Mounted under /api/super-admin, so it inherits that mount's
// auth -> requireSuperAdmin -> requireSuperAdminMfa chain rather than declaring
// its own. This console has buttons that pause queues and delete failed jobs; it
// must never be reachable by a tenant admin, and the safest way to guarantee
// that is to not have a second door to guard.
'use strict';

const router = require('express').Router();
const { registerCollectors, registry, snapshot } = require('./index');
const commands = require('./commands.service');
const alerts = require('./alerts.service');
const guardian = require('./guardian.service');

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

/**
 * GET /api/super-admin/command-center/commands
 *
 * The whole allow-list, including entries that cannot run here — each carries
 * its own `unavailable_reason`. The console renders the full recovery ladder
 * with the missing rungs disabled and explained, rather than hiding them and
 * looking more complete than it is.
 */
router.get('/command-center/commands', wrap(async (_req, res) => {
  res.json({ data: { commands: commands.list() } });
}));

/**
 * POST /api/super-admin/command-center/commands/:name
 * body: { queue?, confirm?, dryRun? }
 *
 * `:name` is looked up in the allow-list — it is never interpolated into
 * anything — and an unknown name 404s before any work happens.
 *
 * The failure codes are distinct on purpose, because the client's response to
 * each differs: 428 means show the confirmation prompt, 429 means the button
 * is on cooldown, 503 means the capability is absent on this deployment.
 */
router.post('/command-center/commands/:name', wrap(async (req, res, next) => {
  const { queue, confirm, dryRun } = req.body || {};
  try {
    const data = await commands.run(req.params.name, {
      req,
      queue: typeof queue === 'string' ? queue : undefined,
      confirm: typeof confirm === 'string' ? confirm : undefined,
      dryRun: dryRun === true,
    });
    res.json({ data });
  } catch (err) {
    if (!err.status) return next(err);
    res.status(err.status).json({
      error: { code: err.code || 'COMMAND_FAILED', message: err.message },
    });
  }
}));

// ── Alert Center ────────────────────────────────────────────────────────────
//
// There is no "evaluate now" route. Forcing an evaluation is an operator action
// with a cost, and the Command Center already has the machinery for those —
// allow-listed, audited, cooldown-guarded. It is `alerts.evaluate` in
// commands.service.js rather than a fourth door here.

/**
 * GET /api/super-admin/command-center/alerts
 *   ?scope=live|resolved|all   default live
 *   ?limit=                    capped server-side
 *
 * Returns the alerts plus the counts the badge needs, in one call — the console
 * would otherwise ask for both on every poll.
 */
router.get('/command-center/alerts', wrap(async (req, res) => {
  const scope = ['live', 'resolved', 'all'].includes(String(req.query.scope))
    ? String(req.query.scope) : 'live';
  res.json({ data: await alerts.list({ scope, limit: req.query.limit }) });
}));

/** Acknowledge: "seen, I am on it". Does not stop the alert tracking. */
router.post('/command-center/alerts/:id/ack', wrap(async (req, res, next) => {
  try {
    res.json({ data: await alerts.acknowledge(req.params.id, req) });
  } catch (err) {
    if (!err.status) return next(err);
    res.status(err.status).json({ error: { code: 'ALERT_NOT_OPEN', message: err.message } });
  }
}));

/** Close by hand. Recorded as `manual`, which is how bad detection stays visible. */
router.post('/command-center/alerts/:id/resolve', wrap(async (req, res, next) => {
  try {
    res.json({ data: await alerts.resolve(req.params.id, req) });
  } catch (err) {
    if (!err.status) return next(err);
    res.status(err.status).json({ error: { code: 'ALERT_NOT_LIVE', message: err.message } });
  }
}));

// ── AI Guardian ─────────────────────────────────────────────────────────────

/**
 * GET /api/super-admin/command-center/guardian
 *
 * Deterministic correlations across cards. No AI is called here — this is the
 * rules engine, and it answers in single-digit milliseconds off the cached
 * snapshot. An empty `findings` with a `note` means the rules RAN and matched
 * nothing, which is a different claim from the Guardian not having run.
 */
router.get('/command-center/guardian', wrap(async (req, res) => {
  res.json({ data: await guardian.analyse({ fresh: req.query.fresh === '1' }) });
}));

/**
 * POST /api/super-admin/command-center/guardian/:id/explain
 *
 * Narrates ONE finding. Separate from the read above, and a POST, because it
 * costs money: narrating on every poll would spend tokens restating text
 * already on screen. The model is given the finding and its evidence, never the
 * raw snapshot, and it cannot change the diagnosis, severity or confidence.
 */
router.post('/command-center/guardian/:id/explain', wrap(async (req, res, next) => {
  try {
    res.json({ data: await guardian.explain(req.params.id) });
  } catch (err) {
    if (!err.status) return next(err);
    res.status(err.status).json({ error: { code: 'FINDING_NOT_ACTIVE', message: err.message } });
  }
}));

module.exports = router;

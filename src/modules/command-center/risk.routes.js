'use strict';

const router = require('express').Router();
const { snapshot } = require('./index');
const guardian = require('./guardian.service');
const risk = require('./risk.service');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * GET /api/super-admin/command-center/risk
 *
 * Returns an explainable platform risk score. The score is deterministic and
 * derived only from Command Center telemetry plus existing Guardian findings.
 * It never invokes an AI model and never executes an operational command.
 */
router.get('/command-center/risk', wrap(async (req, res) => {
  const fresh = req.query.fresh === '1';
  const [snap, guardianReport] = await Promise.all([
    snapshot.collect({ fresh }),
    guardian.analyse({ fresh }),
  ]);
  const data = await risk.assess({ snapshot: snap, guardian: guardianReport });
  res.json({ data });
}));

module.exports = router;

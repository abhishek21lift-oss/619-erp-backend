'use strict';

const router = require('express').Router();
const guardian = require('./guardian.service');
const alerts = require('./alerts.service');
const actionCenter = require('./action-center.service');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * GET /api/super-admin/command-center/action-center
 *
 * A read-only, deterministic operator queue. It aggregates verified Guardian
 * findings and live alerts. It never executes the recommended commands.
 */
router.get('/command-center/action-center', wrap(async (req, res) => {
  const [guardianReport, alertReport] = await Promise.all([
    guardian.analyse({ fresh: req.query.fresh === '1' }),
    alerts.list({ scope: 'live', limit: 100 }),
  ]);
  const alertItems = Array.isArray(alertReport?.alerts)
    ? alertReport.alerts
    : Array.isArray(alertReport?.items)
      ? alertReport.items
      : [];
  res.json({
    data: actionCenter.build({ findings: guardianReport.findings, alerts: alertItems }),
  });
}));

module.exports = router;

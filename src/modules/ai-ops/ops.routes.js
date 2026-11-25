'use strict';

// /api/ai/ops — the trainer's queue.
//
// The mount in server.js carries userApiLimiter + studioGate('ai_suite'), so
// entitlement, trainer role and authentication are decided before any handler
// here runs. Only POST /refresh spends a token, so only it carries aiLimiter
// and the monthly quota guard.

const express = require('express');
const ops = require('./ops.service');
const { tenantScope } = require('../../lib/tenant-db');
const { today: studioToday } = require('../../lib/appTime');
const { aiLimiter } = require('../../middleware/aiRateLimit');
const { requireAiQuota } = require('../../lib/aiQuota');

const router = express.Router();

const SNOOZE_DAYS = new Set([1, 3, 7]);
const DISMISS_REASONS = new Set(['not_relevant', 'already_handled', 'asked_not_to_contact', 'other']);

function validation(message) {
  return Object.assign(new Error(message), {
    name: 'OpsError', status: 400, code: 'VALIDATION',
  });
}

function sendOpsError(err, res) {
  if (err && err.name === 'OpsError') {
    res.status(err.status || 400).json({
      error: { code: err.code || 'VALIDATION', message: err.message },
    });
    return true;
  }
  return false;
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
  if (sendOpsError(err, res)) return;
  next(err);
});

function actorOf(req) {
  return { userId: req.user?.id ?? null, role: req.user?.role ?? null };
}

router.get('/queue', wrap(async (req, res) => {
  const { orgId } = tenantScope(req);
  res.json({ data: await ops.getQueue({ orgId, today: studioToday() }) });
}));

router.post('/refresh', aiLimiter, requireAiQuota(), wrap(async (req, res) => {
  const { orgId } = tenantScope(req);
  res.json({
    data: await ops.refresh({
      orgId, today: studioToday(), actor: actorOf(req), requestId: req.id ?? null,
    }),
  });
}));

router.get('/items/:id', wrap(async (req, res) => {
  const { orgId } = tenantScope(req);
  res.json({ data: await ops.getItem({ orgId, itemId: req.params.id }) });
}));

router.post('/items/:id/approve', wrap(async (req, res) => {
  const { orgId } = tenantScope(req);
  const body = req.body?.body;
  if (body !== undefined && typeof body !== 'string') throw validation('body must be a string');
  if (typeof body === 'string' && body.length > 1200) {
    throw validation('body must be 1200 characters or fewer');
  }

  res.json({
    data: await ops.approve({
      orgId, itemId: req.params.id, body, actor: actorOf(req), requestId: req.id ?? null,
    }),
  });
}));

router.post('/items/:id/snooze', wrap(async (req, res) => {
  const { orgId } = tenantScope(req);
  const days = req.body?.days;
  if (!SNOOZE_DAYS.has(days)) throw validation('days must be 1, 3 or 7');

  res.json({
    data: await ops.snooze({ orgId, itemId: req.params.id, days, actor: actorOf(req) }),
  });
}));

router.post('/items/:id/dismiss', wrap(async (req, res) => {
  const { orgId } = tenantScope(req);
  const reason = req.body?.reason;
  if (!DISMISS_REASONS.has(reason)) throw validation('unknown dismiss reason');

  res.json({
    data: await ops.dismiss({ orgId, itemId: req.params.id, reason, actor: actorOf(req) }),
  });
}));

router.post('/items/:id/resolve', wrap(async (req, res) => {
  const { orgId } = tenantScope(req);
  res.json({
    data: await ops.resolveManually({ orgId, itemId: req.params.id, actor: actorOf(req) }),
  });
}));

module.exports = router;

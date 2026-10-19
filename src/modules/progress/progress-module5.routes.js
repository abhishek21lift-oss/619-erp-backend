'use strict';
// src/modules/progress/progress-module5.routes.js
// Trainer-facing Module 5 API, mounted at /api/progress.
//
// The existing /api/progress router still owns assessments, goals, lifestyle,
// nutrition and strength. This router only adds the re-test scheduler, the
// seven-domain comparison and the daily journal, and every client-scoped route
// re-checks that the client belongs to the caller's studio.

const router = require('express').Router();
const { auth, requireTrainer } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const { z } = require('../../lib/validation');
const { orgIdOf } = require('../../lib/tenant-db');
const { clientInOrg } = require('../../lib/orgGuard');
const { optionalNumber } = require('../../lib/zodNumbers');
const retests = require('./retests.service');
const habits = require('./habits.service');

router.use(auth, requireTrainer);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function fail(res, err) {
  if (err.status && err.code) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  throw err;
}

async function requireClient(req, res) {
  const clientId = req.params.clientId;
  if (!await clientInOrg(req, clientId)) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
    return null;
  }
  return clientId;
}

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Use a real calendar date');
const optionalDateString = dateString.optional().nullable();
const optionalText = (max) => z.string().max(max).optional().nullable();

// ── Settings ────────────────────────────────────────────────
const settingsSchema = {
  body: z.object({
    cadence_months: z.coerce.number().int().min(4).max(6),
    reminder_days: z.array(z.coerce.number().int().min(1).max(120)).min(1).max(6),
    is_enabled: z.boolean().optional(),
  }),
};

router.get('/module5/settings', wrap(async (req, res) => {
  res.json({ data: await retests.getSettings(orgIdOf(req)) });
}));

router.put('/module5/settings', validate(settingsSchema), wrap(async (req, res) => {
  res.json({ data: await retests.saveSettings(orgIdOf(req), req.body, req.user.id) });
}));

// ── Re-test scheduler ───────────────────────────────────────
router.get('/clients/:clientId/retest', wrap(async (req, res) => {
  const clientId = await requireClient(req, res);
  if (!clientId) return;
  res.json({ data: await retests.overview(orgIdOf(req), clientId) });
}));

const startSchema = { body: z.object({ scheduled_date: optionalDateString, notes: optionalText(2000) }) };

router.post('/clients/:clientId/retest', validate(startSchema), wrap(async (req, res) => {
  const clientId = await requireClient(req, res);
  if (!clientId) return;
  try {
    const data = await retests.startSchedule(orgIdOf(req), clientId, {
      scheduledDate: req.body.scheduled_date || null, notes: req.body.notes || null, createdBy: req.user.id,
    });
    res.status(201).json({ data });
  } catch (err) { fail(res, err); }
}));

const rescheduleSchema = {
  body: z.object({
    scheduled_date: dateString,
    reason: optionalText(500),
    notes: optionalText(2000),
  }),
};

router.patch('/clients/:clientId/retest/:id', validate(rescheduleSchema), wrap(async (req, res) => {
  const clientId = await requireClient(req, res);
  if (!clientId) return;
  try {
    res.json({
      data: await retests.reschedule(orgIdOf(req), clientId, req.params.id, {
        scheduledDate: req.body.scheduled_date, reason: req.body.reason,
        notes: req.body.notes, updatedBy: req.user.id,
      }),
    });
  } catch (err) { fail(res, err); }
}));

const cancelSchema = { body: z.object({ reason: optionalText(500) }).optional() };

router.post('/clients/:clientId/retest/:id/cancel', validate(cancelSchema), wrap(async (req, res) => {
  const clientId = await requireClient(req, res);
  if (!clientId) return;
  try {
    res.json({ data: await retests.cancel(orgIdOf(req), clientId, req.params.id, req.body?.reason, req.user.id) });
  } catch (err) { fail(res, err); }
}));

router.post('/clients/:clientId/retest/:id/complete', validate({
  body: z.object({ assessment_id: z.string().min(1) }),
}), wrap(async (req, res) => {
  const clientId = await requireClient(req, res);
  if (!clientId) return;
  try {
    res.json({ data: await retests.complete(orgIdOf(req), clientId, req.params.id, req.body.assessment_id, req.user.id) });
  } catch (err) { fail(res, err); }
}));

// ── Seven-domain comparison ─────────────────────────────────
router.get('/clients/:clientId/comparison', wrap(async (req, res) => {
  const clientId = await requireClient(req, res);
  if (!clientId) return;
  try {
    res.json({
      data: await retests.comparisonFor(orgIdOf(req), clientId, {
        baselineId: req.query.baseline_id, latestId: req.query.latest_id,
      }),
    });
  } catch (err) { fail(res, err); }
}));

// ── Daily journal ───────────────────────────────────────────
router.get('/clients/:clientId/habits', wrap(async (req, res) => {
  const clientId = await requireClient(req, res);
  if (!clientId) return;
  const from = req.query.from || req.query.from_date;
  const to = req.query.to || req.query.to_date;
  const parsedFrom = dateString.safeParse(from);
  const parsedTo = dateString.safeParse(to);
  if (!parsedFrom.success || !parsedTo.success || parsedFrom.data > parsedTo.data) {
    return res.status(400).json({ error: { code: 'INVALID_RANGE', message: 'from and to must be real YYYY-MM-DD dates, with from on or before to' } });
  }
  res.json({ data: await habits.listLogs(orgIdOf(req), clientId, from, to) });
}));

router.get('/clients/:clientId/habits/dashboard', validate({
  query: z.object({
    date: optionalDateString,
    days: z.coerce.number().int().min(7).max(90).optional(),
  }),
}), wrap(async (req, res) => {
  const clientId = await requireClient(req, res);
  if (!clientId) return;
  try {
    res.json({
      data: await habits.dashboard(orgIdOf(req), clientId, {
        date: req.query.date, days: req.query.days,
      }),
    });
  } catch (err) { fail(res, err); }
}));

const logSchema = {
  body: z.object({
    log_date: optionalDateString,
    sleep_hours: optionalNumber({ label: 'sleep_hours', min: 0, max: 24 }),
    sleep_quality: optionalNumber({ label: 'sleep_quality', min: 1, max: 5, int: true }),
    water_ml: optionalNumber({ label: 'water_ml', min: 0, max: 15000, int: true }),
    electrolytes: z.boolean().optional().nullable(),
    steps: optionalNumber({ label: 'steps', min: 0, max: 200000, int: true }),
    steps_source: z.enum(['manual', 'wearable', 'imported']).optional().nullable(),
    stress_level: optionalNumber({ label: 'stress_level', min: 1, max: 5, int: true }),
    energy_level: optionalNumber({ label: 'energy_level', min: 1, max: 5, int: true }),
    fatigue_level: optionalNumber({ label: 'fatigue_level', min: 1, max: 5, int: true }),
    soreness_level: optionalNumber({ label: 'soreness_level', min: 1, max: 5, int: true }),
    recovery_level: optionalNumber({ label: 'recovery_level', min: 1, max: 5, int: true }),
    notes: optionalText(2000),
  }).refine((b) => Object.keys(b).some((k) => k !== 'log_date' && b[k] != null), {
    message: 'Provide at least one journal value',
  }),
};

router.post('/clients/:clientId/habits', validate(logSchema), wrap(async (req, res) => {
  const clientId = await requireClient(req, res);
  if (!clientId) return;
  try {
    const logDate = req.body.log_date || null;
    const values = { ...req.body };
    delete values.log_date;
    res.json({ data: await habits.upsertLog({ orgId: orgIdOf(req), clientId, logDate, values, userId: req.user.id }) });
  } catch (err) { fail(res, err); }
}));

router.get('/clients/:clientId/habit-preferences', wrap(async (req, res) => {
  const clientId = await requireClient(req, res);
  if (!clientId) return;
  res.json({ data: await habits.getPreferences(orgIdOf(req), clientId) });
}));

const preferenceSchema = {
  body: z.object({
    sleep_target_min: optionalNumber({ label: 'sleep_target_min', min: 0, max: 24 }),
    sleep_target_max: optionalNumber({ label: 'sleep_target_max', min: 0, max: 24 }),
    water_target_ml: optionalNumber({ label: 'water_target_ml', min: 0, max: 15000, int: true }),
    step_target: optionalNumber({ label: 'step_target', min: 0, max: 200000, int: true }),
    reminder_enabled: z.boolean().optional(),
    reminder_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Use HH:MM').optional().nullable(),
    wearable_provider: z.string().max(60).optional().nullable(),
  }),
};

router.put('/clients/:clientId/habit-preferences', validate(preferenceSchema), wrap(async (req, res) => {
  const clientId = await requireClient(req, res);
  if (!clientId) return;
  try {
    res.json({ data: await habits.savePreferences(orgIdOf(req), clientId, req.body) });
  } catch (err) { fail(res, err); }
}));

// ── Trainer review of insights ──────────────────────────────
const reviewSchema = {
  body: z.object({
    insight_key: z.string().min(1).max(100),
    insight_type: z.enum(['observation', 'recommendation']),
    title: z.string().min(1).max(200),
    observation: optionalText(2000),
    recommendation: optionalText(2000),
    decision: z.enum(['acknowledged', 'approved', 'dismissed']),
    notes: optionalText(2000),
  }),
};

router.post('/clients/:clientId/insights/review', validate(reviewSchema), wrap(async (req, res) => {
  const clientId = await requireClient(req, res);
  if (!clientId) return;
  res.status(201).json({ data: await habits.reviewInsight(orgIdOf(req), clientId, req.body, req.user.id) });
}));

router.get('/clients/:clientId/insights/reviews', wrap(async (req, res) => {
  const clientId = await requireClient(req, res);
  if (!clientId) return;
  res.json({ data: await habits.listReviews(orgIdOf(req), clientId) });
}));

module.exports = router;

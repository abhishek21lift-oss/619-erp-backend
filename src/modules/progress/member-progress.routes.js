'use strict';
// src/modules/progress/member-progress.routes.js
// The signed-in member's own Module 5 view, mounted at /api/me.
//
// The client id comes from req.user.pt_client_id, never from the request.
// There is no client id parameter on any route here, so there is nothing to
// tamper with; the organization is the one on the same token.

const router = require('express').Router();
const { auth, requireClient } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const { z } = require('../../lib/validation');
const { optionalNumber } = require('../../lib/zodNumbers');
const retests = require('./retests.service');
const habits = require('./habits.service');

router.use(auth, requireClient);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function selfOf(req) {
  return { clientId: req.user.pt_client_id, orgId: req.user.organization_id };
}

function fail(res, err) {
  if (err.status && err.code) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  throw err;
}

function requireSelf(req, res) {
  const { clientId, orgId } = selfOf(req);
  if (!clientId || !orgId) {
    res.status(403).json({ error: { code: 'NO_CLIENT_PROFILE', message: 'This account is not linked to a client profile.' } });
    return null;
  }
  return { clientId, orgId };
}

// GET /api/me/progress — schedule, comparison, journal summary, goal, workouts
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Use a real calendar date');

router.get('/progress', validate({
  query: z.object({
    date: calendarDate.optional(),
    days: z.coerce.number().int().min(7).max(90).optional(),
  }),
}), wrap(async (req, res) => {
  const self = requireSelf(req, res);
  if (!self) return;
  try {
    res.json({ data: await habits.memberDashboard(self.orgId, self.clientId, { date: req.query.date, days: req.query.days }) });
  } catch (err) { fail(res, err); }
}));

// GET /api/me/progress/retest — the countdown and history on its own
router.get('/progress/retest', wrap(async (req, res) => {
  const self = requireSelf(req, res);
  if (!self) return;
  res.json({ data: await retests.overview(self.orgId, self.clientId) });
}));

// GET /api/me/progress/comparison — baseline vs latest, seven domains
router.get('/progress/comparison', wrap(async (req, res) => {
  const self = requireSelf(req, res);
  if (!self) return;
  try {
    res.json({ data: await retests.comparisonFor(self.orgId, self.clientId) });
  } catch (err) { fail(res, err); }
}));

// ── Daily journal ───────────────────────────────────────────
router.get('/habits', wrap(async (req, res) => {
  const self = requireSelf(req, res);
  if (!self) return;
  const from = req.query.from || req.query.from_date;
  const to = req.query.to || req.query.to_date;
  const parsedFrom = calendarDate.safeParse(from);
  const parsedTo = calendarDate.safeParse(to);
  if (!parsedFrom.success || !parsedTo.success || parsedFrom.data > parsedTo.data) {
    return res.status(400).json({ error: { code: 'INVALID_RANGE', message: 'from and to must be real YYYY-MM-DD dates, with from on or before to' } });
  }
  res.json({ data: await habits.listLogs(self.orgId, self.clientId, from, to) });
}));

router.get('/habits/today', validate({
  query: z.object({ date: calendarDate.optional() }),
}), wrap(async (req, res) => {
  const self = requireSelf(req, res);
  if (!self) return;
  const date = req.query.date || await habits.todayFor(self.orgId);
  res.json({ data: await habits.getLog(self.orgId, self.clientId, date) });
}));

const logSchema = {
  body: z.object({
    log_date: calendarDate.optional().nullable(),
    sleep_hours: optionalNumber({ label: 'sleep_hours', min: 0, max: 24 }),
    sleep_quality: optionalNumber({ label: 'sleep_quality', min: 1, max: 5, int: true }),
    water_ml: optionalNumber({ label: 'water_ml', min: 0, max: 15000, int: true }),
    electrolytes: z.boolean().optional().nullable(),
    steps: optionalNumber({ label: 'steps', min: 0, max: 200000, int: true }),
    stress_level: optionalNumber({ label: 'stress_level', min: 1, max: 5, int: true }),
    energy_level: optionalNumber({ label: 'energy_level', min: 1, max: 5, int: true }),
    fatigue_level: optionalNumber({ label: 'fatigue_level', min: 1, max: 5, int: true }),
    soreness_level: optionalNumber({ label: 'soreness_level', min: 1, max: 5, int: true }),
    recovery_level: optionalNumber({ label: 'recovery_level', min: 1, max: 5, int: true }),
    notes: z.string().max(2000).optional().nullable(),
  }).refine((b) => Object.keys(b).some((k) => k !== 'log_date' && b[k] != null), {
    message: 'Provide at least one journal value',
  }),
};

router.post('/habits', validate(logSchema), wrap(async (req, res) => {
  const self = requireSelf(req, res);
  if (!self) return;
  try {
    const { log_date: logDate, ...values } = req.body;
    res.json({ data: await habits.upsertLog({ ...self, logDate: logDate || null, values, userId: req.user.id }) });
  } catch (err) { fail(res, err); }
}));

router.get('/habit-preferences', wrap(async (req, res) => {
  const self = requireSelf(req, res);
  if (!self) return;
  res.json({ data: await habits.getPreferences(self.orgId, self.clientId) });
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

router.put('/habit-preferences', validate(preferenceSchema), wrap(async (req, res) => {
  const self = requireSelf(req, res);
  if (!self) return;
  try {
    res.json({ data: await habits.savePreferences(self.orgId, self.clientId, req.body) });
  } catch (err) { fail(res, err); }
}));

module.exports = router;

'use strict';
// Trainer-side booking configuration. Mounted at /api/pt-os, so the final
// paths are /api/pt-os/availability, /api/pt-os/time-off and
// /api/pt-os/booking-settings.
//
// This is the side that publishes intent: which hours are bookable, when the
// trainer is away, how long a session runs. The client side reads it through
// availability.service.js and never sees these rows directly.

const router = require('express').Router();
const crypto = require('crypto');
const pool = require('../../db/pool');
const { auth, requireTrainer } = require('../../middleware/auth');
const { orgIdOf } = require('../../lib/tenant-db');
const { resolveTrainerId } = require('../../lib/studioTrainer');
const { today } = require('../../lib/appTime');
const {
  settingsFor, toMinutes, DEFAULT_SETTINGS,
} = require('./availability.service');
const repo = require('./availability.repository');

// server.js mounts this router behind both guards; declaring them here as well
// keeps the guard attached to the router if the mount is ever edited.
router.use(auth, requireTrainer);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const bad = (res, status, code, message, extra = {}) =>
  res.status(status).json({ error: { code, message }, ...extra });

const trainerIdOf = async (req) => {
  const requested = req.query.trainer_id;
  return requested ? resolveTrainerId(pool, orgIdOf(req), requested) : req.user.trainer_id;
};

const weekdayOf = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

function windowsProblem(windows) {
  if (!Array.isArray(windows)) return { code: 'WINDOWS_INVALID', message: 'windows must be an array.' };
  for (const w of windows) {
    const weekday = Number(w && w.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      return { code: 'WINDOWS_INVALID', message: 'weekday must be 0..6.' };
    }
    if (!TIME_RE.test(w.start_time) || !TIME_RE.test(w.end_time)) {
      return { code: 'WINDOWS_INVALID', message: 'Times must be HH:MM.' };
    }
    if (toMinutes(w.end_time) <= toMinutes(w.start_time)) {
      return { code: 'WINDOWS_INVALID', message: 'A window ends before it starts.' };
    }
  }
  const sorted = [...windows].sort((a, b) => a.weekday - b.weekday || toMinutes(a.start_time) - toMinutes(b.start_time));
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].weekday === sorted[i - 1].weekday
      && toMinutes(sorted[i].start_time) < toMinutes(sorted[i - 1].end_time)) {
      return { code: 'WINDOWS_OVERLAP', message: 'Two windows on the same weekday overlap.' };
    }
  }
  return null;
}

// Upcoming sessions the new week would no longer cover. They stay booked —
// availability is intent, not a cancellation — but the trainer must see them.
function outsideWindows(sessions, windows) {
  return sessions.filter((s) => {
    const start = toMinutes(s.start_time);
    const end = s.end_time ? toMinutes(s.end_time) : start;
    return !windows.some((w) => Number(w.weekday) === weekdayOf(s.session_date)
      && toMinutes(w.start_time) <= start && toMinutes(w.end_time) >= end);
  });
}

// ─── Weekly availability ────────────────────────────────────────────────────

router.get('/availability', wrap(async (req, res) => {
  const trainerId = await trainerIdOf(req);
  if (!trainerId) return bad(res, 400, 'NO_TRAINER', 'This studio has no trainer profile.');

  const [windows, timeOff, settings] = await Promise.all([
    repo.windowsFor(orgIdOf(req), trainerId),
    repo.timeOffFor(orgIdOf(req), trainerId),
    settingsFor(orgIdOf(req), trainerId),
  ]);

  res.json({ data: { windows, timeOff, settings } });
}));

router.put('/availability', wrap(async (req, res) => {
  const trainerId = await trainerIdOf(req);
  if (!trainerId) return bad(res, 400, 'NO_TRAINER', 'This studio has no trainer profile.');

  const windows = Array.isArray(req.body.windows) ? req.body.windows : null;
  const problem = windowsProblem(windows);
  if (problem) return bad(res, 400, problem.code, problem.message);

  const orgId = orgIdOf(req);
  const booked = await repo.replaceWindows({
    orgId, trainerId, windows, since: today(),
  });
  const warnings = outsideWindows(booked, windows);

  res.json({ data: { windows, warnings } });
}));

// ─── Time off ───────────────────────────────────────────────────────────────

router.get('/time-off', wrap(async (req, res) => {
  const trainerId = await trainerIdOf(req);
  if (!trainerId) return bad(res, 400, 'NO_TRAINER', 'This studio has no trainer profile.');

  const rows = await repo.timeOffFor(orgIdOf(req), trainerId);
  res.json({ data: rows });
}));

router.post('/time-off', wrap(async (req, res) => {
  const trainerId = await trainerIdOf(req);
  if (!trainerId) return bad(res, 400, 'NO_TRAINER', 'This studio has no trainer profile.');

  const { starts_on: startsOn, ends_on: endsOn, reason } = req.body;
  if (!DATE_RE.test(startsOn || '') || !DATE_RE.test(endsOn || '') || startsOn > endsOn) {
    return bad(res, 400, 'TIME_OFF_INVALID', 'Give a valid start date and an end date on or after it.');
  }

  const orgId = orgIdOf(req);
  const conflicts = await repo.bookedBetween(orgId, trainerId, startsOn, endsOn);
  if (conflicts.length > 0) {
    return bad(res, 409, 'TIME_OFF_CONFLICT',
      'Those days already have booked sessions. Cancel or move them first.',
      { conflicts });
  }

  const created = await repo.insertTimeOff(orgId, trainerId, startsOn, endsOn, reason);
  res.status(201).json({ data: created });
}));

router.delete('/time-off/:id', wrap(async (req, res) => {
  const trainerId = await trainerIdOf(req);
  if (!trainerId) return bad(res, 400, 'NO_TRAINER', 'This studio has no trainer profile.');

  const rowCount = await repo.removeTimeOff(orgIdOf(req), trainerId, req.params.id);
  if (rowCount === 0) return bad(res, 404, 'NOT_FOUND', 'Time off not found.');
  res.json({ data: { id: req.params.id } });
}));

// ─── Booking settings ───────────────────────────────────────────────────────

const SETTING_RANGES = {
  slot_minutes: [15, 240],
  buffer_minutes: [0, 60],
  min_notice_hours: [0, 168],
  horizon_days: [1, 90],
  cancel_cutoff_hours: [0, 168],
};

router.get('/booking-settings', wrap(async (req, res) => {
  const trainerId = await trainerIdOf(req);
  if (!trainerId) return bad(res, 400, 'NO_TRAINER', 'This studio has no trainer profile.');
  const settings = await settingsFor(orgIdOf(req), trainerId);
  res.json({ data: settings });
}));

router.put('/booking-settings', wrap(async (req, res) => {
  const trainerId = await trainerIdOf(req);
  if (!trainerId) return bad(res, 400, 'NO_TRAINER', 'This studio has no trainer profile.');

  const values = {};
  for (const [key, [min, max]] of Object.entries(SETTING_RANGES)) {
    const n = Number(req.body[key]);
    if (!Number.isInteger(n) || n < min || n > max) {
      return bad(res, 400, 'SETTINGS_INVALID', `${key} must be a whole number between ${min} and ${max}.`);
    }
    values[key] = n;
  }

  const token = crypto.randomBytes(32).toString('hex');
  const saved = await repo.upsertSettings({
    orgId: orgIdOf(req), trainerId, values, token,
  });
  res.json({ data: { ...DEFAULT_SETTINGS, ...saved } });
}));

module.exports = router;

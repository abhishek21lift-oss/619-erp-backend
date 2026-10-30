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
    pool.query(
      `SELECT id, weekday, to_char(start_time, 'HH24:MI') AS start_time,
              to_char(end_time, 'HH24:MI') AS end_time
         FROM trainer_availability
        WHERE organization_id = $1 AND trainer_id = $2
        ORDER BY weekday, start_time`,
      [orgIdOf(req), trainerId],
    ),
    pool.query(
      `SELECT id, to_char(starts_on, 'YYYY-MM-DD') AS starts_on,
              to_char(ends_on, 'YYYY-MM-DD') AS ends_on, reason
         FROM trainer_time_off
        WHERE organization_id = $1 AND trainer_id = $2
        ORDER BY starts_on`,
      [orgIdOf(req), trainerId],
    ),
    settingsFor(orgIdOf(req), trainerId),
  ]);

  res.json({ data: { windows: windows.rows, timeOff: timeOff.rows, settings } });
}));

router.put('/availability', wrap(async (req, res) => {
  const trainerId = await trainerIdOf(req);
  if (!trainerId) return bad(res, 400, 'NO_TRAINER', 'This studio has no trainer profile.');

  const windows = Array.isArray(req.body.windows) ? req.body.windows : null;
  const problem = windowsProblem(windows);
  if (problem) return bad(res, 400, problem.code, problem.message);

  const orgId = orgIdOf(req);
  const client = await pool.connect();
  let warnings = [];
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM trainer_availability WHERE trainer_id = $1 AND organization_id = $2',
      [trainerId, orgId],
    );
    for (const w of windows) {
      await client.query(
        `INSERT INTO trainer_availability
           (organization_id, trainer_id, weekday, start_time, end_time)
         VALUES ($1, $2, $3, $4, $5)`,
        [orgId, trainerId, Number(w.weekday), w.start_time, w.end_time],
      );
    }
    const booked = await client.query(
      `SELECT id, to_char(session_date, 'YYYY-MM-DD') AS session_date,
              to_char(start_time, 'HH24:MI') AS start_time,
              to_char(end_time, 'HH24:MI') AS end_time
         FROM pt_sessions
        WHERE organization_id = $1 AND trainer_id = $2
          AND deleted_at IS NULL AND status = 'scheduled'
          AND start_time IS NOT NULL AND session_date >= $3
        ORDER BY session_date, start_time`,
      [orgId, trainerId, today()],
    );
    warnings = outsideWindows(booked.rows, windows);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  res.json({ data: { windows, warnings } });
}));

// ─── Time off ───────────────────────────────────────────────────────────────

router.get('/time-off', wrap(async (req, res) => {
  const trainerId = await trainerIdOf(req);
  if (!trainerId) return bad(res, 400, 'NO_TRAINER', 'This studio has no trainer profile.');

  const { rows } = await pool.query(
    `SELECT id, to_char(starts_on, 'YYYY-MM-DD') AS starts_on,
            to_char(ends_on, 'YYYY-MM-DD') AS ends_on, reason
       FROM trainer_time_off
      WHERE organization_id = $1 AND trainer_id = $2
      ORDER BY starts_on`,
    [orgIdOf(req), trainerId],
  );
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
  const booked = await pool.query(
    `SELECT id, to_char(session_date, 'YYYY-MM-DD') AS session_date,
            to_char(start_time, 'HH24:MI') AS start_time
       FROM pt_sessions
      WHERE organization_id = $1 AND trainer_id = $2
        AND deleted_at IS NULL AND status = 'scheduled'
        AND session_date BETWEEN $3 AND $4
      ORDER BY session_date, start_time`,
    [orgId, trainerId, startsOn, endsOn],
  );
  if (booked.rows.length > 0) {
    return bad(res, 409, 'TIME_OFF_CONFLICT',
      'Those days already have booked sessions. Cancel or move them first.',
      { conflicts: booked.rows });
  }

  const { rows } = await pool.query(
    `INSERT INTO trainer_time_off (organization_id, trainer_id, starts_on, ends_on, reason)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, to_char(starts_on, 'YYYY-MM-DD') AS starts_on,
               to_char(ends_on, 'YYYY-MM-DD') AS ends_on, reason`,
    [orgId, trainerId, startsOn, endsOn, reason || null],
  );
  res.status(201).json({ data: rows[0] });
}));

router.delete('/time-off/:id', wrap(async (req, res) => {
  const trainerId = await trainerIdOf(req);
  if (!trainerId) return bad(res, 400, 'NO_TRAINER', 'This studio has no trainer profile.');

  const { rowCount } = await pool.query(
    'DELETE FROM trainer_time_off WHERE id = $1 AND trainer_id = $2 AND organization_id = $3',
    [req.params.id, trainerId, orgIdOf(req)],
  );
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

  // The token is minted on insert only: a feed URL must survive every later
  // settings change, because the trainer has already subscribed to it.
  const token = crypto.randomBytes(32).toString('hex');
  const { rows } = await pool.query(
    `INSERT INTO trainer_booking_settings
       (organization_id, trainer_id, slot_minutes, buffer_minutes, min_notice_hours,
        horizon_days, cancel_cutoff_hours, ics_token)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (organization_id, trainer_id) DO UPDATE SET
       slot_minutes = EXCLUDED.slot_minutes,
       buffer_minutes = EXCLUDED.buffer_minutes,
       min_notice_hours = EXCLUDED.min_notice_hours,
       horizon_days = EXCLUDED.horizon_days,
       cancel_cutoff_hours = EXCLUDED.cancel_cutoff_hours,
       updated_at = NOW()
     RETURNING slot_minutes, buffer_minutes, min_notice_hours, horizon_days,
               cancel_cutoff_hours, ics_token`,
    [
      orgIdOf(req), trainerId,
      values.slot_minutes, values.buffer_minutes, values.min_notice_hours,
      values.horizon_days, values.cancel_cutoff_hours, token,
    ],
  );
  res.json({ data: { ...DEFAULT_SETTINGS, ...rows[0] } });
}));

module.exports = router;

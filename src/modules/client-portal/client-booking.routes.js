'use strict';
// The client's own booking surface. Mounted at /api/me behind auth +
// requireClient.
//
// Same rule as client-portal.routes.js: the client id comes from
// req.user.pt_client_id and is never read from the request. The trainer is
// looked up from the client row, also never from the request.
//
// The free-slot list is advisory; the partial unique index in migration 245 is
// what actually prevents two sessions in one hour. A lost race surfaces here as
// 409 SLOT_TAKEN, and a failed reschedule leaves the original row untouched
// because the UPDATE is the only write and it either succeeds or does not.

const router = require('express').Router();
const pool = require('../../db/pool');
const { auth, requireClient } = require('../../middleware/auth');
const { orgIdOf } = require('../../lib/tenant-db');
const { checkTrainingEligibility } = require('../../lib/screeningGate');
const {
  freeSlots, slotIsFree, settingsFor, istNow, toMinutes, toTime,
} = require('../pt-os/availability.service');

router.use(auth, requireClient);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (s) => DATE_RE.test(s || '') && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

const bad = (res, status, code, message, extra = {}) =>
  res.status(status).json({ error: { code, message }, ...extra });

const SESSION_COLUMNS = `id, to_char(session_date, 'YYYY-MM-DD') AS session_date,
  to_char(start_time, 'HH24:MI') AS start_time,
  to_char(end_time, 'HH24:MI') AS end_time,
  duration_minutes, status`;

const clientIdOf = (req) => req.user.pt_client_id;

async function trainerOf(req) {
  const { rows } = await pool.query(
    `SELECT trainer_id FROM pt_clients
      WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
    [clientIdOf(req), orgIdOf(req)],
  );
  return rows[0] ? rows[0].trainer_id : null;
}

// Minutes from "now" in IST wall time until a stored date/start. Negative for
// a session already under way, which counts as inside every cutoff.
function minutesUntil(date, start, now = istNow()) {
  const days = Math.round(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${now.date}T00:00:00Z`)) / 86400000,
  );
  return days * 1440 + toMinutes(start) - now.minutes;
}

const withinCutoff = (date, start, cutoffHours, now = istNow()) =>
  minutesUntil(date, start, now) <= cutoffHours * 60;

async function eligibilityBlock(req, res) {
  const { blocked } = await checkTrainingEligibility(req, clientIdOf(req), { action: 'book_session' });
  if (!blocked) return false;
  const { code, error, missing } = blocked.body;
  res.status(blocked.status).json({ error: { code, message: error, ...(missing ? { missing } : {}) } });
  return true;
}

const shape = (row, cutoffHours) => ({
  ...row,
  can_cancel: row.status === 'scheduled' && !withinCutoff(row.session_date, row.start_time, cutoffHours),
});

// ─── Availability ───────────────────────────────────────────────────────────

router.get('/booking/availability', wrap(async (req, res) => {
  if (!clientIdOf(req)) return bad(res, 403, 'NO_CLIENT', 'This account is not linked to a client.');
  const trainerId = await trainerOf(req);
  if (!trainerId) return bad(res, 409, 'NO_TRAINER', 'Your trainer has not set up a profile yet.');

  const { days, settings } = await freeSlots(orgIdOf(req), trainerId, { days: req.query.days });
  res.json({
    data: {
      days,
      settings: {
        slot_minutes: settings.slot_minutes,
        cancel_cutoff_hours: settings.cancel_cutoff_hours,
        horizon_days: settings.horizon_days,
      },
    },
  });
}));

// ─── My sessions ────────────────────────────────────────────────────────────

router.get('/booking', wrap(async (req, res) => {
  if (!clientIdOf(req)) return bad(res, 403, 'NO_CLIENT', 'This account is not linked to a client.');
  const orgId = orgIdOf(req);
  const settings = await settingsFor(orgId, (await trainerOf(req)) || '');

  const { rows } = await pool.query(
    `SELECT ${SESSION_COLUMNS} FROM pt_sessions
      WHERE client_id = $1 AND organization_id = $2
        AND deleted_at IS NULL AND status = 'scheduled'
        AND session_date >= $3
      ORDER BY session_date, start_time`,
    [clientIdOf(req), orgId, istNow().date],
  );
  res.json({ data: rows.map((r) => shape(r, settings.cancel_cutoff_hours)) });
}));

// ─── Book ───────────────────────────────────────────────────────────────────

router.post('/booking', wrap(async (req, res) => {
  if (!clientIdOf(req)) return bad(res, 403, 'NO_CLIENT', 'This account is not linked to a client.');
  const { date, start } = req.body;
  if (!isDate(date) || !TIME_RE.test(start || '')) {
    return bad(res, 400, 'VALIDATION', 'Give a real date (YYYY-MM-DD) and a start time (HH:MM).');
  }

  const orgId = orgIdOf(req);
  const trainerId = await trainerOf(req);
  if (!trainerId) return bad(res, 409, 'NO_TRAINER', 'Your trainer has not set up a profile yet.');

  if (await eligibilityBlock(req, res)) return undefined;

  const settings = await settingsFor(orgId, trainerId);
  if (!(await slotIsFree(orgId, trainerId, date, start))) {
    return bad(res, 400, 'OUTSIDE_AVAILABILITY', 'That time is not open for booking.');
  }

  const endTime = toTime(toMinutes(start) + settings.slot_minutes);
  try {
    const { rows } = await pool.query(
      `INSERT INTO pt_sessions
         (client_id, trainer_id, title, session_date, start_time, end_time,
          duration_minutes, created_by, session_type, organization_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${SESSION_COLUMNS}`,
      [
        clientIdOf(req), trainerId, 'PT Session', date, start, endTime,
        settings.slot_minutes, req.user.id, '1-on-1', orgId,
      ],
    );
    return res.status(201).json({ data: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return bad(res, 409, 'SLOT_TAKEN', 'Someone took that time a moment ago. Pick another slot.');
    }
    throw err;
  }
}));

// ─── Reschedule ─────────────────────────────────────────────────────────────

router.patch('/booking/:id', wrap(async (req, res) => {
  if (!clientIdOf(req)) return bad(res, 403, 'NO_CLIENT', 'This account is not linked to a client.');
  const { date, start } = req.body;
  if (!isDate(date) || !TIME_RE.test(start || '')) {
    return bad(res, 400, 'VALIDATION', 'Give a real date (YYYY-MM-DD) and a start time (HH:MM).');
  }

  const orgId = orgIdOf(req);
  const { rows: existing } = await pool.query(
    `SELECT ${SESSION_COLUMNS} FROM pt_sessions
      WHERE id = $1 AND client_id = $2 AND organization_id = $3 AND deleted_at IS NULL`,
    [req.params.id, clientIdOf(req), orgId],
  );
  const current = existing[0];
  if (!current) return bad(res, 404, 'NOT_FOUND', 'Booking not found.');
  if (current.status !== 'scheduled') {
    return bad(res, 409, 'NOT_SCHEDULED', 'Only a scheduled session can be moved.');
  }

  const trainerId = await trainerOf(req);
  if (!trainerId) return bad(res, 409, 'NO_TRAINER', 'Your trainer has not set up a profile yet.');
  const settings = await settingsFor(orgId, trainerId);
  if (withinCutoff(current.session_date, current.start_time, settings.cancel_cutoff_hours)) {
    return bad(res, 409, 'RESCHEDULE_CUTOFF_PASSED',
      'This session is too close to move. Message your trainer.');
  }

  if (await eligibilityBlock(req, res)) return undefined;

  if (!(await slotIsFree(orgId, trainerId, date, start, { excludeSessionId: current.id }))) {
    return bad(res, 409, 'SLOT_TAKEN', 'That time is not available. Pick another slot.');
  }

  const endTime = toTime(toMinutes(start) + settings.slot_minutes);
  try {
    const { rows } = await pool.query(
      `UPDATE pt_sessions
          SET session_date = $1, start_time = $2, end_time = $3,
              duration_minutes = $4, updated_at = NOW()
        WHERE id = $5 AND client_id = $6 AND organization_id = $7 AND deleted_at IS NULL
        RETURNING ${SESSION_COLUMNS}`,
      [date, start, endTime, settings.slot_minutes, current.id, clientIdOf(req), orgId],
    );
    return res.json({ data: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return bad(res, 409, 'SLOT_TAKEN', 'Someone took that time a moment ago. Pick another slot.');
    }
    throw err;
  }
}));

// ─── Cancel ─────────────────────────────────────────────────────────────────

router.delete('/booking/:id', wrap(async (req, res) => {
  if (!clientIdOf(req)) return bad(res, 403, 'NO_CLIENT', 'This account is not linked to a client.');
  const orgId = orgIdOf(req);

  const { rows } = await pool.query(
    `SELECT ${SESSION_COLUMNS} FROM pt_sessions
      WHERE id = $1 AND client_id = $2 AND organization_id = $3 AND deleted_at IS NULL`,
    [req.params.id, clientIdOf(req), orgId],
  );
  const current = rows[0];
  if (!current) return bad(res, 404, 'NOT_FOUND', 'Booking not found.');
  if (current.status !== 'scheduled') {
    return bad(res, 409, 'NOT_SCHEDULED', 'Only a scheduled session can be cancelled.');
  }

  const settings = await settingsFor(orgId, await trainerOf(req));
  if (withinCutoff(current.session_date, current.start_time, settings.cancel_cutoff_hours)) {
    return bad(res, 409, 'CANCEL_CUTOFF_PASSED',
      'This session is too close to cancel. Message your trainer.');
  }

  await pool.query(
    `UPDATE pt_sessions SET status = 'cancelled', updated_at = NOW()
      WHERE id = $1 AND client_id = $2 AND organization_id = $3 AND status = 'scheduled'`,
    [current.id, clientIdOf(req), orgId],
  );
  res.json({ data: { id: current.id, status: 'cancelled' } });
}));

module.exports = router;

'use strict';
// Data access for the trainer's booking configuration (availability.routes.js)
// and the read-only calendar feed built from it (calendar-feed.js). Both are
// adapters; the SQL lives here.

const pool = require('../../db/pool');

async function windowsFor(orgId, trainerId) {
  const { rows } = await pool.query(
    `SELECT id, weekday, to_char(start_time, 'HH24:MI') AS start_time,
            to_char(end_time, 'HH24:MI') AS end_time
       FROM trainer_availability
      WHERE organization_id = $1 AND trainer_id = $2
      ORDER BY weekday, start_time`,
    [orgId, trainerId],
  );
  return rows;
}

async function timeOffFor(orgId, trainerId) {
  const { rows } = await pool.query(
    `SELECT id, to_char(starts_on, 'YYYY-MM-DD') AS starts_on,
            to_char(ends_on, 'YYYY-MM-DD') AS ends_on, reason
       FROM trainer_time_off
      WHERE organization_id = $1 AND trainer_id = $2
      ORDER BY starts_on`,
    [orgId, trainerId],
  );
  return rows;
}

/**
 * Replace the whole week in one transaction, and return the booked sessions
 * the new week would leave outside its windows. They stay booked —
 * availability is intent, not a cancellation — but the trainer must see them.
 */
async function replaceWindows({
  orgId, trainerId, windows, since,
}) {
  const client = await pool.connect();
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
      [orgId, trainerId, since],
    );
    await client.query('COMMIT');
    return booked.rows;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Scheduled sessions between two dates, enough to refuse a time-off range. */
async function bookedBetween(orgId, trainerId, from, to) {
  const { rows } = await pool.query(
    `SELECT id, to_char(session_date, 'YYYY-MM-DD') AS session_date,
            to_char(start_time, 'HH24:MI') AS start_time
       FROM pt_sessions
      WHERE organization_id = $1 AND trainer_id = $2
        AND deleted_at IS NULL AND status = 'scheduled'
        AND session_date BETWEEN $3 AND $4
      ORDER BY session_date, start_time`,
    [orgId, trainerId, from, to],
  );
  return rows;
}

async function insertTimeOff(orgId, trainerId, startsOn, endsOn, reason) {
  const { rows } = await pool.query(
    `INSERT INTO trainer_time_off (organization_id, trainer_id, starts_on, ends_on, reason)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, to_char(starts_on, 'YYYY-MM-DD') AS starts_on,
               to_char(ends_on, 'YYYY-MM-DD') AS ends_on, reason`,
    [orgId, trainerId, startsOn, endsOn, reason || null],
  );
  return rows[0];
}

async function removeTimeOff(orgId, trainerId, id) {
  const { rowCount } = await pool.query(
    'DELETE FROM trainer_time_off WHERE id = $1 AND trainer_id = $2 AND organization_id = $3',
    [id, trainerId, orgId],
  );
  return rowCount;
}

/**
 * Save settings, minting ics_token only on first insert. A feed URL must
 * survive every later settings change, because the trainer has already
 * subscribed to it.
 */
async function upsertSettings({
  orgId, trainerId, values, token,
}) {
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
      orgId, trainerId,
      values.slot_minutes, values.buffer_minutes, values.min_notice_hours,
      values.horizon_days, values.cancel_cutoff_hours, token,
    ],
  );
  return rows[0];
}

/** The studio and trainer a calendar feed token belongs to, or null. */
async function settingsByToken(token) {
  const { rows } = await pool.query(
    'SELECT organization_id, trainer_id FROM trainer_booking_settings WHERE ics_token = $1',
    [token],
  );
  return rows[0] || null;
}

/** The next 90 days of scheduled sessions for one trainer's feed. */
async function feedSessions(orgId, trainerId) {
  const { rows } = await pool.query(
    `SELECT id, title, to_char(session_date, 'YYYY-MM-DD') AS session_date,
            to_char(start_time, 'HH24:MI') AS start_time,
            to_char(end_time, 'HH24:MI') AS end_time
       FROM pt_sessions
      WHERE organization_id = $1 AND trainer_id = $2
        AND deleted_at IS NULL AND status = 'scheduled'
        AND start_time IS NOT NULL
        AND session_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 90
      ORDER BY session_date, start_time`,
    [orgId, trainerId],
  );
  return rows;
}

module.exports = {
  windowsFor, timeOffFor, replaceWindows, bookedBetween,
  insertTimeOff, removeTimeOff, upsertSettings, settingsByToken, feedSessions,
};

'use strict';
// Free slots are what the trainer intends to work (weekly windows) minus what
// is already booked (scheduled sessions) minus time off. Derived on every read
// so a cancelled session frees its hour immediately and nothing has to be
// regenerated when availability changes.
//
// Dates and times are IST wall-clock strings ('YYYY-MM-DD', 'HH:MM') end to
// end. Nothing in this module converts a stored value; the only "now" it reads
// is converted into IST once, in istNow().

const pool = require('../../db/pool');

const DEFAULT_SETTINGS = {
  slot_minutes: 60,
  buffer_minutes: 0,
  min_notice_hours: 12,
  horizon_days: 30,
  cancel_cutoff_hours: 12,
};

const toMinutes = (t) => {
  const [h, m] = String(t).slice(0, 5).split(':').map(Number);
  return h * 60 + m;
};

const toTime = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

const addDays = (date, n) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

const weekdayOf = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

// Shortcut: IST only. Add a timezone column to trainer_booking_settings when
// the product sells outside India.
const istNow = () => {
  const ist = new Date(Date.now() + 330 * 60 * 1000);
  return {
    date: ist.toISOString().slice(0, 10),
    minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes(),
  };
};

// Pure. Every input is a plain string/number; see freeSlots for the queries.
function computeSlots({
  availability, timeOff, sessions, fromDate, days, settings, nowDate, nowMinutes,
}) {
  const { slot_minutes: slot, buffer_minutes: buffer = 0, min_notice_hours: notice } = settings;
  const out = [];

  for (let i = 0; i < days; i += 1) {
    const date = addDays(fromDate, i);
    const weekday = weekdayOf(date);
    const off = timeOff.some((t) => String(t.starts_on) <= date && date <= String(t.ends_on));
    const windows = off ? [] : availability.filter((a) => Number(a.weekday) === weekday);

    const busy = sessions
      .filter((s) => String(s.session_date).slice(0, 10) === date && s.start_time && s.end_time)
      .map((s) => [toMinutes(s.start_time), toMinutes(s.end_time) + buffer]);

    const slots = [];
    for (const w of windows) {
      const windowEnd = toMinutes(w.end_time);
      for (let start = toMinutes(w.start_time); start + slot <= windowEnd; start += slot) {
        if (date === nowDate && start < nowMinutes + notice * 60) continue;
        if (busy.some(([from, to]) => start < to && from < start + slot)) continue;
        slots.push({ start: toTime(start), end: toTime(start + slot) });
      }
    }
    slots.sort((a, b) => a.start.localeCompare(b.start));
    out.push({ date, slots });
  }
  return out;
}

async function settingsFor(orgId, trainerId) {
  const { rows } = await pool.query(
    `SELECT slot_minutes, buffer_minutes, min_notice_hours, horizon_days,
            cancel_cutoff_hours, ics_token
       FROM trainer_booking_settings
      WHERE organization_id = $1 AND trainer_id = $2`,
    [orgId, trainerId],
  );
  return { ...DEFAULT_SETTINGS, ...(rows[0] || {}) };
}

async function freeSlots(orgId, trainerId, { days, excludeSessionId = null } = {}) {
  const settings = await settingsFor(orgId, trainerId);
  const now = istNow();
  const count = Math.min(Math.max(parseInt(days, 10) || settings.horizon_days, 1), settings.horizon_days);
  const toDate = addDays(now.date, count - 1);

  const [windows, off, sessions] = await Promise.all([
    pool.query(
      `SELECT weekday,
              to_char(start_time, 'HH24:MI') AS start_time,
              to_char(end_time, 'HH24:MI') AS end_time
         FROM trainer_availability
        WHERE organization_id = $1 AND trainer_id = $2
        ORDER BY weekday, start_time`,
      [orgId, trainerId],
    ),
    pool.query(
      `SELECT to_char(starts_on, 'YYYY-MM-DD') AS starts_on,
              to_char(ends_on, 'YYYY-MM-DD') AS ends_on
         FROM trainer_time_off
        WHERE organization_id = $1 AND trainer_id = $2
          AND ends_on >= $3 AND starts_on <= $4`,
      [orgId, trainerId, now.date, toDate],
    ),
    pool.query(
      `SELECT to_char(session_date, 'YYYY-MM-DD') AS session_date,
              to_char(start_time, 'HH24:MI') AS start_time,
              to_char(end_time, 'HH24:MI') AS end_time
         FROM pt_sessions
        WHERE organization_id = $1 AND trainer_id = $2
          AND deleted_at IS NULL AND status = 'scheduled'
          AND start_time IS NOT NULL AND end_time IS NOT NULL
          AND session_date BETWEEN $3 AND $4
          AND ($5::text IS NULL OR id <> $5)`,
      [orgId, trainerId, now.date, toDate, excludeSessionId],
    ),
  ]);

  return {
    days: computeSlots({
      availability: windows.rows,
      timeOff: off.rows,
      sessions: sessions.rows,
      fromDate: now.date,
      days: count,
      settings,
      nowDate: now.date,
      nowMinutes: now.minutes,
    }),
    settings,
  };
}

// Authoritative for "may this client take this slot". Recomputing from
// freeSlots keeps availability, notice, horizon and time off in one place; the
// unique index in migration 245 still decides the simultaneous-request race.
async function slotIsFree(orgId, trainerId, date, startTime, { excludeSessionId = null } = {}) {
  const { days } = await freeSlots(orgId, trainerId, { excludeSessionId });
  const day = days.find((d) => d.date === String(date));
  return Boolean(day && day.slots.some((s) => s.start === String(startTime).slice(0, 5)));
}

module.exports = {
  computeSlots, freeSlots, settingsFor, slotIsFree, istNow, toMinutes, toTime, DEFAULT_SETTINGS,
};

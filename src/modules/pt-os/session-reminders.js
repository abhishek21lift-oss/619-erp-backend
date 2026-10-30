'use strict';
// The 15-minute clock behind session reminders.
//
// Two reminders per session: 24 hours out ("tomorrow") and 2 hours out ("in
// 2 hours"). Both are in-app notifications that every client gets; WhatsApp is
// left entirely to the automation engine, which no-ops for a studio with
// automation off, no matching rule, or an opted-out client.
//
// That is why this file never asks which studios have automation enabled. It
// scans scheduled sessions, writes one notification row per session and bucket,
// and hands the same fact to triggers.sessionReminderFor. A studio that never
// opened Automation still gets the bell.
//
// Idempotent by construction: the notification INSERT uses NOT EXISTS on
// (user_id, type, ref_id), and emit's eventKey is the session id plus bucket.

const pool = require('../../db/pool');
const triggers = require('../automation/automation.triggers');

const BUCKETS = [
  { bucket: '24h', hours: 24, when: 'tomorrow' },
  { bucket: '2h', hours: 2, when: 'in 2 hours' },
];

// The scheduler runs every 15 minutes, so each run owns a 15-minute slice of
// reminder targets. A session enters exactly one slice and never re-enters it.
const WINDOW_MINUTES = 15;

const pad = (n) => String(n).padStart(2, '0');

// IST wall-clock string. Shortcut: IST only, matching availability.service.js;
// add a timezone column when the product leaves India.
// (Date.now() + 330 min) read with UTC getters is IST with no DST to worry about.
function istWall(addMinutes) {
  const d = new Date(Date.now() + 330 * 60 * 1000 + addMinutes * 60000);
  return `${d.toISOString().slice(0, 10)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

const SESSIONS_SQL = `
  SELECT s.id, s.organization_id, s.client_id, c.name,
         to_char(s.session_date, 'YYYY-MM-DD') AS session_date,
         to_char(s.start_time, 'HH24:MI') AS start_time,
         u.id AS user_id
    FROM pt_sessions s
    JOIN pt_clients c ON c.id = s.client_id
    JOIN users u ON u.pt_client_id = c.id
                AND u.is_active = TRUE AND u.deleted_at IS NULL
   WHERE s.status = 'scheduled' AND s.deleted_at IS NULL
     AND s.start_time IS NOT NULL
     AND (s.session_date + s.start_time) >= $1::timestamp
     AND (s.session_date + s.start_time) <  $2::timestamp
   ORDER BY s.session_date, s.start_time`;

const NOTIFY_SQL = `
  INSERT INTO notifications (user_id, type, title, body, link, ref_id)
  SELECT $1, 'session_reminder', $2, $3, '/member/book', $4
   WHERE NOT EXISTS (
     SELECT 1 FROM notifications
      WHERE user_id = $1 AND type = 'session_reminder' AND ref_id = $4
   )`;

async function runSessionReminders() {
  const orgs = new Set();
  let sent = 0;
  let skipped = 0;

  for (const { bucket, hours, when } of BUCKETS) {
    const from = istWall(hours * 60);
    const to = istWall(hours * 60 + WINDOW_MINUTES);
    const { rows } = await pool.query(SESSIONS_SQL, [from, to]);

    for (const row of rows) {
      const title = bucket === '24h' ? 'Session tomorrow' : 'Session in 2 hours';
      const body = `Your PT session is on ${row.session_date} at ${row.start_time}.`;

      const { rowCount } = await pool.query(NOTIFY_SQL, [row.user_id, title, body, row.id]);
      if (rowCount === 0) {
        skipped += 1;
        continue; // already reminded in this window
      }

      sent += 1;
      orgs.add(row.organization_id);
      await triggers.sessionReminderFor(row.organization_id, {
        clientId: row.client_id,
        sessionId: row.id,
        date: row.session_date,
        time: row.start_time,
        when,
        name: row.name,
        bucket,
      });
    }
  }

  return { orgs: orgs.size, sent, skipped };
}

module.exports = { runSessionReminders, BUCKETS, WINDOW_MINUTES };

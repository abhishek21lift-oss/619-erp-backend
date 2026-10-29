'use strict';
// Alert silences: planned maintenance, and "we know, stop paging us".
//
// A silence suppresses NOTIFICATION, never detection. The alert still opens,
// still escalates and still appears in the console — a window that also stopped
// detection would hide the new failure it happened to overlap, which is the one
// thing a maintenance window must not do.
//
// `source` is a card name, or null for every source. Matching is exact rather
// than a pattern: a typo in a LIKE pattern silently silences everything, and
// the failure direction of a silence is already "too quiet".

const pool = require('../../db/pool');

const MIN_MINUTES = 5;
const MAX_MINUTES = 30 * 24 * 60;

/** Windows in force at `at`, soonest-expiring first. */
async function active(at = new Date()) {
  const { rows } = await pool.query(
    `SELECT id, source, reason, starts_at, ends_at, created_by
       FROM alert_silences
      WHERE cancelled_at IS NULL
        AND starts_at <= $1
        AND ends_at > $1
      ORDER BY ends_at ASC`,
    [at],
  );
  return rows;
}

/** True when any window covers this card. A null source covers everything. */
function covers(silences, source) {
  return silences.some((s) => !s.source || s.source === source);
}

async function create({ source = null, reason, minutes, by = null }) {
  const { rows } = await pool.query(
    `INSERT INTO alert_silences (source, reason, ends_at, created_by)
     VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval, $4)
     RETURNING id, source, reason, starts_at, ends_at, created_by`,
    [source, reason, String(minutes), by],
  );
  return rows[0];
}

/** Cancel without erasing the window that was planned. */
async function cancel(id, by = null) {
  const { rows } = await pool.query(
    `UPDATE alert_silences
        SET cancelled_at = NOW(), cancelled_by = $2
      WHERE id = $1 AND cancelled_at IS NULL
      RETURNING id, source, reason, starts_at, ends_at, created_by, cancelled_at`,
    [id, by],
  );
  return rows[0] ?? null;
}

module.exports = { active, covers, create, cancel, MIN_MINUTES, MAX_MINUTES };

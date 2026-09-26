'use strict';
// The workout-log rules that more than one writer needs.
//
// The trainer's workout log (workout-log.routes.js) and the member app's
// self-logged workouts (client-portal/member-training.service.js) both write
// sets and complete sessions. A personal best, and a plan's progress, must
// mean the same thing whichever of them wrote the row — so the rules live
// here, once.

const pool = require('../../db/pool');
const { today: studioToday } = require('../../lib/appTime');

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

class SessionStartError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') { super(message); this.status = status; this.code = code; }
}

/** 'YYYY-MM-DD' from a request value, or null when it is not one. */
function requestDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  if (!m || Number.isNaN(Date.parse(`${m[1]}T00:00:00Z`))) return undefined;
  return m[1];
}

/** 'Monday' … 'Sunday' for a 'YYYY-MM-DD'. */
function weekdayOf(ymd) {
  const dow = (new Date(`${ymd}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = Monday
  return WEEKDAYS[dow];
}

/**
 * Start a trainer-logged session, or hand back the one already open.
 *
 * The date is the STUDIO's today, not the database server's CURRENT_DATE:
 * the server runs in UTC, so a 5 am session in India was filed under the day
 * before — and landed in last week's adherence when that day was a Sunday.
 *
 * Starting is idempotent per client, day and programme. Two taps on Start, or
 * the Today list and the schedule both open on the gym floor, used to create
 * two logs for one workout; production had sixteen client-days like that. An
 * open (in_progress) log for the same client, date and assignment is resumed
 * instead, under a per-client lock so two concurrent starts cannot both
 * insert.
 *
 * `assignmentId`:
 *   undefined → link the programme the client is on for that day
 *   null      → freestyle, deliberately unlinked
 *   string    → that assignment, which must be this client's, in this studio
 *
 * @returns {Promise<{ session: object, resumed: boolean }>}
 */
async function startSession({ orgId, userId, clientId, sessionDate, programName, workoutDay, notes, assignmentId }) {
  const date = requestDate(sessionDate);
  if (date === undefined) throw new SessionStartError('session_date must be a date (YYYY-MM-DD).');
  const day = date || studioToday();

  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`workout-session:${clientId}:${day}`]);

    let linked = null;
    if (typeof assignmentId === 'string' && assignmentId) {
      // An explicit id was trusted as sent. It is what the session detail then
      // reads a plan through, so an id from another client — or another studio
      // — put that programme on this client's log.
      const { rows } = await tx.query(
        `SELECT id FROM workout_assignments WHERE id = $1 AND client_id = $2 AND organization_id = $3`,
        [assignmentId, clientId, orgId]
      );
      if (!rows[0]) throw new SessionStartError('That programme is not assigned to this client.', 404, 'NOT_FOUND');
      linked = rows[0].id;
    } else if (assignmentId === undefined) {
      // The same choice the Today roster makes: an assignment live on this
      // date, preferring one that prescribes this weekday, then the newest.
      // "Exactly one active, else nothing" left a client on an upper/lower
      // split with an unlinked log — no planned workout, no progress.
      const { rows } = await tx.query(
        `SELECT a.id
           FROM workout_assignments a
          WHERE a.client_id = $1 AND a.organization_id = $2 AND a.status = 'active'
            AND a.start_date <= $3::date AND (a.end_date IS NULL OR a.end_date >= $3::date)
          ORDER BY (EXISTS (SELECT 1 FROM workout_exercises we
                             WHERE we.workout_plan_id = a.workout_plan_id
                               AND we.day_of_week = EXTRACT(ISODOW FROM $3::date)::int)) DESC,
                   a.start_date DESC, a.created_at DESC
          LIMIT 1`,
        [clientId, orgId, day]
      );
      linked = rows[0]?.id ?? null;
    }

    const { rows: open } = await tx.query(
      `SELECT * FROM workout_sessions
        WHERE client_id = $1 AND organization_id = $2 AND session_date = $3::date
          AND status = 'in_progress' AND workout_assignment_id IS NOT DISTINCT FROM $4
        ORDER BY created_at DESC LIMIT 1`,
      [clientId, orgId, day, linked]
    );
    if (open[0]) {
      await tx.query('COMMIT');
      return { session: open[0], resumed: true };
    }

    // A linked session with no day named gets the date's weekday, so the log
    // opens on that day's planned workout instead of an empty one.
    const dayName = workoutDay || (linked ? weekdayOf(day) : null);
    const { rows } = await tx.query(
      `INSERT INTO workout_sessions (
         client_id, trainer_id, workout_assignment_id, session_date, program_name, workout_day, notes, created_by, organization_id
       ) VALUES ($1, (SELECT trainer_id FROM pt_clients WHERE id = $1 AND organization_id = $8), $2, $3::date, $4, $5, $6, $7, $8)
       RETURNING *`,
      [clientId, linked, day, programName || null, dayName, notes || null, userId, orgId]
    );
    await tx.query('COMMIT');
    return { session: rows[0], resumed: false };
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}

/**
 * Finish the sessions a trainer left open.
 *
 * "Finish workout" is the only thing that completes a trainer-logged session,
 * and it is easy to walk away from: production had 78 of 133 sessions still
 * in progress, days or weeks later. A programme's progress and a client's
 * adherence count COMPLETED sessions only, so every one of those was a workout
 * the client did that the app said they had missed.
 *
 * A log from an earlier day with at least one set marked done is a workout
 * that happened, so it is completed. A log with nothing done is left alone —
 * that is the trainer's to delete, not ours to count.
 *
 * @returns {Promise<number>} sessions closed
 */
async function closeStaleSessions(orgId = null, db = pool) {
  const { rows } = await db.query(
    `UPDATE workout_sessions ws
        SET status = 'completed', updated_at = NOW()
      WHERE ws.status = 'in_progress'
        AND ws.session_date < $1::date
        AND ($2::uuid IS NULL OR ws.organization_id = $2::uuid)
        AND EXISTS (SELECT 1 FROM workout_session_exercises wse
                      JOIN workout_sets s ON s.session_exercise_id = wse.id
                     WHERE wse.session_id = ws.id AND s.completed = true)
      RETURNING ws.workout_assignment_id, ws.organization_id`,
    [studioToday(), orgId]
  );
  const touched = new Map();
  for (const r of rows) if (r.workout_assignment_id) touched.set(r.workout_assignment_id, r.organization_id);
  for (const [assignmentId, org] of touched) await recomputeAssignmentProgress(assignmentId, org, db);
  return rows.length;
}

// Recomputes a linked assignment's progress_pct from how many distinct
// completed sessions have been logged against it, relative to the plan's
// target (sessions_per_week * duration_weeks). The only writer of
// progress_pct outside the trainer's manual PUT /assignments/:id/progress.
//
// Scoped to the studio as well as the id: the callers have already checked
// the assignment is theirs, and this keeps it that way if one ever does not.
async function recomputeAssignmentProgress(assignmentId, orgId, db = pool) {
  if (!assignmentId) return;
  const { rows } = await db.query(
    `SELECT wp.sessions_per_week, wp.duration_weeks,
            (SELECT COUNT(DISTINCT ws.id) FROM workout_sessions ws
              WHERE ws.workout_assignment_id = wa.id AND ws.status = 'completed') AS completed_count
       FROM workout_assignments wa
       JOIN workout_plans wp ON wp.id = wa.workout_plan_id
      WHERE wa.id = $1 AND wa.organization_id = $2`,
    [assignmentId, orgId]
  );
  const row = rows[0];
  if (!row) return;
  const target = (row.sessions_per_week || 0) * (row.duration_weeks || 0);
  const pct = target > 0 ? Math.min(100, Math.round((row.completed_count / target) * 100)) : 0;
  await db.query(
    'UPDATE workout_assignments SET progress_pct = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3',
    [pct, assignmentId, orgId]
  );
}

// Never trust a client-submitted "is this a PR" flag — always recompute
// against the client's prior completed sets for the same exercise
// (matched by exercise_id when the exercise is in the library, else by
// name for ad-hoc entries). The name match ignores case and surrounding
// spaces, the way records and streaks group exercises: "Back Squat" and
// "back squat " are one lift, and an exact match made the second spelling
// read as a first-ever set — a personal best on every set.
//
// A record needs a history to break. The first time a client does a lift —
// every set of that first session — is their baseline, not a personal best:
// flagging it made 31% of all logged sets in production "PRs", so a trainer's
// PR timeline was mostly first attempts. With `sessionId`, a set is a record
// only when this lift was also done in an EARLIER session; later sets in the
// same session can still beat that history and are flagged as they do.
async function computePrFlags(client, { clientId, orgId, exerciseId, exerciseName, weight, reps, excludeSetId = null, sessionId = null }) {
  const none = { is_pr_weight: false, is_pr_reps: false, is_pr_volume: false };
  if (weight == null || reps == null) return none;

  const matchClause = exerciseId ? 'wse.exercise_id = $3' : 'lower(btrim(wse.exercise_name)) = lower(btrim($3))';
  const matchParam = exerciseId || exerciseName;
  const params = [clientId, orgId, matchParam];
  let excludeClause = '';
  if (excludeSetId) { params.push(excludeSetId); excludeClause = `AND s.id != $${params.length}`; }
  params.push(sessionId);
  const sessionParam = `$${params.length}`;

  const { rows } = await client.query(
    `SELECT MAX(s.weight_kg) AS max_weight, MAX(s.reps) AS max_reps, MAX(s.weight_kg * s.reps) AS max_volume,
            COALESCE(bool_or(${sessionParam}::text IS NULL OR ws.id::text <> ${sessionParam}::text), false) AS has_history
       FROM workout_sets s
       JOIN workout_session_exercises wse ON wse.id = s.session_exercise_id
       JOIN workout_sessions ws ON ws.id = wse.session_id
      WHERE ws.client_id = $1 AND ws.organization_id = $2 AND ${matchClause} AND s.completed = true ${excludeClause}`,
    params
  );
  const prev = rows[0] || {};
  if (!prev.has_history) return none;
  const volume = weight * reps;
  return {
    is_pr_weight: prev.max_weight == null || weight > Number(prev.max_weight),
    is_pr_reps: prev.max_reps == null || reps > Number(prev.max_reps),
    is_pr_volume: prev.max_volume == null || volume > Number(prev.max_volume),
  };
}

module.exports = {
  recomputeAssignmentProgress, computePrFlags, startSession, closeStaleSessions, SessionStartError,
  // exported for tests
  requestDate, weekdayOf,
};

'use strict';
// Guided workout: a member logs a workout they did on their own.
//
// ── One request, one finished session ─────────────────────────────────────
//
// The trainer's workout log builds a session up set by set, and a session the
// trainer never taps Finish on stays `in_progress` forever — 78 of 133 in
// production. The member app does not repeat that: the workout is kept on the
// phone while it happens and arrives here once, finished, in one transaction.
// There is no half-logged member session for anybody to forget.
//
// A phone on gym wifi retries. `request_id` (the app's idempotency key) makes
// a retry return the session the first attempt created.
//
// ── The same rules as the trainer's log ───────────────────────────────────
//
// Personal bests and plan progress come from pt-os/workout-log.service, the
// code the trainer's log uses, so a PR means one thing whoever logged it.
// Sessions are marked source = 'member' so the trainer can tell them apart.
//
// Same identity rule as the rest of client-portal: clientId/orgId are the
// session's, never the request's.

const pool = require('../../db/pool');
const { today } = require('../../lib/appTime');
const logger = require('../../lib/logger');
const { computePrFlags, recomputeAssignmentProgress } = require('../pt-os/workout-log.service');

class TrainingInputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const MAX_EXERCISES = 30;
const MAX_SETS = 20;
const DAILY_LIMIT = 4;
const NAME_MAX = 120;

const key = (name) => String(name).trim().toLowerCase();

function boundedNumber(v, min, max, field, { integer = false } = {}) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw new TrainingInputError(`${field} must be ${integer ? 'a whole number' : 'a number'} between ${min} and ${max}`);
  }
  return n;
}

/** Validate and trim the finished workout. Throws TrainingInputError. */
function normaliseWorkout(body = {}) {
  const requestId = typeof body.request_id === 'string' ? body.request_id.trim() : '';
  if (!/^[A-Za-z0-9-]{8,64}$/.test(requestId)) throw new TrainingInputError('request_id is required');

  const text = (v, max) => {
    if (v === null || v === undefined) return null;
    const t = String(v).trim().slice(0, max);
    return t || null;
  };

  if (!Array.isArray(body.exercises) || body.exercises.length === 0) {
    throw new TrainingInputError('Log at least one exercise');
  }
  if (body.exercises.length > MAX_EXERCISES) throw new TrainingInputError(`At most ${MAX_EXERCISES} exercises`);

  const exercises = body.exercises.map((x, i) => {
    const name = text(x?.name, NAME_MAX);
    if (!name) throw new TrainingInputError(`Exercise ${i + 1} needs a name`);
    const rawSets = Array.isArray(x.sets) ? x.sets : [];
    if (rawSets.length > MAX_SETS) throw new TrainingInputError(`At most ${MAX_SETS} sets per exercise`);
    const sets = rawSets.map((s) => ({
      weight_kg: boundedNumber(s?.weight_kg, 0, 1000, 'Weight'),
      reps: boundedNumber(s?.reps, 0, 1000, 'Reps', { integer: true }),
      duration_seconds: boundedNumber(s?.duration_seconds, 0, 6 * 3600, 'Duration', { integer: true }),
    })).filter((s) => (s.reps !== null && s.reps > 0) || (s.duration_seconds !== null && s.duration_seconds > 0));
    return { name, sets };
  }).filter((x) => x.sets.length > 0);

  if (exercises.length === 0) throw new TrainingInputError('Log at least one set');

  return {
    requestId,
    exercises,
    assignmentId: text(body.assignment_id, 64),
    programName: text(body.program_name, 255),
    workoutDay: text(body.workout_day, 255),
    durationMinutes: boundedNumber(body.duration_minutes, 1, 300, 'Duration', { integer: true }),
  };
}

/**
 * What the member did last time for each named exercise: the sets of the most
 * recent session that had any, and the heaviest completed set ever.
 * Keyed by the lower-cased, trimmed name, the way the app looks them up.
 */
async function lastPerformance(clientId, orgId, names) {
  const keys = [...new Set((names || []).map(key).filter(Boolean))].slice(0, MAX_EXERCISES);
  if (keys.length === 0) return {};

  const { rows } = await pool.query(
    `SELECT lower(btrim(e.exercise_name)) AS k, ws.id AS session_id, ws.session_date,
            s.set_number, s.weight_kg, s.reps, s.duration_seconds
       FROM workout_sets s
       JOIN workout_session_exercises e ON e.id = s.session_exercise_id
       JOIN workout_sessions ws ON ws.id = e.session_id
      WHERE ws.client_id = $1 AND ws.organization_id = $2
        AND lower(btrim(e.exercise_name)) = ANY($3::text[])
        AND s.completed IS NOT FALSE
      ORDER BY ws.session_date DESC, ws.created_at DESC, s.set_number NULLS LAST
      LIMIT 3000`,
    [clientId, orgId, keys],
  );

  const out = {};
  for (const r of rows) {
    let entry = out[r.k];
    if (!entry) {
      entry = { date: r.session_date, session_id: r.session_id, sets: [], best_kg: null };
      out[r.k] = entry;
    }
    if (r.session_id === entry.session_id) {
      entry.sets.push({
        weight_kg: r.weight_kg === null ? null : Number(r.weight_kg),
        reps: r.reps,
        duration_seconds: r.duration_seconds,
      });
    }
    if (r.weight_kg !== null && (entry.best_kg === null || Number(r.weight_kg) > entry.best_kg)) {
      entry.best_kg = Number(r.weight_kg);
    }
  }
  for (const entry of Object.values(out)) delete entry.session_id;
  return out;
}

/** Sessions of either source for this client today — the member's daily cap. */
async function memberSessionsToday(clientId, orgId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM workout_sessions
      WHERE client_id = $1 AND organization_id = $2 AND source = 'member' AND session_date = $3`,
    [clientId, orgId, today()],
  );
  return rows[0].n;
}

/** The session a request id already produced, with its summary — or null. */
async function existingByRequest(clientId, orgId, requestId) {
  const { rows } = await pool.query(
    `SELECT id FROM workout_sessions
      WHERE client_id = $1 AND organization_id = $2 AND client_request_id = $3`,
    [clientId, orgId, requestId],
  );
  return rows[0] ? summary(rows[0].id) : null;
}

/** Totals and new personal bests for one session, as the finish screen shows them. */
async function summary(sessionId, db = pool) {
  const { rows } = await db.query(
    `SELECT e.exercise_name, s.weight_kg, s.reps, s.is_pr_weight, s.is_pr_reps, s.is_pr_volume
       FROM workout_session_exercises e
       JOIN workout_sets s ON s.session_exercise_id = e.id
      WHERE e.session_id = $1
      ORDER BY e.sort_order, s.set_number`,
    [sessionId],
  );
  const prs = [];
  let volume = 0;
  for (const r of rows) {
    if (r.weight_kg !== null && r.reps !== null) volume += Number(r.weight_kg) * r.reps;
    if (r.is_pr_weight || r.is_pr_reps || r.is_pr_volume) {
      prs.push({
        exercise: r.exercise_name,
        weight_kg: r.weight_kg === null ? null : Number(r.weight_kg),
        reps: r.reps,
        kind: r.is_pr_weight ? 'weight' : r.is_pr_reps ? 'reps' : 'volume',
      });
    }
  }
  return {
    session_id: sessionId,
    sets: rows.length,
    exercises: new Set(rows.map((r) => r.exercise_name)).size,
    volume_kg: Math.round(volume),
    prs,
  };
}

/**
 * Save a finished member workout. Returns { created, summary }.
 * `created` is false when the request id was already used (a retry).
 */
async function logMyWorkout(clientId, orgId, userId, body) {
  const w = normaliseWorkout(body);

  const prior = await existingByRequest(clientId, orgId, w.requestId);
  if (prior) return { created: false, summary: prior };

  if (await memberSessionsToday(clientId, orgId) >= DAILY_LIMIT) {
    throw new TrainingInputError('You have already logged several workouts today. Talk to your trainer if this one is missing.', 429);
  }

  const tx = await pool.connect();
  let sessionId;
  let assignmentId = null;
  try {
    await tx.query('BEGIN');

    if (w.assignmentId) {
      const { rows } = await tx.query(
        `SELECT id FROM workout_assignments
          WHERE id = $1 AND client_id = $2 AND organization_id = $3 AND status = 'active'`,
        [w.assignmentId, clientId, orgId],
      );
      assignmentId = rows[0]?.id ?? null;
    }

    const { rows: created } = await tx.query(
      `INSERT INTO workout_sessions (
         client_id, trainer_id, workout_assignment_id, session_date, program_name, workout_day,
         duration_minutes, status, source, client_request_id, created_by, organization_id
       ) VALUES ($1, (SELECT trainer_id FROM pt_clients WHERE id = $1 AND organization_id = $2),
                 $3, $4, $5, $6, $7, 'completed', 'member', $8, $9, $2)
       ON CONFLICT (client_id, client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [clientId, orgId, assignmentId, today(), w.programName, w.workoutDay, w.durationMinutes, w.requestId, userId],
    );
    if (!created[0]) {
      // A concurrent retry won the race; hand back what it created.
      await tx.query('ROLLBACK');
      return { created: false, summary: await existingByRequest(clientId, orgId, w.requestId) };
    }
    sessionId = created[0].id;

    // Library ids for exercises this client has logged before, so a PR is
    // matched the way the trainer's log matches it (by id when there is one).
    const { rows: known } = await tx.query(
      `SELECT DISTINCT ON (lower(btrim(e.exercise_name))) lower(btrim(e.exercise_name)) AS k, e.exercise_id
         FROM workout_session_exercises e
         JOIN workout_sessions ws ON ws.id = e.session_id
        WHERE ws.client_id = $1 AND ws.organization_id = $2 AND e.exercise_id IS NOT NULL
          AND lower(btrim(e.exercise_name)) = ANY($3::text[])
        ORDER BY lower(btrim(e.exercise_name)), ws.session_date DESC`,
      [clientId, orgId, w.exercises.map((x) => key(x.name))],
    );
    const idOf = new Map(known.map((r) => [r.k, r.exercise_id]));

    for (const [i, x] of w.exercises.entries()) {
      const exerciseId = idOf.get(key(x.name)) ?? null;
      const { rows: ex } = await tx.query(
        `INSERT INTO workout_session_exercises (session_id, exercise_id, exercise_name, sort_order)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [sessionId, exerciseId, x.name, i],
      );
      for (const [j, s] of x.sets.entries()) {
        // Sequential on purpose: each set is compared with the ones before it,
        // including earlier sets of this same workout.
        const flags = await computePrFlags(tx, {
          clientId, orgId, exerciseId, exerciseName: x.name, weight: s.weight_kg, reps: s.reps,
        });
        await tx.query(
          `INSERT INTO workout_sets (
             session_exercise_id, set_number, weight_kg, reps, duration_seconds, completed,
             is_pr_weight, is_pr_reps, is_pr_volume
           ) VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7, $8)`,
          [ex[0].id, j + 1, s.weight_kg, s.reps, s.duration_seconds,
            flags.is_pr_weight, flags.is_pr_reps, flags.is_pr_volume],
        );
      }
    }

    await recomputeAssignmentProgress(assignmentId, orgId, tx);
    await tx.query('COMMIT');
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      return { created: false, summary: await existingByRequest(clientId, orgId, w.requestId) };
    }
    throw err;
  } finally {
    tx.release();
  }

  const result = await summary(sessionId);
  await notifyTrainer(clientId, orgId, result).catch((err) =>
    logger.warn({ err: err.message, clientId }, 'member workout: trainer notification failed'));
  return { created: true, summary: result };
}

/**
 * Tell the studio's trainer the member trained on their own, with what they
 * did. Same recipient rule as progress photos: the studio's active trainer
 * login(s).
 */
async function notifyTrainer(clientId, orgId, s) {
  const prs = s.prs.length ? `, ${s.prs.length} personal best${s.prs.length === 1 ? '' : 's'}` : '';
  const body = `${s.exercises} exercise${s.exercises === 1 ? '' : 's'}, ${s.sets} set${s.sets === 1 ? '' : 's'}${prs}.`;
  await pool.query(
    `INSERT INTO notifications (user_id, type, title, body, link)
     SELECT u.id, 'member_workout', COALESCE(c.name, 'A member') || ' logged a workout', $3,
            '/pt-os/clients/' || c.id || '/workout-log'
       FROM pt_clients c
       JOIN users u ON u.organization_id = c.organization_id AND u.role = 'trainer'
                   AND u.is_active = TRUE AND u.deleted_at IS NULL
      WHERE c.id = $1 AND c.organization_id = $2`,
    [clientId, orgId, body],
  );
}

module.exports = {
  TrainingInputError,
  normaliseWorkout,
  lastPerformance,
  logMyWorkout,
  DAILY_LIMIT,
};

// Session lifecycle: create, start, log, complete.
//
// The routes below this are thin on purpose — they validate, authorise, and
// call in here. Everything that spans more than one table, or that has to be
// all-or-nothing, lives in this file inside a transaction.
//
// ── Completing a workout ───────────────────────────────────────────────────
//
// The one operation with a real failure story. Completing a session marks it
// done, stamps its duration, closes the assignment and detects records. The
// first three must be atomic; the fourth must NOT be able to fail the other
// three.
//
// A client who has just finished training must never be told their workout
// failed to save because a personal-record calculation threw. So records are
// computed after the transaction commits, and a failure there is logged and
// swallowed. The session is complete either way; the PR shows up or it does
// not.
'use strict';

const pool = require('../../db/pool');
const logger = require('../../lib/logger');
const { logActivity } = require('../../lib/activityLog');
const { checkScreeningGate } = require('../../lib/screeningGate');
const { orgIdOf } = require('../../lib/tenant-db');
const authz = require('./authz');
const records = require('./records');
const volume = require('./volume');

/** Thrown by services; the route turns `status`/`code` into a response. */
class TrainingError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

// ── Create ─────────────────────────────────────────────────────────────────

/**
 * Start a session record. Does not start the clock — see startSession.
 *
 * Two behaviours carried over deliberately from the old workout-log route,
 * because both were right:
 *
 *   · the same screening gate. Logging a session IS training, so an explicit
 *     PAR-Q block refuses it and missing paperwork only warns.
 *   · auto-linking the client's single active assignment when the caller
 *     omitted the field entirely. An explicit null means "freestyle, not the
 *     assigned workout" and is honoured, so "didn't say" and "said no" stay
 *     distinguishable.
 */
async function createSession(req, body) {
  if (!await authz.canAccessClient(req, body.client_id)) {
    throw new TrainingError(404, 'CLIENT_NOT_FOUND', 'Client not found');
  }

  const { blocked, warnings } = await checkScreeningGate(req, body.client_id);
  if (blocked) {
    throw new TrainingError(blocked.status, blocked.body?.error?.code || 'SCREENING_BLOCKED',
      blocked.body?.error?.message || 'Screening gate refused this session',
      { body: blocked.body });
  }

  let assignmentId = body.assignment_id;
  if (assignmentId === undefined) {
    const params = [body.client_id];
    const org = authz.orgWhere(req, params);
    const { rows } = await pool.query(
      `SELECT id FROM training_assignments
        WHERE client_id = $1 AND status IN ('ASSIGNED','SCHEDULED','IN_PROGRESS')${org}`,
      params
    );
    // Exactly one, or none. Two open assignments is a genuine ambiguity and
    // guessing between them would attach the session to the wrong programme.
    assignmentId = rows.length === 1 ? rows[0].id : null;
  }

  let templateId = body.workout_template_id ?? null;
  let templateName = null;
  if (!templateId && assignmentId) {
    const a = await authz.loadOwned(req, 'training_assignments', assignmentId);
    if (a) templateId = a.workout_template_id;
  }
  if (templateId) {
    const t = await authz.loadOwned(req, 'workout_templates', templateId);
    if (!t) throw new TrainingError(404, 'TEMPLATE_NOT_FOUND', 'Workout template not found');
    templateName = t.name;
  }

  const { rows } = await pool.query(
    `INSERT INTO training_sessions
       (organization_id, client_id, trainer_id, assignment_id, workout_template_id,
        template_name, session_date, status, created_by)
     VALUES ($1, $2, COALESCE($3, (SELECT trainer_id FROM pt_clients WHERE id = $2)),
             $4, $5, $6, COALESCE($7::date, CURRENT_DATE), 'NOT_STARTED', $8)
     RETURNING *`,
    [orgIdOf(req), body.client_id, body.trainer_id ?? null, assignmentId, templateId,
     templateName, body.session_date ?? null, req.user.id]
  );

  await logActivity(req, 'training.session.create', 'training_sessions', rows[0].id,
    { client_id: body.client_id }).catch(() => {});
  return { session: rows[0], screening_warnings: warnings };
}

/**
 * Seed a session's exercises from the template it was created against.
 *
 * Copies the prescription onto each performance so the session shows targets
 * without joining back — and so a later edit to the template does not rewrite
 * what this session was asked to do.
 */
async function seedFromTemplate(req, sessionId) {
  const session = await authz.loadSession(req, sessionId);
  if (!session) throw new TrainingError(404, 'SESSION_NOT_FOUND', 'Session not found');
  if (!session.workout_template_id) return { seeded: 0 };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      `INSERT INTO exercise_performances
         (session_id, exercise_id, template_exercise_id, exercise_name, section, order_index)
       SELECT $1, wte.exercise_id, wte.id, COALESCE(e.name, 'Exercise'), wte.section, wte.order_index
         FROM workout_template_exercises wte
         LEFT JOIN exercises e ON e.id = wte.exercise_id
        WHERE wte.workout_template_id = $2
          AND NOT EXISTS (
            SELECT 1 FROM exercise_performances ep
             WHERE ep.session_id = $1 AND ep.template_exercise_id = wte.id)
        ORDER BY wte.section, wte.order_index`,
      [sessionId, session.workout_template_id]
    );
    await client.query('COMMIT');
    return { seeded: rowCount };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function startSession(req, sessionId) {
  const session = await authz.loadSession(req, sessionId);
  if (!session) throw new TrainingError(404, 'SESSION_NOT_FOUND', 'Session not found');
  if (session.status === 'COMPLETED') {
    throw new TrainingError(409, 'SESSION_COMPLETED', 'This session is already complete');
  }
  // Idempotent: tapping Start twice must not reset the clock and lose the
  // first minutes of the workout.
  const { rows } = await pool.query(
    `UPDATE training_sessions
        SET status = 'IN_PROGRESS',
            started_at = COALESCE(started_at, NOW()),
            updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [sessionId]
  );
  await pool.query(
    `UPDATE training_assignments SET status = 'IN_PROGRESS', updated_at = NOW()
      WHERE id = $1 AND status IN ('ASSIGNED','SCHEDULED')`,
    [session.assignment_id]
  ).catch(() => {});
  return rows[0];
}

// ── Logging ────────────────────────────────────────────────────────────────

/**
 * Insert-or-return for an idempotency token.
 *
 * ON CONFLICT DO NOTHING then SELECT, rather than DO UPDATE: a retry means
 * "did my first write land", and the honest answer is the row that landed.
 * Overwriting it would let a stale retry, sent after the trainer corrected
 * the number, silently undo the correction.
 */
async function insertIdempotent(table, cols, values, token, client = pool) {
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await client.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})
     ON CONFLICT DO NOTHING RETURNING *`,
    values
  );
  if (rows[0]) return { row: rows[0], duplicate: false };
  if (!token) throw new TrainingError(409, 'CONFLICT', 'Could not write this row');
  const { rows: existing } = await client.query(
    `SELECT * FROM ${table} WHERE client_token = $1`, [token]
  );
  if (!existing[0]) throw new TrainingError(409, 'CONFLICT', 'Could not write this row');
  return { row: existing[0], duplicate: true };
}

async function logSet(req, performanceId, body) {
  const perf = await authz.loadPerformance(req, performanceId);
  if (!perf) throw new TrainingError(404, 'PERFORMANCE_NOT_FOUND', 'Exercise performance not found');
  if (perf.session_status === 'COMPLETED') {
    throw new TrainingError(409, 'SESSION_COMPLETED', 'This session is complete — reopen it to edit');
  }

  const cols = ['exercise_performance_id', 'set_number', 'set_type', 'planned_reps', 'actual_reps',
    'planned_weight', 'actual_weight', 'weight_unit', 'planned_rpe', 'actual_rpe',
    'planned_rir', 'actual_rir', 'tempo', 'rest_seconds', 'duration_seconds',
    'completed', 'failure', 'notes', 'client_token'];
  const values = [performanceId, body.set_number, body.set_type ?? 'WORKING',
    body.planned_reps ?? null, body.actual_reps ?? null,
    body.planned_weight ?? null, body.actual_weight ?? null, body.weight_unit ?? 'kg',
    body.planned_rpe ?? null, body.actual_rpe ?? null,
    body.planned_rir ?? null, body.actual_rir ?? null,
    body.tempo ?? null, body.rest_seconds ?? null, body.duration_seconds ?? null,
    body.completed ?? false, body.failure ?? false, body.notes ?? null,
    body.client_token ?? null];

  const out = await insertIdempotent('set_performances', cols, values, body.client_token);
  await pool.query(
    `UPDATE exercise_performances SET status = 'IN_PROGRESS', updated_at = NOW()
      WHERE id = $1 AND status = 'PENDING'`, [performanceId]
  ).catch(() => {});
  return out;
}

async function logCardio(req, performanceId, body) {
  const perf = await authz.loadPerformance(req, performanceId);
  if (!perf) throw new TrainingError(404, 'PERFORMANCE_NOT_FOUND', 'Exercise performance not found');
  if (perf.session_status === 'COMPLETED') {
    throw new TrainingError(409, 'SESSION_COMPLETED', 'This session is complete — reopen it to edit');
  }

  const cols = ['exercise_performance_id', 'cardio_type', 'duration_seconds', 'distance',
    'distance_unit', 'average_speed', 'max_speed', 'speed_unit', 'incline', 'resistance',
    'average_heart_rate', 'max_heart_rate', 'calories_burned', 'pace_seconds', 'pace_distance',
    'cadence', 'elevation_gain', 'work_interval_seconds', 'rest_interval_seconds',
    'rounds_completed', 'rpe', 'completed', 'notes', 'client_token'];
  const values = [performanceId, body.cardio_type ?? 'OTHER', body.duration_seconds ?? null,
    body.distance ?? null, body.distance_unit ?? null, body.average_speed ?? null,
    body.max_speed ?? null, body.speed_unit ?? null, body.incline ?? null, body.resistance ?? null,
    body.average_heart_rate ?? null, body.max_heart_rate ?? null, body.calories_burned ?? null,
    body.pace_seconds ?? null, body.pace_distance ?? null, body.cadence ?? null,
    body.elevation_gain ?? null, body.work_interval_seconds ?? null,
    body.rest_interval_seconds ?? null, body.rounds_completed ?? null, body.rpe ?? null,
    body.completed ?? false, body.notes ?? null, body.client_token ?? null];

  const out = await insertIdempotent('cardio_performances', cols, values, body.client_token);
  await pool.query(
    `UPDATE exercise_performances SET status = 'IN_PROGRESS', updated_at = NOW()
      WHERE id = $1 AND status = 'PENDING'`, [performanceId]
  ).catch(() => {});
  return out;
}

// ── Completion ─────────────────────────────────────────────────────────────

/** Everything logged in a session, shaped for volume.sessionSummary(). */
async function loadPerformances(sessionId, client = pool) {
  const { rows } = await client.query(
    `SELECT ep.id, ep.exercise_id, ep.exercise_name,
            COALESCE((SELECT json_agg(sp.* ORDER BY sp.set_number)
                        FROM set_performances sp
                       WHERE sp.exercise_performance_id = ep.id), '[]'::json) AS sets,
            COALESCE((SELECT json_agg(cp.*)
                        FROM cardio_performances cp
                       WHERE cp.exercise_performance_id = ep.id), '[]'::json) AS cardio
       FROM exercise_performances ep
      WHERE ep.session_id = $1
      ORDER BY ep.order_index`,
    [sessionId]
  );
  return rows;
}

/**
 * Detect and persist records for a finished session.
 *
 * Called AFTER the completion transaction commits, and every caller wraps it
 * in a catch. See the file header: a record calculation must not be able to
 * fail a workout that has already happened.
 */
async function detectRecords(req, session, performances) {
  const written = [];
  for (const perf of performances) {
    const candidates = [
      ...records.candidatesFromSets(perf.sets || []),
      ...(perf.cardio || []).flatMap((c) => records.candidatesFromCardio(c)),
    ];
    if (!candidates.length) continue;

    const { rows: current } = await pool.query(
      `SELECT record_type, reps, value FROM personal_records
        WHERE client_id = $1 AND exercise_id = $2 AND superseded_at IS NULL`,
      [session.client_id, perf.exercise_id]
    );
    const held = new Map(current.map((r) => [
      records.recordKey({ record_type: r.record_type, reps: r.reps }), Number(r.value),
    ]));

    for (const win of records.selectImprovements(candidates, held)) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Supersede first: the partial unique index allows exactly one live
        // record per key, so inserting before superseding would collide.
        await client.query(
          `UPDATE personal_records SET superseded_at = NOW()
            WHERE client_id = $1 AND exercise_id = $2 AND record_type = $3
              AND COALESCE(reps, -1) = COALESCE($4::smallint, -1) AND superseded_at IS NULL`,
          [session.client_id, perf.exercise_id, win.record_type, win.reps ?? null]
        );
        const { rows } = await client.query(
          `INSERT INTO personal_records
             (organization_id, client_id, exercise_id, exercise_name, record_type,
              value, unit, reps, session_id, exercise_performance_id,
              set_performance_id, cardio_performance_id, achieved_on)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
          [session.organization_id, session.client_id, perf.exercise_id, perf.exercise_name,
           win.record_type, win.value, win.unit ?? null, win.reps ?? null, session.id, perf.id,
           win.set_performance_id ?? null, win.cardio_performance_id ?? null, session.session_date]
        );
        await client.query('COMMIT');
        written.push(rows[0]);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        logger.warn({ err: err.message, session: session.id, exercise: perf.exercise_id },
          'training: personal record write failed');
      } finally {
        client.release();
      }
    }
  }
  return written;
}

async function completeSession(req, sessionId, body = {}) {
  const session = await authz.loadSession(req, sessionId);
  if (!session) throw new TrainingError(404, 'SESSION_NOT_FOUND', 'Session not found');

  const client = await pool.connect();
  let completed;
  try {
    await client.query('BEGIN');
    // Re-read FOR UPDATE inside the transaction: two devices tapping Complete
    // at once must not both compute a duration and both close the assignment.
    const { rows: locked } = await client.query(
      'SELECT * FROM training_sessions WHERE id = $1 FOR UPDATE', [sessionId]
    );
    if (locked[0]?.status === 'COMPLETED') {
      await client.query('ROLLBACK');
      // Idempotent rather than an error: the second tap should show the
      // summary, not a failure.
      return { session: locked[0], summary: null, records: [], already_complete: true };
    }

    const { rows } = await client.query(
      `UPDATE training_sessions
          SET status = 'COMPLETED',
              completed_at = NOW(),
              started_at = COALESCE(started_at, NOW()),
              duration_seconds = COALESCE(
                $2::int,
                GREATEST(0, EXTRACT(EPOCH FROM (NOW() - COALESCE(started_at, NOW())))::int)),
              overall_rpe  = COALESCE($3, overall_rpe),
              client_notes = COALESCE($4, client_notes),
              trainer_notes = COALESCE($5, trainer_notes),
              updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [sessionId, body.duration_seconds ?? null, body.overall_rpe ?? null,
       body.client_notes ?? null, body.trainer_notes ?? null]
    );
    completed = rows[0];

    if (completed.assignment_id) {
      await client.query(
        `UPDATE training_assignments SET status = 'COMPLETED', updated_at = NOW()
          WHERE id = $1`, [completed.assignment_id]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const performances = await loadPerformances(sessionId);
  const summary = volume.sessionSummary(performances, {
    durationSeconds: completed.duration_seconds,
  });

  // Deliberately outside the transaction, and deliberately swallowed.
  let prs = [];
  try {
    prs = await detectRecords(req, completed, performances);
  } catch (err) {
    logger.error({ err: err.message, session: sessionId },
      'training: PR detection failed — session stays complete');
  }

  await logActivity(req, 'training.session.complete', 'training_sessions', sessionId,
    { client_id: completed.client_id, prs: prs.length }).catch(() => {});

  return { session: completed, summary, records: prs, already_complete: false };
}

module.exports = {
  TrainingError,
  createSession, seedFromTemplate, startSession,
  logSet, logCardio, completeSession,
  loadPerformances, detectRecords,
};

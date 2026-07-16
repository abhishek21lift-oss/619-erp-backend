// src/modules/pt-os/workout-log.routes.js
// Workout Log — logging what a client actually performed in a session
// (as opposed to workout_plans/workout_exercises, which are prescribed
// templates, or workout_assignments, which just tracks which plan a
// client is on). See migration 068 for the schema rationale.
//
// Mounted at /api/pt-os, so final paths are /api/pt-os/workout-log/...
// Conventions follow informed-consent.routes.js / parq.routes.js: a
// shared wrap() for async error handling, auth + requireRole on writes
// (staff-operated app, no separate client login), logActivity for the
// audit trail, and server-computed derived fields never trusted from
// the client (here: PR flags and workout summary totals).
const router = require('express').Router();
const pool = require('../../db/pool');
const { auth } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { validate } = require('../../middleware/validate');
const { z } = require('../../lib/validation');
const { logActivity } = require('../../lib/activityLog');
const { calc1RM } = require('../progress/fitness-scoring');
const { checkScreeningGate } = require('../../lib/screeningGate');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const numOpt = () => z.coerce.number().optional().nullable();

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// Recomputes a linked assignment's progress_pct from how many distinct
// completed sessions have been logged against it, relative to the plan's
// target (sessions_per_week * duration_weeks). The only writer of
// progress_pct outside the trainer's manual PUT /assignments/:id/progress.
async function recomputeAssignmentProgress(assignmentId) {
  if (!assignmentId) return;
  const { rows } = await pool.query(
    `SELECT wp.sessions_per_week, wp.duration_weeks,
            (SELECT COUNT(DISTINCT ws.id) FROM workout_sessions ws
              WHERE ws.workout_assignment_id = wa.id AND ws.status = 'completed') AS completed_count
       FROM workout_assignments wa
       JOIN workout_plans wp ON wp.id = wa.workout_plan_id
      WHERE wa.id = $1`,
    [assignmentId]
  );
  const row = rows[0];
  if (!row) return;
  const target = (row.sessions_per_week || 0) * (row.duration_weeks || 0);
  const pct = target > 0 ? Math.min(100, Math.round((row.completed_count / target) * 100)) : 0;
  await pool.query('UPDATE workout_assignments SET progress_pct = $1, updated_at = NOW() WHERE id = $2', [pct, assignmentId]);
}

// ─── Schemas ────────────────────────────────────────────────

const sessionCreateSchema = {
  body: z.object({
    client_id: z.string(),
    session_date: z.string().optional().nullable(),
    program_name: z.string().max(255).optional().nullable(),
    workout_day: z.string().max(255).optional().nullable(),
    workout_assignment_id: z.string().optional().nullable(),
    notes: z.string().max(2000).optional().nullable(),
  }),
};

const sessionUpdateSchema = {
  body: z.object({
    session_date: z.string().optional(),
    program_name: z.string().max(255).optional().nullable(),
    workout_day: z.string().max(255).optional().nullable(),
    notes: z.string().max(2000).optional().nullable(),
    duration_minutes: numOpt(),
    status: z.enum(['in_progress', 'completed']).optional(),
  }),
};

const exerciseAddSchema = {
  body: z.object({
    exercise_id: z.string().optional().nullable(),
    exercise_name: z.string().min(1).max(255),
    notes: z.string().max(1000).optional().nullable(),
  }),
};

const setCreateSchema = {
  body: z.object({
    set_number: z.coerce.number().int().min(1),
    weight_kg: numOpt(),
    reps: z.coerce.number().int().optional().nullable(),
    rpe: numOpt(),
    rir: z.coerce.number().int().optional().nullable(),
    tempo: z.string().max(20).optional().nullable(),
    rest_seconds: z.coerce.number().int().optional().nullable(),
    completed: z.boolean().optional(),
    notes: z.string().max(500).optional().nullable(),
  }),
};

const setUpdateSchema = {
  body: z.object({
    weight_kg: numOpt(),
    reps: z.coerce.number().int().optional().nullable(),
    rpe: numOpt(),
    rir: z.coerce.number().int().optional().nullable(),
    tempo: z.string().max(20).optional().nullable(),
    rest_seconds: z.coerce.number().int().optional().nullable(),
    completed: z.boolean().optional(),
    notes: z.string().max(500).optional().nullable(),
  }),
};

// ─── Helpers ────────────────────────────────────────────────

// Never trust a client-submitted "is this a PR" flag — always recompute
// against the client's prior completed sets for the same exercise
// (matched by exercise_id when the exercise is in the library, else by
// exact exercise_name for ad-hoc entries).
async function computePrFlags(client, clientId, exerciseId, exerciseName, weight, reps, excludeSetId) {
  if (weight == null || reps == null) return { is_pr_weight: false, is_pr_reps: false, is_pr_volume: false };

  const matchClause = exerciseId ? 'wse.exercise_id = $2' : 'wse.exercise_name = $2';
  const matchParam = exerciseId || exerciseName;
  const params = [clientId, matchParam];
  let excludeClause = '';
  if (excludeSetId) { params.push(excludeSetId); excludeClause = `AND s.id != $${params.length}`; }

  const { rows } = await client.query(
    `SELECT MAX(s.weight_kg) AS max_weight, MAX(s.reps) AS max_reps, MAX(s.weight_kg * s.reps) AS max_volume
       FROM workout_sets s
       JOIN workout_session_exercises wse ON wse.id = s.session_exercise_id
       JOIN workout_sessions ws ON ws.id = wse.session_id
      WHERE ws.client_id = $1 AND ${matchClause} AND s.completed = true ${excludeClause}`,
    params
  );
  const prev = rows[0] || {};
  const volume = weight * reps;
  return {
    is_pr_weight: prev.max_weight == null || weight > Number(prev.max_weight),
    is_pr_reps: prev.max_reps == null || reps > Number(prev.max_reps),
    is_pr_volume: prev.max_volume == null || volume > Number(prev.max_volume),
  };
}

// ─── Sessions ───────────────────────────────────────────────

// GET /workout-log/sessions?client_id=&limit=&offset=
router.get('/workout-log/sessions', auth, wrap(async (req, res) => {
  const { client_id, limit, offset } = req.query;
  if (!client_id) return res.status(400).json({ error: { code: 'MISSING_CLIENT_ID' } });
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const off = Math.max(parseInt(offset, 10) || 0, 0);

  const { rows } = await pool.query(
    `SELECT ws.*,
            (SELECT COUNT(*) FROM workout_session_exercises wse WHERE wse.session_id = ws.id) AS exercise_count,
            (SELECT COUNT(*) FROM workout_sets s
               JOIN workout_session_exercises wse ON wse.id = s.session_exercise_id
              WHERE wse.session_id = ws.id AND s.completed = true) AS completed_set_count
       FROM workout_sessions ws
      WHERE ws.client_id = $1
      ORDER BY ws.session_date DESC, ws.created_at DESC
      LIMIT $2 OFFSET $3`,
    [client_id, lim, off]
  );
  res.json({ data: rows });
}));

// GET /workout-log/sessions/:id — full detail with exercises + sets + computed summary.
router.get('/workout-log/sessions/:id', auth, wrap(async (req, res) => {
  const { id } = req.params;
  const [sessionRes, exercisesRes] = await Promise.all([
    pool.query('SELECT * FROM workout_sessions WHERE id = $1', [id]),
    pool.query(
      `SELECT wse.*, COALESCE(
                (SELECT json_agg(s.* ORDER BY s.set_number)
                   FROM workout_sets s WHERE s.session_exercise_id = wse.id),
                '[]'
              ) AS sets
         FROM workout_session_exercises wse
        WHERE wse.session_id = $1
        ORDER BY wse.sort_order, wse.created_at`,
      [id]
    ),
  ]);
  const session = sessionRes.rows[0];
  if (!session) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
  const exercises = exercisesRes.rows;

  // "Planned for today": when this session is linked to an active plan
  // assignment, show what the plan prescribes for the matching day-of-week
  // so the trainer can compare/load it in without re-typing the program.
  let planned = null;
  if (session.workout_assignment_id) {
    const dayIndex = session.workout_day ? WEEKDAYS.indexOf(session.workout_day) : -1;
    const { rows: planRows } = await pool.query(
      `SELECT wp.id AS plan_id, wp.name AS plan_name
         FROM workout_assignments wa
         JOIN workout_plans wp ON wp.id = wa.workout_plan_id
        WHERE wa.id = $1`,
      [session.workout_assignment_id]
    );
    const plan = planRows[0];
    if (plan && dayIndex >= 0) {
      const { rows: plannedExercises } = await pool.query(
        `SELECT we.exercise_id, e.name, we.sets, we.reps, we.rest_seconds, we.sort_order, we.notes
           FROM workout_exercises we
           LEFT JOIN exercises e ON e.id = we.exercise_id
          WHERE we.workout_plan_id = $1 AND we.day_of_week = $2
          ORDER BY we.sort_order`,
        [plan.plan_id, dayIndex + 1]
      );
      planned = { plan_name: plan.plan_name, exercises: plannedExercises };
    }
  }

  let totalSets = 0, totalReps = 0, totalVolume = 0, rpeSum = 0, rpeCount = 0;
  for (const ex of exercises) {
    for (const s of ex.sets) {
      if (!s.completed) continue;
      totalSets += 1;
      if (s.reps) totalReps += s.reps;
      if (s.weight_kg != null && s.reps) totalVolume += Number(s.weight_kg) * s.reps;
      if (s.rpe != null) { rpeSum += Number(s.rpe); rpeCount += 1; }
    }
  }

  res.json({
    data: {
      ...session,
      exercises,
      planned,
      summary: {
        total_sets: totalSets,
        total_reps: totalReps,
        total_volume: Math.round(totalVolume * 100) / 100,
        exercises_completed: exercises.filter((ex) => ex.sets.some((s) => s.completed)).length,
        exercises_total: exercises.length,
        avg_rpe: rpeCount ? Math.round((rpeSum / rpeCount) * 10) / 10 : null,
      },
    },
  });
}));

// POST /workout-log/sessions
router.post('/workout-log/sessions', auth, requireRole('admin', 'manager', 'trainer'), validate(sessionCreateSchema), wrap(async (req, res) => {
  const b = req.body;

  // Same PAR-Q + Informed Consent gate as plan assignment — logging a
  // session is training just as much as following an assigned plan, so it
  // gets the same clearance requirement.
  const blocked = await checkScreeningGate(req, b.client_id);
  if (blocked) return res.status(blocked.status).json(blocked.body);

  // Auto-link the client's single active plan assignment only when the
  // field was omitted entirely — an explicit null (freestyle, opted out
  // of the client's active plan) or an explicit id is left as-is, so the
  // frontend can distinguish "didn't say" from "said no plan".
  let assignmentId = b.workout_assignment_id;
  if (assignmentId === undefined) {
    const { rows: activeRows } = await pool.query(
      `SELECT id FROM workout_assignments WHERE client_id = $1 AND status = 'active'`,
      [b.client_id]
    );
    assignmentId = activeRows.length === 1 ? activeRows[0].id : null;
  }

  const { rows } = await pool.query(
    `INSERT INTO workout_sessions (
       client_id, trainer_id, workout_assignment_id, session_date, program_name, workout_day, notes, created_by
     ) VALUES ($1, (SELECT trainer_id FROM pt_clients WHERE id = $1), $2, COALESCE($3, CURRENT_DATE), $4, $5, $6, $7)
     RETURNING *`,
    [b.client_id, assignmentId, b.session_date || null, b.program_name || null, b.workout_day || null, b.notes || null, req.user.id]
  );
  await logActivity(req, 'workout_log.session.create', 'workout_sessions', rows[0].id, { client_id: b.client_id });
  res.status(201).json({ data: rows[0] });
}));

// GET /workout-log/sessions/:sessionId/planned-day-options — the distinct
// weekday names this session's linked plan prescribes exercises for, so
// the frontend can render a constrained day picker instead of free text.
router.get('/workout-log/sessions/:sessionId/planned-day-options', auth, wrap(async (req, res) => {
  const { rows: sessionRows } = await pool.query(
    'SELECT workout_assignment_id FROM workout_sessions WHERE id = $1',
    [req.params.sessionId]
  );
  const session = sessionRows[0];
  if (!session) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
  if (!session.workout_assignment_id) return res.json({ data: [] });

  const { rows: planRows } = await pool.query(
    `SELECT wp.id FROM workout_assignments wa JOIN workout_plans wp ON wp.id = wa.workout_plan_id WHERE wa.id = $1`,
    [session.workout_assignment_id]
  );
  if (!planRows[0]) return res.json({ data: [] });

  const { rows: dayRows } = await pool.query(
    'SELECT DISTINCT day_of_week FROM workout_exercises WHERE workout_plan_id = $1 ORDER BY day_of_week',
    [planRows[0].id]
  );
  res.json({ data: dayRows.map((r) => WEEKDAYS[r.day_of_week - 1]).filter(Boolean) });
}));

// PATCH /workout-log/sessions/:id
router.patch('/workout-log/sessions/:id', auth, requireRole('admin', 'manager', 'trainer'), validate(sessionUpdateSchema), wrap(async (req, res) => {
  const { id } = req.params;
  const b = req.body;
  const allowed = ['session_date', 'program_name', 'workout_day', 'notes', 'duration_minutes', 'status'];
  const sets = [];
  const params = [id];
  for (const key of allowed) {
    if (b[key] !== undefined) { params.push(b[key]); sets.push(`${key} = $${params.length}`); }
  }
  if (!sets.length) return res.status(400).json({ error: { code: 'NO_FIELDS' } });
  sets.push('updated_at = NOW()');
  const { rows } = await pool.query(`UPDATE workout_sessions SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
  if (b.status !== undefined && rows[0].workout_assignment_id) {
    await recomputeAssignmentProgress(rows[0].workout_assignment_id);
  }
  res.json({ data: rows[0] });
}));

// DELETE /workout-log/sessions/:id
router.delete('/workout-log/sessions/:id', auth, requireRole('admin', 'manager', 'trainer'), wrap(async (req, res) => {
  const { rows } = await pool.query('DELETE FROM workout_sessions WHERE id = $1 RETURNING id, client_id, workout_assignment_id', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
  if (rows[0].workout_assignment_id) await recomputeAssignmentProgress(rows[0].workout_assignment_id);
  await logActivity(req, 'workout_log.session.delete', 'workout_sessions', req.params.id, { client_id: rows[0].client_id });
  res.json({ message: 'Session deleted' });
}));

// ─── Exercises within a session ─────────────────────────────

// POST /workout-log/sessions/:sessionId/exercises
router.post('/workout-log/sessions/:sessionId/exercises', auth, requireRole('admin', 'manager', 'trainer'), validate(exerciseAddSchema), wrap(async (req, res) => {
  const { sessionId } = req.params;
  const b = req.body;
  const { rows: sessionRows } = await pool.query('SELECT id FROM workout_sessions WHERE id = $1', [sessionId]);
  if (!sessionRows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND' } });

  const { rows: orderRows } = await pool.query(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM workout_session_exercises WHERE session_id = $1',
    [sessionId]
  );

  const { rows } = await pool.query(
    `INSERT INTO workout_session_exercises (session_id, exercise_id, exercise_name, sort_order, notes)
     VALUES ($1,$2,$3,$4,$5) RETURNING *, '[]'::json AS sets`,
    [sessionId, b.exercise_id || null, b.exercise_name, orderRows[0].next_order, b.notes || null]
  );
  res.status(201).json({ data: rows[0] });
}));

// DELETE /workout-log/exercises/:id
router.delete('/workout-log/exercises/:id', auth, requireRole('admin', 'manager', 'trainer'), wrap(async (req, res) => {
  const { rows } = await pool.query('DELETE FROM workout_session_exercises WHERE id = $1 RETURNING id', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
  res.json({ message: 'Exercise removed' });
}));

// ─── Sets ───────────────────────────────────────────────────

// POST /workout-log/exercises/:sessionExerciseId/sets
router.post('/workout-log/exercises/:sessionExerciseId/sets', auth, requireRole('admin', 'manager', 'trainer'), validate(setCreateSchema), wrap(async (req, res) => {
  const { sessionExerciseId } = req.params;
  const b = req.body;

  const { rows: exRows } = await pool.query(
    `SELECT wse.exercise_id, wse.exercise_name, ws.client_id
       FROM workout_session_exercises wse
       JOIN workout_sessions ws ON ws.id = wse.session_id
      WHERE wse.id = $1`,
    [sessionExerciseId]
  );
  const ex = exRows[0];
  if (!ex) return res.status(404).json({ error: { code: 'NOT_FOUND' } });

  let prFlags = { is_pr_weight: false, is_pr_reps: false, is_pr_volume: false };
  if (b.completed && b.weight_kg != null && b.reps != null) {
    prFlags = await computePrFlags(pool, ex.client_id, ex.exercise_id, ex.exercise_name, b.weight_kg, b.reps, null);
  }

  const { rows } = await pool.query(
    `INSERT INTO workout_sets (
       session_exercise_id, set_number, weight_kg, reps, rpe, rir, tempo, rest_seconds, completed, notes,
       is_pr_weight, is_pr_reps, is_pr_volume
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [
      sessionExerciseId, b.set_number, b.weight_kg ?? null, b.reps ?? null, b.rpe ?? null, b.rir ?? null,
      b.tempo || null, b.rest_seconds ?? null, b.completed ?? false, b.notes || null,
      prFlags.is_pr_weight, prFlags.is_pr_reps, prFlags.is_pr_volume,
    ]
  );
  res.status(201).json({ data: rows[0] });
}));

// PATCH /workout-log/sets/:id
router.patch('/workout-log/sets/:id', auth, requireRole('admin', 'manager', 'trainer'), validate(setUpdateSchema), wrap(async (req, res) => {
  const { id } = req.params;
  const b = req.body;

  const { rows: existingRows } = await pool.query(
    `SELECT s.*, wse.exercise_id, wse.exercise_name, ws.client_id
       FROM workout_sets s
       JOIN workout_session_exercises wse ON wse.id = s.session_exercise_id
       JOIN workout_sessions ws ON ws.id = wse.session_id
      WHERE s.id = $1`,
    [id]
  );
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND' } });

  const merged = {
    weight_kg: b.weight_kg !== undefined ? b.weight_kg : existing.weight_kg,
    reps: b.reps !== undefined ? b.reps : existing.reps,
    completed: b.completed !== undefined ? b.completed : existing.completed,
  };

  let prFlags = { is_pr_weight: existing.is_pr_weight, is_pr_reps: existing.is_pr_reps, is_pr_volume: existing.is_pr_volume };
  if (merged.completed && merged.weight_kg != null && merged.reps != null) {
    prFlags = await computePrFlags(pool, existing.client_id, existing.exercise_id, existing.exercise_name, merged.weight_kg, merged.reps, id);
  } else if (!merged.completed) {
    prFlags = { is_pr_weight: false, is_pr_reps: false, is_pr_volume: false };
  }

  const allowed = ['weight_kg', 'reps', 'rpe', 'rir', 'tempo', 'rest_seconds', 'completed', 'notes'];
  const sets = [];
  const params = [id];
  for (const key of allowed) {
    if (b[key] !== undefined) { params.push(b[key]); sets.push(`${key} = $${params.length}`); }
  }
  for (const [col, val] of Object.entries(prFlags)) { params.push(val); sets.push(`${col} = $${params.length}`); }
  sets.push('updated_at = NOW()');

  const { rows } = await pool.query(`UPDATE workout_sets SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  res.json({ data: rows[0] });
}));

// DELETE /workout-log/sets/:id
router.delete('/workout-log/sets/:id', auth, requireRole('admin', 'manager', 'trainer'), wrap(async (req, res) => {
  const { rows } = await pool.query('DELETE FROM workout_sets WHERE id = $1 RETURNING id', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
  res.json({ message: 'Set deleted' });
}));

// ─── Previous workout + progress ────────────────────────────

// GET /workout-log/previous?client_id=&exercise_id=&exercise_name=&exclude_session_id=
// Powers the "Previous" side-by-side panel and auto-fill.
router.get('/workout-log/previous', auth, wrap(async (req, res) => {
  const { client_id, exercise_id, exercise_name, exclude_session_id } = req.query;
  if (!client_id || (!exercise_id && !exercise_name)) {
    return res.status(400).json({ error: { code: 'MISSING_PARAMS' } });
  }
  const matchClause = exercise_id ? 'wse.exercise_id = $2' : 'wse.exercise_name = $2';
  const matchParam = exercise_id || exercise_name;
  const params = [client_id, matchParam];
  let excludeClause = '';
  if (exclude_session_id) { params.push(exclude_session_id); excludeClause = `AND ws.id != $${params.length}`; }

  const { rows: exRows } = await pool.query(
    `SELECT wse.id AS session_exercise_id, ws.session_date
       FROM workout_session_exercises wse
       JOIN workout_sessions ws ON ws.id = wse.session_id
      WHERE ws.client_id = $1 AND ${matchClause} ${excludeClause}
      ORDER BY ws.session_date DESC, wse.created_at DESC
      LIMIT 1`,
    params
  );
  if (!exRows[0]) return res.json({ data: null });

  const { rows: setRows } = await pool.query(
    'SELECT * FROM workout_sets WHERE session_exercise_id = $1 ORDER BY set_number ASC',
    [exRows[0].session_exercise_id]
  );
  res.json({ data: { session_date: exRows[0].session_date, sets: setRows } });
}));

// GET /workout-log/progress?client_id=&exercise_id=&exercise_name=
// Per-session best set + estimated 1RM + volume — feeds the exercise
// progress charts (e.g. Bench/Squat/Deadlift progress).
router.get('/workout-log/progress', auth, wrap(async (req, res) => {
  const { client_id, exercise_id, exercise_name } = req.query;
  if (!client_id || (!exercise_id && !exercise_name)) {
    return res.status(400).json({ error: { code: 'MISSING_PARAMS' } });
  }
  const matchClause = exercise_id ? 'wse.exercise_id = $2' : 'wse.exercise_name = $2';
  const matchParam = exercise_id || exercise_name;

  const { rows } = await pool.query(
    `SELECT ws.session_date, s.weight_kg, s.reps
       FROM workout_sets s
       JOIN workout_session_exercises wse ON wse.id = s.session_exercise_id
       JOIN workout_sessions ws ON ws.id = wse.session_id
      WHERE ws.client_id = $1 AND ${matchClause} AND s.completed = true
        AND s.weight_kg IS NOT NULL AND s.reps IS NOT NULL
      ORDER BY ws.session_date ASC`,
    [client_id, matchParam]
  );

  const bySession = new Map();
  for (const r of rows) {
    const key = String(r.session_date).slice(0, 10);
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push(r);
  }
  const data = Array.from(bySession.entries()).map(([session_date, sets]) => {
    const volume = sets.reduce((sum, r) => sum + Number(r.weight_kg) * Number(r.reps), 0);
    const best = sets.reduce((b, r) => (b == null || Number(r.weight_kg) > Number(b.weight_kg) ? r : b), null);
    return {
      session_date,
      best_weight: Number(best.weight_kg),
      best_reps: Number(best.reps),
      est_1rm: calc1RM(Number(best.weight_kg), Number(best.reps), 'epley'),
      volume: Math.round(volume * 100) / 100,
    };
  });
  res.json({ data });
}));

// GET /workout-log/volume-summary?client_id=&group_by=week|month
// Feeds the Weekly/Monthly Training Volume charts (all exercises combined).
router.get('/workout-log/volume-summary', auth, wrap(async (req, res) => {
  const { client_id, group_by } = req.query;
  if (!client_id) return res.status(400).json({ error: { code: 'MISSING_CLIENT_ID' } });
  const trunc = group_by === 'month' ? 'month' : 'week';

  const { rows } = await pool.query(
    `SELECT date_trunc($2, ws.session_date)::date AS period,
            SUM(s.weight_kg * s.reps) AS volume,
            COUNT(DISTINCT ws.id) AS session_count
       FROM workout_sets s
       JOIN workout_session_exercises wse ON wse.id = s.session_exercise_id
       JOIN workout_sessions ws ON ws.id = wse.session_id
      WHERE ws.client_id = $1 AND s.completed = true AND s.weight_kg IS NOT NULL AND s.reps IS NOT NULL
      GROUP BY period
      ORDER BY period ASC`,
    [client_id, trunc]
  );
  res.json({ data: rows });
}));

module.exports = router;

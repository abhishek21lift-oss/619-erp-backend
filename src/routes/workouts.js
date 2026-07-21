// src/routes/workouts.js — Exercise library + Workout Plans
const router = require('express').Router();
const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const { auth, adminOrManager } = require('../middleware/auth');
const { checkScreeningGate } = require('../lib/screeningGate');
const { tenantScope, orgIdOf } = require('../lib/tenant-db');

// ─── EXERCISES ────────────────────────────────────────────────

// GET /api/workouts/exercises
router.get('/exercises', auth, async (req, res, next) => {
  try {
    const { muscle_group, body_part, equipment, exercise_type, difficulty, search } = req.query;
    const conds = ['is_active = true'];
    const params = [];
    let p = 1;

    if (muscle_group)   { conds.push(`muscle_group = $${p++}`);   params.push(muscle_group); }
    if (body_part)      { conds.push(`body_part = $${p++}`);       params.push(body_part); }
    if (equipment)      { conds.push(`equipment = $${p++}`);       params.push(equipment); }
    if (exercise_type)  { conds.push(`exercise_type = $${p++}`);   params.push(exercise_type); }
    if (difficulty)     { conds.push(`difficulty = $${p++}`);      params.push(difficulty); }
    if (search)         { conds.push(`name ILIKE $${p++}`);        params.push(`%${search}%`); }

    const limit  = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT id, name, muscle_group, body_part, target_muscle, secondary_muscles,
              equipment, difficulty, instructions, gif_url, exercise_type,
              force, mechanic, sets_default, reps_default, rest_seconds,
              video_url, image_url, is_active, source_id, created_at
       FROM exercises WHERE ${conds.join(' AND ')} ORDER BY body_part, name
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(rows);
  } catch (err) {
    if (err.message?.includes('does not exist')) return res.json([]);
    next(err);
  }
});

// GET /api/workouts/exercises/meta — filter values + optional filtered total count
router.get('/exercises/meta', auth, async (req, res, next) => {
  try {
    const { body_part, equipment, exercise_type, difficulty, search } = req.query;
    const hasFilters = body_part || equipment || exercise_type || difficulty || search;

    // Always return global metadata for dropdowns
    const { rows: [meta] } = await pool.query(`
      SELECT
        array_agg(DISTINCT body_part    ORDER BY body_part)    FILTER (WHERE body_part IS NOT NULL)    AS body_parts,
        array_agg(DISTINCT equipment    ORDER BY equipment)    FILTER (WHERE equipment IS NOT NULL)    AS equipment_types,
        array_agg(DISTINCT exercise_type ORDER BY exercise_type) FILTER (WHERE exercise_type IS NOT NULL) AS exercise_types,
        array_agg(DISTINCT difficulty   ORDER BY difficulty)   FILTER (WHERE difficulty IS NOT NULL)   AS difficulties,
        COUNT(*)::int AS total
      FROM exercises WHERE is_active = true
    `);

    if (!hasFilters) return res.json(meta);

    // Filtered count
    const conds = ['is_active = true'];
    const params = [];
    let p = 1;
    if (body_part)     { conds.push(`body_part = $${p++}`);     params.push(body_part); }
    if (equipment)     { conds.push(`equipment = $${p++}`);     params.push(equipment); }
    if (exercise_type) { conds.push(`exercise_type = $${p++}`); params.push(exercise_type); }
    if (difficulty)    { conds.push(`difficulty = $${p++}`);    params.push(difficulty); }
    if (search)        { conds.push(`name ILIKE $${p++}`);      params.push(`%${search}%`); }

    const { rows: [cnt] } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM exercises WHERE ${conds.join(' AND ')}`,
      params
    );
    res.json({ ...meta, total: cnt.total });
  } catch (err) {
    next(err);
  }
});

// POST /api/workouts/exercises
router.post('/exercises', auth, adminOrManager, async (req, res, next) => {
  try {
    const d = req.body;
    if (!d.name?.trim())
      return res.status(400).json({ error: 'Exercise name required' });

    const { rows } = await pool.query(`
      INSERT INTO exercises (id, name, description, muscle_group, body_part, target_muscle,
        secondary_muscles, equipment, difficulty, instructions, gif_url, exercise_type,
        force, mechanic, sets_default, reps_default, rest_seconds, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [randomUUID(), d.name.trim(), d.description || null,
       d.muscle_group || d.body_part || 'Full Body',
       d.body_part || d.muscle_group || 'Full Body',
       d.target_muscle || null, d.secondary_muscles || null,
       d.equipment || null, d.difficulty || 'beginner',
       d.instructions || null, d.gif_url || null, d.exercise_type || null,
       d.force || null, d.mechanic || null,
       parseInt(d.sets_default) || 3, parseInt(d.reps_default) || 12,
       parseInt(d.rest_seconds) || 60, req.user.id]
    );
    res.status(201).json({ message: 'Exercise created', exercise: rows[0] });
  } catch (err) {
    if (err.message?.includes('does not exist')) return res.status(400).json({ error: 'Tables not ready. Run migrations.' });
    next(err);
  }
});

// PUT /api/workouts/exercises/:id
router.put('/exercises/:id', auth, adminOrManager, async (req, res, next) => {
  try {
    const d = req.body;
    const { rows } = await pool.query(`
      UPDATE exercises SET
        name              = COALESCE($1,  name),
        description       = COALESCE($2,  description),
        muscle_group      = COALESCE($3,  muscle_group),
        body_part         = COALESCE($4,  body_part),
        target_muscle     = COALESCE($5,  target_muscle),
        secondary_muscles = COALESCE($6,  secondary_muscles),
        equipment         = COALESCE($7,  equipment),
        difficulty        = COALESCE($8,  difficulty),
        instructions      = COALESCE($9,  instructions),
        gif_url           = COALESCE($10, gif_url),
        exercise_type     = COALESCE($11, exercise_type),
        force             = COALESCE($12, force),
        mechanic          = COALESCE($13, mechanic),
        sets_default      = COALESCE($14, sets_default),
        reps_default      = COALESCE($15, reps_default),
        rest_seconds      = COALESCE($16, rest_seconds),
        updated_at        = NOW()
      WHERE id = $17 RETURNING *`,
      [d.name || null, d.description ?? null,
       d.muscle_group || null, d.body_part || null,
       d.target_muscle ?? null, d.secondary_muscles ?? null,
       d.equipment ?? null, d.difficulty || null,
       d.instructions ?? null, d.gif_url ?? null,
       d.exercise_type ?? null, d.force ?? null, d.mechanic ?? null,
       d.sets_default ? parseInt(d.sets_default) : null,
       d.reps_default ? parseInt(d.reps_default) : null,
       d.rest_seconds ? parseInt(d.rest_seconds) : null,
       req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Exercise not found' });
    res.json({ message: 'Exercise updated', exercise: rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/workouts/exercises/:id
router.delete('/exercises/:id', auth, adminOrManager, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'UPDATE exercises SET is_active=false WHERE id=$1 RETURNING id',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Exercise not found' });
    res.json({ message: 'Exercise deleted' });
  } catch (err) {
    next(err);
  }
});

// ─── WORKOUT PLANS ────────────────────────────────────────────

// GET /api/workouts/plans
router.get('/plans', auth, async (req, res, next) => {
  try {
    const { goal, client_id } = req.query;
    const conds = ['wp.deleted_at IS NULL AND wp.is_active = true'];
    const params = [];
    let p = 1;

    if (goal)      { conds.push(`wp.goal = $${p++}`);           params.push(goal); }
    if (client_id) { conds.push(`wa.client_id = $${p++}`);      params.push(client_id); }

    const joinClause = client_id
      ? `LEFT JOIN workout_assignments wa ON wa.workout_plan_id = wp.id AND wa.client_id = $${p-1}`
      : '';

    const limit  = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    params.push(limit, offset);
    const { rows } = await pool.query(`
      SELECT wp.*,
        COALESCE((SELECT COUNT(*) FROM workout_exercises we WHERE we.workout_plan_id = wp.id), 0)::int AS exercise_count,
        ${client_id ? `(SELECT wa.progress_pct FROM workout_assignments wa2 WHERE wa2.workout_plan_id = wp.id AND wa2.client_id = $${p-1} AND wa2.status = 'active' LIMIT 1)::int AS progress,` : '0 AS progress,'}
        COALESCE((SELECT json_agg(json_build_object(
          'id', we.id, 'exercise_id', we.exercise_id, 'name', e.name,
          'muscle_group', e.muscle_group, 'sets', we.sets, 'reps', we.reps,
          'day_of_week', we.day_of_week, 'sort_order', we.sort_order, 'notes', we.notes
        ) ORDER BY we.day_of_week, we.sort_order)
        FROM workout_exercises we
        LEFT JOIN exercises e ON e.id = we.exercise_id
        WHERE we.workout_plan_id = wp.id), '[]'::json) AS exercises
      FROM workout_plans wp
      ${joinClause}
      WHERE ${conds.join(' AND ')}
      ORDER BY wp.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(rows);
  } catch (err) {
    if (err.message?.includes('does not exist')) return res.json([]);
    next(err);
  }
});

// GET /api/workouts/plans/:id — full detail, exercises grouped by day.
router.get('/plans/:id', auth, async (req, res, next) => {
  try {
    const { rows: planRows } = await pool.query(
      `SELECT * FROM workout_plans WHERE id = $1 AND deleted_at IS NULL`,
      [req.params.id]
    );
    const plan = planRows[0];
    if (!plan) return res.status(404).json({ error: 'Workout plan not found' });

    const { rows: exercises } = await pool.query(
      `SELECT we.id, we.exercise_id, e.name, e.muscle_group, we.sets, we.reps,
              we.rest_seconds, we.day_of_week, we.sort_order, we.notes
         FROM workout_exercises we
         LEFT JOIN exercises e ON e.id = we.exercise_id
        WHERE we.workout_plan_id = $1
        ORDER BY we.day_of_week, we.sort_order`,
      [req.params.id]
    );
    res.json({ ...plan, exercises });
  } catch (err) {
    next(err);
  }
});

// POST /api/workouts/plans
router.post('/plans', auth, adminOrManager, async (req, res, next) => {
  const d = req.body;
  if (!d.name?.trim())
    return res.status(400).json({ error: 'Plan name required' });

  try {
    const id = randomUUID();
    const { rows } = await pool.query(`
      INSERT INTO workout_plans (id, name, description, goal, difficulty,
        duration_weeks, sessions_per_week, is_template, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [id, d.name.trim(), d.description || null, d.goal || 'general_fitness',
       d.difficulty || 'beginner', parseInt(d.duration_weeks) || 4,
       parseInt(d.sessions_per_week) || 3, d.is_template !== false, req.user.id]
    );

    // Add exercises if provided
    if (Array.isArray(d.exercises)) {
      for (const ex of d.exercises) {
        await pool.query(`
          INSERT INTO workout_exercises (id, workout_plan_id, exercise_id, day_of_week,
            sort_order, sets, reps, rest_seconds, notes)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [randomUUID(), id, ex.exercise_id, parseInt(ex.day_of_week) || 1,
           parseInt(ex.sort_order) || 0, parseInt(ex.sets) || 3, parseInt(ex.reps) || 12,
           parseInt(ex.rest_seconds) || 60, ex.notes || null]
        );
      }
    }

    res.status(201).json({ message: 'Workout plan created', plan: rows[0] });
  } catch (err) {
    if (err.message?.includes('does not exist')) return res.status(400).json({ error: 'Tables not ready. Run migrations.' });
    next(err);
  }
});

// PUT /api/workouts/plans/:id
// Optionally accepts an exercises[] array (same shape as POST /plans) to
// replace the plan's full workout_exercises list in one call — the only
// way the Plan Builder's edit path needs to touch exercises.
router.put('/plans/:id', auth, adminOrManager, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const d = req.body;
    await client.query('BEGIN');
    const { rows } = await client.query(`
      UPDATE workout_plans SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        goal = COALESCE($3, goal),
        difficulty = COALESCE($4, difficulty),
        duration_weeks = COALESCE($5, duration_weeks),
        sessions_per_week = COALESCE($6, sessions_per_week),
        updated_at = NOW()
      WHERE id = $7 RETURNING *`,
      [d.name || null, d.description ?? null, d.goal || null, d.difficulty || null,
       d.duration_weeks ? parseInt(d.duration_weeks) : null,
       d.sessions_per_week ? parseInt(d.sessions_per_week) : null, req.params.id]
    );
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Workout plan not found' }); }

    if (Array.isArray(d.exercises)) {
      await client.query('DELETE FROM workout_exercises WHERE workout_plan_id = $1', [req.params.id]);
      for (const ex of d.exercises) {
        await client.query(`
          INSERT INTO workout_exercises (id, workout_plan_id, exercise_id, day_of_week,
            sort_order, sets, reps, rest_seconds, notes)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [randomUUID(), req.params.id, ex.exercise_id, parseInt(ex.day_of_week) || 1,
           parseInt(ex.sort_order) || 0, parseInt(ex.sets) || 3, parseInt(ex.reps) || 12,
           parseInt(ex.rest_seconds) || 60, ex.notes || null]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ message: 'Plan updated', plan: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// DELETE /api/workouts/plans/:id
router.delete('/plans/:id', auth, adminOrManager, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'UPDATE workout_plans SET deleted_at=NOW(), is_active=false WHERE id=$1 AND deleted_at IS NULL RETURNING id',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Workout plan not found' });
    res.json({ message: 'Workout plan deleted' });
  } catch (err) {
    next(err);
  }
});

// ─── WORKOUT ASSIGNMENTS ──────────────────────────────────────

// GET /api/workouts/assignments?client_id=&status=
router.get('/assignments', auth, async (req, res, next) => {
  try {
    const { client_id, status } = req.query;
    if (!client_id) return res.status(400).json({ error: 'client_id required' });
    const conds = ['wa.client_id = $1'];
    const params = [client_id];
    let p = 2;
    if (status) { conds.push(`wa.status = $${p++}`); params.push(status); }
    const scope = tenantScope(req);
    if (scope.applyFilter) { conds.push(`wa.organization_id = $${p++}`); params.push(scope.orgId); }

    const { rows } = await pool.query(`
      SELECT wa.*, wp.name AS plan_name, wp.goal AS plan_goal,
             wp.duration_weeks, wp.sessions_per_week
        FROM workout_assignments wa
        JOIN workout_plans wp ON wp.id = wa.workout_plan_id
       WHERE ${conds.join(' AND ')}
       ORDER BY wa.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    if (err.message?.includes('does not exist')) return res.json([]);
    next(err);
  }
});

// GET /api/workouts/assignments/:id — single assignment + its plan's full
// prescribed exercises (feeds "today's prescribed exercises" in the log).
router.get('/assignments/:id', auth, async (req, res, next) => {
  try {
    const scope = tenantScope(req);
    const guard = scope.applyFilter ? ' AND wa.organization_id = $2' : '';
    const { rows: assignRows } = await pool.query(`
      SELECT wa.*, wp.name AS plan_name, wp.goal AS plan_goal,
             wp.duration_weeks, wp.sessions_per_week
        FROM workout_assignments wa
        JOIN workout_plans wp ON wp.id = wa.workout_plan_id
       WHERE wa.id = $1${guard}`,
      scope.applyFilter ? [req.params.id, scope.orgId] : [req.params.id]
    );
    const assignment = assignRows[0];
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

    const { rows: exercises } = await pool.query(
      `SELECT we.id, we.exercise_id, e.name, e.muscle_group, we.sets, we.reps,
              we.rest_seconds, we.day_of_week, we.sort_order, we.notes
         FROM workout_exercises we
         LEFT JOIN exercises e ON e.id = we.exercise_id
        WHERE we.workout_plan_id = $1
        ORDER BY we.day_of_week, we.sort_order`,
      [assignment.workout_plan_id]
    );
    res.json({ ...assignment, exercises });
  } catch (err) {
    next(err);
  }
});

// POST /api/workouts/assign
router.post('/assign', auth, adminOrManager, async (req, res, next) => {
  try {
    const d = req.body;
    if (!d.workout_plan_id || !d.client_id)
      return res.status(400).json({ error: 'workout_plan_id and client_id required' });

    // PAR-Q + Informed Consent gate — shared with Workout Log session
    // creation (src/lib/screeningGate.js) so both entry points enforce the
    // exact same clearance rule: explicit medical blocks stop the action,
    // missing paperwork proceeds with warnings for the UI to surface.
    const { blocked, warnings } = await checkScreeningGate(req, d.client_id);
    if (blocked) return res.status(blocked.status).json(blocked.body);

    const { rows } = await pool.query(`
      INSERT INTO workout_assignments (id, workout_plan_id, client_id, trainer_id,
        start_date, end_date, status, notes, organization_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (workout_plan_id, client_id, status)
      DO UPDATE SET status = 'active', start_date = EXCLUDED.start_date,
        organization_id = COALESCE(workout_assignments.organization_id, EXCLUDED.organization_id), updated_at = NOW()
      RETURNING *`,
      [randomUUID(), d.workout_plan_id, d.client_id, req.user.trainer_id || null,
       d.start_date || new Date().toISOString().split('T')[0],
       d.end_date || null, 'active', d.notes || null, orgIdOf(req)]
    );
    res.status(201).json({ message: 'Plan assigned', assignment: rows[0], screening_warnings: warnings });
  } catch (err) {
    if (err.message?.includes('does not exist')) return res.status(400).json({ error: 'Tables not ready. Run migrations.' });
    next(err);
  }
});

// PUT /api/workouts/assignments/:id/progress
router.put('/assignments/:id/progress', auth, async (req, res, next) => {
  try {
    const pct = parseInt(req.body.progress_pct);
    if (isNaN(pct) || pct < 0 || pct > 100)
      return res.status(400).json({ error: 'progress_pct must be 0-100' });

    const scope = tenantScope(req);
    const guard = scope.applyFilter ? ' AND organization_id = $3' : '';
    const { rows } = await pool.query(`
      UPDATE workout_assignments SET progress_pct=$1, updated_at=NOW()
      WHERE id=$2${guard} RETURNING *`,
      scope.applyFilter ? [pct, req.params.id, scope.orgId] : [pct, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Assignment not found' });
    res.json({ message: 'Progress updated', assignment: rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

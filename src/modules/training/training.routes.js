// HTTP for the training domain, mounted at /api/training.
//
// ── Why not /api/workouts ──────────────────────────────────────────────────
//
// That path belongs to the old routes and still serves production. Mounting
// the new domain beside it rather than over it keeps this slice additive: the
// two can run together while the UI is rebuilt, and slice G repoints the old
// path once nothing reads it. Taking the path now would mean cutting over the
// frontend in the same change that introduces the API.
//
// ── What lives here and what does not ──────────────────────────────────────
//
// These handlers validate, authorise, and call. Anything spanning two tables,
// anything needing a transaction, and every coaching rule lives in
// training.service.js and the pure modules beside it. A handler that grew SQL
// is a handler that will grow a second copy of a rule.
//
// Authorisation is never inline. Every route reaches its row through authz.js,
// which walks back to the client — because `WHERE id = $1` on a child table
// looks scoped and is not.
'use strict';

const router = require('express').Router();
const pool = require('../../db/pool');
const { auth } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { validate } = require('../../middleware/validate');
const { logActivity } = require('../../lib/activityLog');
const { orgIdOf } = require('../../lib/tenant-db');
const authz = require('./authz');
const schemas = require('./training.schemas');
const service = require('./training.service');
const prescription = require('./prescription');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Staff who may author or log. Clients read through a separate surface. */
const STAFF = requireRole('admin', 'manager', 'trainer');

const notFound = (res, what) =>
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `${what} not found` } });

/** Turn a TrainingError into its response; re-throw anything else. */
function sendError(res, err) {
  if (!(err instanceof service.TrainingError)) throw err;
  if (err.body) return res.status(err.status).json(err.body);
  return res.status(err.status).json({ error: { code: err.code, message: err.message } });
}

/** `col = $n` pairs for the fields present in `body`, from an allow-list. */
function patchFrom(body, allowed, startAt = 1) {
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (body[key] === undefined) continue;
    values.push(body[key]);
    sets.push(`${key} = $${startAt + values.length - 1}`);
  }
  return { sets, values };
}

// ═══ Programs ══════════════════════════════════════════════════════════════

router.get('/programs', auth, STAFF, wrap(async (req, res) => {
  const params = [];
  const org = authz.orgWhere(req, params, 'p.organization_id');
  const filters = [];
  if (req.query.client_id) { params.push(req.query.client_id); filters.push(`p.client_id = $${params.length}`); }
  if (req.query.status)    { params.push(req.query.status);    filters.push(`p.status = $${params.length}`); }
  // A trainer who is not admin/manager sees programmes for their own clients,
  // plus the studio's unassigned templates (client_id IS NULL).
  const trainer = authz.seesAllClients(req) || !req.user.trainer_id
    ? ''
    : (params.push(req.user.trainer_id),
       ` AND (p.client_id IS NULL OR EXISTS (
           SELECT 1 FROM pt_clients c WHERE c.id = p.client_id AND c.trainer_id = $${params.length}))`);

  const { rows } = await pool.query(
    `SELECT p.* FROM training_programs p
      WHERE p.deleted_at IS NULL${org}${trainer}
        ${filters.length ? `AND ${filters.join(' AND ')}` : ''}
      ORDER BY p.created_at DESC LIMIT 200`,
    params
  );
  res.json({ data: rows });
}));

router.get('/programs/:id', auth, STAFF, wrap(async (req, res) => {
  const program = await authz.loadOwned(req, 'training_programs', req.params.id);
  if (!program) return notFound(res, 'Program');
  const [phases, weeks] = await Promise.all([
    pool.query('SELECT * FROM training_program_phases WHERE program_id = $1 ORDER BY phase_order', [program.id]),
    pool.query('SELECT * FROM training_program_weeks  WHERE program_id = $1 ORDER BY week_number', [program.id]),
  ]);
  res.json({ data: { ...program, phases: phases.rows, weeks: weeks.rows } });
}));

router.post('/programs', auth, STAFF, validate(schemas.programCreate), wrap(async (req, res) => {
  const b = req.body;
  if (b.client_id && !await authz.canAccessClient(req, b.client_id)) return notFound(res, 'Client');
  const { rows } = await pool.query(
    `INSERT INTO training_programs
       (organization_id, client_id, created_by, name, description, goal, program_type,
        duration_weeks, start_date, end_date, notes)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'GENERAL_FITNESS'),$8,$9,$10,$11) RETURNING *`,
    [orgIdOf(req), b.client_id ?? null, req.user.id, b.name, b.description ?? null,
     b.goal ?? null, b.program_type ?? null, b.duration_weeks ?? null,
     b.start_date ?? null, b.end_date ?? null, b.notes ?? null]
  );
  await logActivity(req, 'training.program.create', 'training_programs', rows[0].id, { name: b.name }).catch(() => {});
  res.status(201).json({ data: rows[0] });
}));

router.patch('/programs/:id', auth, STAFF, validate(schemas.programUpdate), wrap(async (req, res) => {
  if (!await authz.loadOwned(req, 'training_programs', req.params.id)) return notFound(res, 'Program');
  // client_id is in the patch list below, and POST /programs guards the same
  // field with this exact check. Without it here, a programme this studio
  // legitimately owns could be re-pointed at ANOTHER studio's client — not a
  // read of foreign data, but a foreign key written across the tenant
  // boundary, which leaves the row reachable from two studios' client views.
  if (req.body.client_id !== undefined && req.body.client_id !== null
      && !await authz.canAccessClient(req, req.body.client_id)) {
    return notFound(res, 'Client');
  }
  const { sets, values } = patchFrom(req.body, [
    'name', 'description', 'goal', 'program_type', 'duration_weeks',
    'status', 'start_date', 'end_date', 'notes', 'client_id',
  ], 2);
  if (!sets.length) return notFound(res, 'Nothing to update');
  const { rows } = await pool.query(
    `UPDATE training_programs SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [req.params.id, ...values]
  );
  res.json({ data: rows[0] });
}));

router.delete('/programs/:id', auth, STAFF, wrap(async (req, res) => {
  if (!await authz.loadOwned(req, 'training_programs', req.params.id)) return notFound(res, 'Program');
  // Soft delete. Sessions logged against this programme stay readable, which
  // is the whole reason historical rows are never hard-deleted.
  await pool.query('UPDATE training_programs SET deleted_at = NOW() WHERE id = $1', [req.params.id]);
  await logActivity(req, 'training.program.delete', 'training_programs', req.params.id, {}).catch(() => {});
  res.json({ data: { id: req.params.id, deleted: true } });
}));

router.post('/programs/:id/phases', auth, STAFF, validate(schemas.phaseCreate), wrap(async (req, res) => {
  if (!await authz.loadOwned(req, 'training_programs', req.params.id)) return notFound(res, 'Program');
  const b = req.body;
  const { rows } = await pool.query(
    `INSERT INTO training_program_phases (program_id, name, phase_order, week_start, week_end, goal, notes)
     VALUES ($1,$2,COALESCE($3,1),$4,$5,$6,$7) RETURNING *`,
    [req.params.id, b.name, b.phase_order ?? null, b.week_start, b.week_end, b.goal ?? null, b.notes ?? null]
  );
  res.status(201).json({ data: rows[0] });
}));

router.post('/programs/:id/weeks', auth, STAFF, validate(schemas.weekCreate), wrap(async (req, res) => {
  if (!await authz.loadOwned(req, 'training_programs', req.params.id)) return notFound(res, 'Program');
  const b = req.body;
  const { rows } = await pool.query(
    `INSERT INTO training_program_weeks (program_id, phase_id, week_number, name, notes, is_deload)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6,false))
     ON CONFLICT (program_id, week_number) DO UPDATE
        SET phase_id = EXCLUDED.phase_id, name = EXCLUDED.name,
            notes = EXCLUDED.notes, is_deload = EXCLUDED.is_deload, updated_at = NOW()
     RETURNING *`,
    [req.params.id, b.phase_id ?? null, b.week_number, b.name ?? null, b.notes ?? null, b.is_deload ?? null]
  );
  res.status(201).json({ data: rows[0] });
}));

// ═══ Templates and prescriptions ═══════════════════════════════════════════

router.get('/templates', auth, STAFF, wrap(async (req, res) => {
  const params = [];
  const org = authz.orgWhere(req, params);
  const filters = [];
  if (req.query.program_id) { params.push(req.query.program_id); filters.push(`program_id = $${params.length}`); }
  if (req.query.week_id)    { params.push(req.query.week_id);    filters.push(`week_id = $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT * FROM workout_templates
      WHERE deleted_at IS NULL${org} ${filters.length ? `AND ${filters.join(' AND ')}` : ''}
      ORDER BY day_number NULLS LAST, name LIMIT 200`,
    params
  );
  res.json({ data: rows });
}));

router.get('/templates/:id', auth, STAFF, wrap(async (req, res) => {
  const template = await authz.loadOwned(req, 'workout_templates', req.params.id);
  if (!template) return notFound(res, 'Workout template');
  const { rows } = await pool.query(
    `SELECT wte.*, e.name AS exercise_name
       FROM workout_template_exercises wte
       LEFT JOIN exercises e ON e.id = wte.exercise_id
      WHERE wte.workout_template_id = $1
      ORDER BY wte.section, wte.order_index`,
    [template.id]
  );
  // The sentence a trainer would say, built once here rather than in each of
  // the PDF, the client screen and the AI brief.
  const exercises = rows.map((r) => ({
    ...r,
    summary: prescription.describe(r, r.exercise_name || ''),
    logs_as: prescription.performanceKind(r.prescription_type),
  }));
  res.json({ data: { ...template, exercises } });
}));

router.post('/templates', auth, STAFF, validate(schemas.templateCreate), wrap(async (req, res) => {
  const b = req.body;
  if (b.program_id && !await authz.loadOwned(req, 'training_programs', b.program_id)) {
    return notFound(res, 'Program');
  }
  const { rows } = await pool.query(
    `INSERT INTO workout_templates
       (organization_id, program_id, week_id, created_by, name, description,
        day_number, day_label, goal, estimated_duration_minutes, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [orgIdOf(req), b.program_id ?? null, b.week_id ?? null, req.user.id, b.name,
     b.description ?? null, b.day_number ?? null, b.day_label ?? null, b.goal ?? null,
     b.estimated_duration_minutes ?? null, b.notes ?? null]
  );
  await logActivity(req, 'training.template.create', 'workout_templates', rows[0].id, { name: b.name }).catch(() => {});
  res.status(201).json({ data: rows[0] });
}));

const PRESCRIPTION_COLS = [
  'exercise_id', 'section', 'order_index', 'superset_group', 'circuit_group', 'prescription_type',
  'target_sets', 'target_reps_min', 'target_reps_max', 'target_weight', 'weight_unit',
  'target_rpe', 'target_rir', 'target_tempo', 'target_rest_seconds', 'percentage_1rm',
  'percentage_metric', 'target_duration_seconds', 'target_distance', 'distance_unit',
  'target_speed', 'target_incline', 'target_resistance', 'target_cadence', 'target_floors',
  'target_steps', 'target_heart_rate', 'target_calories',
  'target_pace_seconds', 'work_interval_seconds', 'rest_interval_seconds', 'target_rounds',
  'warmup', 'optional', 'notes',
];

router.post('/templates/:id/exercises', auth, STAFF, validate(schemas.prescriptionCreate),
  wrap(async (req, res) => {
    const template = await authz.loadOwned(req, 'workout_templates', req.params.id);
    if (!template) return notFound(res, 'Workout template');

    const row = { ...req.body, prescription_type: req.body.prescription_type ?? 'SETS_REPS' };
    // Shape and range were checked by zod; THIS checks the prescription
    // against its own type, which only prescription.js knows how to do.
    const check = prescription.validate(row);
    if (!check.valid) {
      return res.status(400).json({
        error: { code: 'INVALID_PRESCRIPTION', message: check.errors[0], details: check.errors },
      });
    }

    const cols = PRESCRIPTION_COLS.filter((c) => row[c] !== undefined);
    const { rows } = await pool.query(
      `INSERT INTO workout_template_exercises (workout_template_id, ${cols.join(', ')})
       VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`,
      [template.id, ...cols.map((c) => row[c])]
    );
    res.status(201).json({ data: rows[0], warnings: check.warnings });
  }));

router.patch('/templates/:tid/exercises/:id', auth, STAFF, validate(schemas.prescriptionUpdate),
  wrap(async (req, res) => {
    const template = await authz.loadOwned(req, 'workout_templates', req.params.tid);
    if (!template) return notFound(res, 'Workout template');

    const { rows: existing } = await pool.query(
      'SELECT * FROM workout_template_exercises WHERE id = $1 AND workout_template_id = $2',
      [req.params.id, template.id]
    );
    if (!existing[0]) return notFound(res, 'Prescription');

    // Validate the MERGED row, not the patch: a patch that only changes
    // prescription_type is valid on its own and can leave the row saying
    // nothing.
    const merged = { ...existing[0], ...req.body };
    const check = prescription.validate(merged);
    if (!check.valid) {
      return res.status(400).json({
        error: { code: 'INVALID_PRESCRIPTION', message: check.errors[0], details: check.errors },
      });
    }

    const { sets, values } = patchFrom(req.body, PRESCRIPTION_COLS, 2);
    if (!sets.length) return res.json({ data: existing[0], warnings: check.warnings });
    const { rows } = await pool.query(
      `UPDATE workout_template_exercises SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [req.params.id, ...values]
    );
    res.json({ data: rows[0], warnings: check.warnings });
  }));

router.delete('/templates/:tid/exercises/:id', auth, STAFF, wrap(async (req, res) => {
  const template = await authz.loadOwned(req, 'workout_templates', req.params.tid);
  if (!template) return notFound(res, 'Workout template');
  const { rowCount } = await pool.query(
    'DELETE FROM workout_template_exercises WHERE id = $1 AND workout_template_id = $2',
    [req.params.id, template.id]
  );
  if (!rowCount) return notFound(res, 'Prescription');
  res.json({ data: { id: req.params.id, deleted: true } });
}));

router.put('/templates/:id/order', auth, STAFF, validate(schemas.reorder), wrap(async (req, res) => {
  const template = await authz.loadOwned(req, 'workout_templates', req.params.id);
  if (!template) return notFound(res, 'Workout template');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // One statement with an ordinality-derived index rather than a loop: a
    // partial reorder that failed halfway would leave the day scrambled.
    await client.query(
      `UPDATE workout_template_exercises wte
          SET order_index = v.idx - 1, updated_at = NOW()
         FROM unnest($2::uuid[]) WITH ORDINALITY AS v(id, idx)
        WHERE wte.id = v.id AND wte.workout_template_id = $1`,
      [template.id, req.body.exercise_ids]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
  res.json({ data: { id: template.id, reordered: req.body.exercise_ids.length } });
}));

// ═══ Assignments ═══════════════════════════════════════════════════════════

router.get('/assignments', auth, STAFF, wrap(async (req, res) => {
  const params = [];
  const org = authz.orgWhere(req, params, 'a.organization_id');
  const trainer = authz.trainerWhere(req, params);
  const filters = [];
  if (req.query.client_id) { params.push(req.query.client_id); filters.push(`a.client_id = $${params.length}`); }
  if (req.query.date)      { params.push(req.query.date);      filters.push(`a.scheduled_date = $${params.length}`); }
  if (req.query.status)    { params.push(req.query.status);    filters.push(`a.status = $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT a.*, t.name AS template_name, c.name AS client_name
       FROM training_assignments a
       JOIN pt_clients c ON c.id = a.client_id
       LEFT JOIN workout_templates t ON t.id = a.workout_template_id
      WHERE c.deleted_at IS NULL${org}${trainer}
        ${filters.length ? `AND ${filters.join(' AND ')}` : ''}
      ORDER BY a.scheduled_date DESC NULLS LAST, a.created_at DESC LIMIT 200`,
    params
  );
  res.json({ data: rows });
}));

router.post('/assignments', auth, STAFF, validate(schemas.assignmentCreate), wrap(async (req, res) => {
  const b = req.body;
  if (!await authz.canAccessClient(req, b.client_id)) return notFound(res, 'Client');
  if (!await authz.loadOwned(req, 'workout_templates', b.workout_template_id)) {
    return notFound(res, 'Workout template');
  }

  // The same gate as logging a session. Assigning a plan to a client the
  // screening has flagged must fail for the same reason training them does.
  const { checkScreeningGate } = require('../../lib/screeningGate');
  const { blocked, warnings } = await checkScreeningGate(req, b.client_id);
  if (blocked) return res.status(blocked.status).json(blocked.body);

  const { rows } = await pool.query(
    `INSERT INTO training_assignments
       (organization_id, program_id, workout_template_id, client_id, trainer_id, assigned_by,
        scheduled_date, sequence_number, notes, status)
     VALUES ($1,$2,$3,$4,COALESCE($5,(SELECT trainer_id FROM pt_clients WHERE id=$4)),$6,$7,$8,$9,
             CASE WHEN $7::date IS NULL THEN 'ASSIGNED' ELSE 'SCHEDULED' END)
     RETURNING *`,
    [orgIdOf(req), b.program_id ?? null, b.workout_template_id, b.client_id,
     b.trainer_id ?? null, req.user.id, b.scheduled_date ?? null,
     b.sequence_number ?? null, b.notes ?? null]
  );
  await logActivity(req, 'training.assignment.create', 'training_assignments', rows[0].id,
    { client_id: b.client_id }).catch(() => {});
  res.status(201).json({ data: rows[0], screening_warnings: warnings });
}));

router.patch('/assignments/:id', auth, STAFF, validate(schemas.assignmentUpdate), wrap(async (req, res) => {
  if (!await authz.loadOwned(req, 'training_assignments', req.params.id)) return notFound(res, 'Assignment');
  const { sets, values } = patchFrom(req.body, ['status', 'scheduled_date', 'notes'], 2);
  if (!sets.length) return notFound(res, 'Nothing to update');
  const { rows } = await pool.query(
    `UPDATE training_assignments SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [req.params.id, ...values]
  );
  res.json({ data: rows[0] });
}));

// ═══ Sessions ══════════════════════════════════════════════════════════════

router.get('/sessions', auth, STAFF, wrap(async (req, res) => {
  const params = [];
  const org = authz.orgWhere(req, params, 's.organization_id');
  const trainer = authz.trainerWhere(req, params);
  const filters = [];
  if (req.query.client_id) { params.push(req.query.client_id); filters.push(`s.client_id = $${params.length}`); }
  if (req.query.status)    { params.push(req.query.status);    filters.push(`s.status = $${params.length}`); }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT s.* FROM training_sessions s
       JOIN pt_clients c ON c.id = s.client_id
      WHERE s.deleted_at IS NULL AND c.deleted_at IS NULL${org}${trainer}
        ${filters.length ? `AND ${filters.join(' AND ')}` : ''}
      ORDER BY s.session_date DESC, s.created_at DESC LIMIT $${params.length}`,
    params
  );
  res.json({ data: rows });
}));

router.get('/sessions/:id', auth, STAFF, wrap(async (req, res) => {
  const session = await authz.loadSession(req, req.params.id);
  if (!session) return notFound(res, 'Session');
  const performances = await service.loadPerformances(session.id);
  res.json({ data: { ...session, performances } });
}));

router.post('/sessions', auth, STAFF, validate(schemas.sessionCreate), wrap(async (req, res) => {
  try {
    const out = await service.createSession(req, req.body);
    res.status(201).json({ data: out.session, screening_warnings: out.screening_warnings });
  } catch (err) { sendError(res, err); }
}));

router.post('/sessions/:id/seed', auth, STAFF, wrap(async (req, res) => {
  try {
    res.json({ data: await service.seedFromTemplate(req, req.params.id) });
  } catch (err) { sendError(res, err); }
}));

router.post('/sessions/:id/start', auth, STAFF, wrap(async (req, res) => {
  try {
    res.json({ data: await service.startSession(req, req.params.id) });
  } catch (err) { sendError(res, err); }
}));

router.post('/sessions/:id/complete', auth, STAFF, validate(schemas.sessionComplete),
  wrap(async (req, res) => {
    try {
      const out = await service.completeSession(req, req.params.id, req.body);
      res.json({
        data: out.session,
        summary: out.summary,
        records: out.records,
        already_complete: out.already_complete,
      });
    } catch (err) { sendError(res, err); }
  }));

router.patch('/sessions/:id', auth, STAFF, validate(schemas.sessionUpdate), wrap(async (req, res) => {
  if (!await authz.loadSession(req, req.params.id)) return notFound(res, 'Session');
  const { sets, values } = patchFrom(req.body,
    ['client_notes', 'trainer_notes', 'overall_rpe', 'session_date'], 2);
  if (!sets.length) return notFound(res, 'Nothing to update');
  const { rows } = await pool.query(
    `UPDATE training_sessions SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [req.params.id, ...values]
  );
  res.json({ data: rows[0] });
}));

// ═══ Performances, sets and cardio ═════════════════════════════════════════

router.post('/sessions/:id/exercises', auth, STAFF, validate(schemas.performanceCreate),
  wrap(async (req, res) => {
    const session = await authz.loadSession(req, req.params.id);
    if (!session) return notFound(res, 'Session');
    const b = req.body;
    const { rows } = await pool.query(
      `INSERT INTO exercise_performances
         (session_id, exercise_id, template_exercise_id, exercise_name, section, order_index, notes)
       VALUES ($1,$2,$3,COALESCE((SELECT name FROM exercises WHERE id = $2), 'Exercise'),$4,
               COALESCE($5, (SELECT COALESCE(MAX(order_index),-1)+1 FROM exercise_performances WHERE session_id=$1)),$6)
       RETURNING *`,
      [session.id, b.exercise_id, b.template_exercise_id ?? null, b.section ?? null,
       b.order_index ?? null, b.notes ?? null]
    );
    res.status(201).json({ data: rows[0] });
  }));

router.post('/performances/:id/sets', auth, STAFF, validate(schemas.setCreate), wrap(async (req, res) => {
  try {
    const out = await service.logSet(req, req.params.id, req.body);
    // 200 rather than 201 for a replay: the row already existed, and the
    // client's retry logic should be able to tell.
    res.status(out.duplicate ? 200 : 201).json({ data: out.row, duplicate: out.duplicate });
  } catch (err) { sendError(res, err); }
}));

router.post('/performances/:id/cardio', auth, STAFF, validate(schemas.cardioCreate), wrap(async (req, res) => {
  try {
    const out = await service.logCardio(req, req.params.id, req.body);
    res.status(out.duplicate ? 200 : 201).json({ data: out.row, duplicate: out.duplicate });
  } catch (err) { sendError(res, err); }
}));

router.patch('/sets/:id', auth, STAFF, validate(schemas.setUpdate), wrap(async (req, res) => {
  if (!await authz.loadSet(req, req.params.id)) return notFound(res, 'Set');
  const { sets, values } = patchFrom(req.body, [
    'set_number', 'set_type', 'planned_reps', 'actual_reps', 'planned_weight', 'actual_weight',
    'weight_unit', 'planned_rpe', 'actual_rpe', 'planned_rir', 'actual_rir',
    'tempo', 'rest_seconds', 'duration_seconds', 'completed', 'failure', 'notes',
  ], 2);
  if (!sets.length) return notFound(res, 'Nothing to update');
  const { rows } = await pool.query(
    `UPDATE set_performances SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [req.params.id, ...values]
  );
  res.json({ data: rows[0] });
}));

router.delete('/sets/:id', auth, STAFF, wrap(async (req, res) => {
  if (!await authz.loadSet(req, req.params.id)) return notFound(res, 'Set');
  await pool.query('DELETE FROM set_performances WHERE id = $1', [req.params.id]);
  res.json({ data: { id: req.params.id, deleted: true } });
}));

router.patch('/cardio/:id', auth, STAFF, validate(schemas.cardioUpdate), wrap(async (req, res) => {
  if (!await authz.loadCardio(req, req.params.id)) return notFound(res, 'Cardio effort');
  const { sets, values } = patchFrom(req.body, [
    'cardio_type', 'duration_seconds', 'distance', 'distance_unit', 'average_speed', 'max_speed',
    'speed_unit', 'incline', 'resistance', 'average_heart_rate', 'max_heart_rate',
    'calories_burned', 'pace_seconds', 'pace_distance', 'cadence', 'floors_completed',
    'steps_completed', 'elevation_gain',
    'work_interval_seconds', 'rest_interval_seconds', 'rounds_completed', 'rpe', 'completed', 'notes',
  ], 2);
  if (!sets.length) return notFound(res, 'Nothing to update');
  const { rows } = await pool.query(
    `UPDATE cardio_performances SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [req.params.id, ...values]
  );
  res.json({ data: rows[0] });
}));

// ═══ Meta ══════════════════════════════════════════════════════════════════
//
// The vocabulary, served rather than duplicated.
//
// The builder needs to know which fields a prescription type uses — that is
// what makes the field set change when a trainer switches an exercise from
// SETS_REPS to TIME_DISTANCE. Hard-coding that map in the frontend would put
// a second copy of it in another repository, and the two would drift the
// first time a type gained a field. The failure is quiet in the worst way:
// the UI offers a field the API ignores, or hides one the API needs.
//
// So prescription.js stays the only definition and this endpoint publishes
// it. Static per deploy, cacheable, and cheap.
router.get('/meta', auth, STAFF, (_req, res) => {
  res.json({
    data: {
      prescription_types: prescription.PRESCRIPTION_TYPES.map((type) => ({
        type,
        required: prescription.FIELDS[type].required,
        optional: prescription.FIELDS[type].optional,
        fields: prescription.fieldsFor(type),
        logs_as: prescription.performanceKind(type),
      })),
      sections: prescription.SECTIONS,
      progression_types: require('./progression').PROGRESSION_TYPES,
      record_types: require('./records').RECORD_TYPES,
      set_types: ['WARMUP', 'WORKING', 'BACKOFF', 'DROP', 'AMRAP', 'FAILURE', 'CUSTOM'],
      cardio_types: [
        'TREADMILL', 'RUNNING', 'CYCLING', 'STATIONARY_BIKE', 'ROWING', 'ELLIPTICAL',
        'STAIRMASTER', 'STEP_MILL', 'SKI_ERG', 'SWIMMING', 'WALKING', 'SKATING',
        'PROWLER', 'JUMP_ROPE', 'HIIT', 'CIRCUIT', 'OTHER',
      ],
      units: { weight: ['kg', 'lb'], distance: ['m', 'km', 'mile'] },
    },
  });
});

// ═══ Records ═══════════════════════════════════════════════════════════════

router.get('/records', auth, STAFF, wrap(async (req, res) => {
  const clientId = req.query.client_id;
  if (!clientId) {
    return res.status(400).json({ error: { code: 'CLIENT_REQUIRED', message: 'client_id is required' } });
  }
  if (!await authz.canAccessClient(req, clientId)) return notFound(res, 'Client');
  const params = [clientId];
  // Live records by default; ?history=1 includes superseded ones, which is
  // the query the old boolean flags could not answer at all.
  const history = req.query.history === '1' || req.query.history === 'true';
  const { rows } = await pool.query(
    `SELECT * FROM personal_records
      WHERE client_id = $1 ${history ? '' : 'AND superseded_at IS NULL'}
      ORDER BY achieved_on DESC, created_at DESC LIMIT 200`,
    params
  );
  res.json({ data: rows });
}));

module.exports = router;

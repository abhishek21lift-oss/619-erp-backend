'use strict';
// Data access for the training domain.
//
// ── Why this file exists ────────────────────────────────────────────────────
//
// The target architecture is route → service → repository → database, and
// training.service.js already says so in its own header: "The routes below
// this are thin on purpose — they validate, authorise, and call in here."
// That was true for the session lifecycle it owns and had never been true for
// anything else: training.routes.js still issued 27 SQL literals of its own,
// so the adapter was also the data layer for programmes, templates and
// assignments.
//
// This file is where that SQL belongs. It is separate from
// training.service.js rather than appended to it because the two do different
// jobs, and that file is explicit about its own: everything that "spans more
// than one table, or that has to be all-or-nothing, lives in this file inside
// a transaction". Programme and template CRUD is neither. Folding plain reads
// and single-row writes into a file about transactional session lifecycle
// would blur the one boundary that module already gets right.
//
// ── Why these functions take `req` ──────────────────────────────────────────
//
// A repository coupled to HTTP is not the textbook shape, and it is the shape
// this module already uses: every exported function in training.service.js
// takes `req` first (createSession(req, body), startSession(req, sessionId)).
// The reason is authorisation — authz.orgWhere() and authz.trainerWhere()
// derive their SQL fragments and bind parameters from the caller's identity,
// and the tenant boundary must be applied in the same statement that reads the
// rows, not bolted on by whoever remembers to.
//
// Passing `req` keeps that single-statement guarantee. Threading an
// "identity" object through instead would be tidier and would be a second
// convention in one module; consistency wins here, and the day authz stops
// needing `req`, both files change together.
//
// ── Scope ───────────────────────────────────────────────────────────────────
//
// Everything training.routes.js used to reach the database for: programmes,
// phases and weeks; templates and their prescriptions; assignments; the
// session list and patch; performances, sets and cardio; personal records.
// The adapter now holds no SQL at all, which is why its entry has gone from
// the layering budget in architecture.layering.convention.test.js — that
// register only ever ratchets down, and a file that reaches zero is deleted
// from it rather than left at zero.
//
// What deliberately did NOT move: authorisation (authz.js walks back to the
// client before any of these run), prescription validation (a coaching rule,
// prescription.js), the screening gate, and query-string parsing. Those are
// decisions about the REQUEST. This file is told which row to touch, never
// whether the caller may.
//
// The multi-table, all-or-nothing session lifecycle stays in
// training.service.js — see the note above about why the two files are
// separate. The one transaction here (reorder) is a single statement that
// must not half-apply, not a lifecycle.

const pool = require('../../db/pool');
const authz = require('./authz');
const { orgIdOf } = require('../../lib/tenant-db');

/**
 * Build a SET clause from the fields a caller is allowed to patch.
 *
 * Lives here rather than in the adapter because it writes SQL, which is the
 * whole point of the layer. It is not exported any more: every caller is now
 * a function in this file, and re-exporting it would invite the adapter to
 * start composing SQL again.
 *
 * `startAt` is the first bind index, so a caller that has already bound $1
 * (usually the row id) passes 2.
 */
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

const PROGRAM_PATCH_COLS = [
  'name', 'description', 'goal', 'program_type', 'duration_weeks',
  'status', 'start_date', 'end_date', 'notes', 'client_id',
];

/**
 * Programmes visible to this caller, newest first.
 *
 * A trainer who is not admin/manager sees programmes for their own clients
 * plus the studio's unassigned templates (client_id IS NULL) — carried over
 * exactly, because narrowing it would hide a studio's shared programmes from
 * the trainers who use them.
 */
async function listPrograms(req, { clientId, status } = {}) {
  const params = [];
  const org = authz.orgWhere(req, params, 'p.organization_id');
  const filters = [];
  if (clientId) { params.push(clientId); filters.push(`p.client_id = $${params.length}`); }
  if (status) { params.push(status); filters.push(`p.status = $${params.length}`); }

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
  return rows;
}

/** The phases and weeks hanging off one programme, in display order. */
async function loadProgramParts(programId) {
  const [phases, weeks] = await Promise.all([
    pool.query('SELECT * FROM training_program_phases WHERE program_id = $1 ORDER BY phase_order', [programId]),
    pool.query('SELECT * FROM training_program_weeks  WHERE program_id = $1 ORDER BY week_number', [programId]),
  ]);
  return { phases: phases.rows, weeks: weeks.rows };
}

async function createProgram(req, b) {
  const { rows } = await pool.query(
    `INSERT INTO training_programs
       (organization_id, client_id, created_by, name, description, goal, program_type,
        duration_weeks, start_date, end_date, notes)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'GENERAL_FITNESS'),$8,$9,$10,$11) RETURNING *`,
    [orgIdOf(req), b.client_id ?? null, req.user.id, b.name, b.description ?? null,
      b.goal ?? null, b.program_type ?? null, b.duration_weeks ?? null,
      b.start_date ?? null, b.end_date ?? null, b.notes ?? null]
  );
  return rows[0];
}

/**
 * Patch a programme.
 *
 * Returns null when the body named no patchable field, so the adapter can
 * keep answering that case exactly as it did rather than issuing an UPDATE
 * with an empty SET clause.
 */
async function updateProgram(programId, body) {
  const { sets, values } = patchFrom(body, PROGRAM_PATCH_COLS, 2);
  if (!sets.length) return null;
  const { rows } = await pool.query(
    `UPDATE training_programs SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [programId, ...values]
  );
  return rows[0];
}

/**
 * Soft delete. Sessions logged against this programme stay readable, which is
 * the whole reason historical rows are never hard-deleted.
 */
async function softDeleteProgram(programId) {
  await pool.query('UPDATE training_programs SET deleted_at = NOW() WHERE id = $1', [programId]);
}

async function createPhase(programId, b) {
  const { rows } = await pool.query(
    `INSERT INTO training_program_phases (program_id, name, phase_order, week_start, week_end, goal, notes)
     VALUES ($1,$2,COALESCE($3,1),$4,$5,$6,$7) RETURNING *`,
    [programId, b.name, b.phase_order ?? null, b.week_start, b.week_end, b.goal ?? null, b.notes ?? null]
  );
  return rows[0];
}

/** Upsert, keyed on (program_id, week_number) — re-posting a week edits it. */
async function upsertWeek(programId, b) {
  const { rows } = await pool.query(
    `INSERT INTO training_program_weeks (program_id, phase_id, week_number, name, notes, is_deload)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6,false))
     ON CONFLICT (program_id, week_number) DO UPDATE
        SET phase_id = EXCLUDED.phase_id, name = EXCLUDED.name,
            notes = EXCLUDED.notes, is_deload = EXCLUDED.is_deload, updated_at = NOW()
     RETURNING *`,
    [programId, b.phase_id ?? null, b.week_number, b.name ?? null, b.notes ?? null, b.is_deload ?? null]
  );
  return rows[0];
}

// ── Templates and prescriptions ─────────────────────────────────────────────

/** The columns a prescription may be created or patched with. */
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

/** A studio's template library, optionally narrowed to one programme or week. */
async function listTemplates(req, { programId, weekId } = {}) {
  const params = [];
  const org = authz.orgWhere(req, params);
  const filters = [];
  if (programId) { params.push(programId); filters.push(`program_id = $${params.length}`); }
  if (weekId)    { params.push(weekId);    filters.push(`week_id = $${params.length}`); }

  const { rows } = await pool.query(
    `SELECT * FROM workout_templates
      WHERE deleted_at IS NULL${org} ${filters.length ? `AND ${filters.join(' AND ')}` : ''}
      ORDER BY day_number NULLS LAST, name LIMIT 200`,
    params
  );
  return rows;
}

/**
 * One template's prescriptions in display order, each carrying its exercise
 * name.
 *
 * The LEFT JOIN is deliberate: an exercise deleted from the library must not
 * make the day it appears in disappear.
 */
async function loadTemplateExercises(templateId) {
  const { rows } = await pool.query(
    `SELECT wte.*, e.name AS exercise_name
       FROM workout_template_exercises wte
       LEFT JOIN exercises e ON e.id = wte.exercise_id
      WHERE wte.workout_template_id = $1
      ORDER BY wte.section, wte.order_index`,
    [templateId]
  );
  return rows;
}

async function createTemplate(req, b) {
  const { rows } = await pool.query(
    `INSERT INTO workout_templates
       (organization_id, program_id, week_id, created_by, name, description,
        day_number, day_label, goal, estimated_duration_minutes, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [orgIdOf(req), b.program_id ?? null, b.week_id ?? null, req.user.id, b.name,
      b.description ?? null, b.day_number ?? null, b.day_label ?? null, b.goal ?? null,
      b.estimated_duration_minutes ?? null, b.notes ?? null]
  );
  return rows[0];
}

/**
 * Add a prescription to a template.
 *
 * The column list is built from the fields actually present so a column left
 * out keeps its database default, rather than being written as an explicit
 * NULL over one. Names come from PRESCRIPTION_COLS and never from the request,
 * so the interpolation cannot carry caller input into the statement.
 */
async function createPrescription(templateId, row) {
  const cols = PRESCRIPTION_COLS.filter((c) => row[c] !== undefined);
  const { rows } = await pool.query(
    `INSERT INTO workout_template_exercises (workout_template_id, ${cols.join(', ')})
     VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`,
    [templateId, ...cols.map((c) => row[c])]
  );
  return rows[0];
}

/**
 * One prescription, scoped to its template.
 *
 * The template id is part of the WHERE rather than a separate check: the
 * caller has already established that IT owns the template, and matching both
 * ids in one statement is what makes reaching a prescription through the wrong
 * template impossible rather than merely unlikely.
 */
async function loadPrescription(templateId, id) {
  const { rows } = await pool.query(
    'SELECT * FROM workout_template_exercises WHERE id = $1 AND workout_template_id = $2',
    [id, templateId]
  );
  return rows[0] ?? null;
}

/** Patch a prescription. Null when the body named no patchable field. */
async function updatePrescription(id, body) {
  const { sets, values } = patchFrom(body, PRESCRIPTION_COLS, 2);
  if (!sets.length) return null;
  const { rows } = await pool.query(
    `UPDATE workout_template_exercises SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [id, ...values]
  );
  return rows[0];
}

/** Delete a prescription, scoped to its template. True when a row went. */
async function deletePrescription(templateId, id) {
  const { rowCount } = await pool.query(
    'DELETE FROM workout_template_exercises WHERE id = $1 AND workout_template_id = $2',
    [id, templateId]
  );
  return rowCount > 0;
}

/**
 * Reorder a template's prescriptions to the given sequence.
 *
 * One statement with an ordinality-derived index rather than a loop: a partial
 * reorder that failed halfway would leave the day scrambled.
 */
async function reorderPrescriptions(templateId, exerciseIds) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE workout_template_exercises wte
          SET order_index = v.idx - 1, updated_at = NOW()
         FROM unnest($2::uuid[]) WITH ORDINALITY AS v(id, idx)
        WHERE wte.id = v.id AND wte.workout_template_id = $1`,
      [templateId, exerciseIds]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
  return exerciseIds.length;
}

// ── Assignments ─────────────────────────────────────────────────────────────

const ASSIGNMENT_PATCH_COLS = ['status', 'scheduled_date', 'notes'];

/**
 * Assignments visible to this caller, with the template and client names the
 * board renders.
 *
 * The JOIN to pt_clients is not decoration: assignments are client-bound, so
 * this is where authz's trainer rule gets a client row to apply itself to.
 */
async function listAssignments(req, { clientId, date, status } = {}) {
  const params = [];
  const org = authz.orgWhere(req, params, 'a.organization_id');
  const trainer = authz.trainerWhere(req, params);
  const filters = [];
  if (clientId) { params.push(clientId); filters.push(`a.client_id = $${params.length}`); }
  if (date)     { params.push(date);     filters.push(`a.scheduled_date = $${params.length}`); }
  if (status)   { params.push(status);   filters.push(`a.status = $${params.length}`); }

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
  return rows;
}

/**
 * Assign a template to a client.
 *
 * Two things are derived in SQL rather than in the caller, both because the
 * database is the only place that can answer them consistently: an omitted
 * trainer falls back to the client's own trainer, and the status follows from
 * whether a date was given — an assignment with no date is ASSIGNED, one with
 * a date is SCHEDULED.
 */
async function createAssignment(req, b) {
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
  return rows[0];
}

/** Patch an assignment. Null when the body named no patchable field. */
async function updateAssignment(id, body) {
  const { sets, values } = patchFrom(body, ASSIGNMENT_PATCH_COLS, 2);
  if (!sets.length) return null;
  const { rows } = await pool.query(
    `UPDATE training_assignments SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id, ...values]
  );
  return rows[0];
}

// ── Sessions ────────────────────────────────────────────────────────────────

const SESSION_PATCH_COLS = ['client_notes', 'trainer_notes', 'overall_rpe', 'session_date'];

/**
 * Logged sessions visible to this caller, newest first.
 *
 * `limit` is already clamped by the adapter, which is where a query string is
 * parsed. It is bound, never interpolated — boundedReads.convention.test.js
 * pins that this query really carries the LIMIT rather than merely computing
 * one.
 */
async function listSessions(req, { clientId, status, limit } = {}) {
  const params = [];
  const org = authz.orgWhere(req, params, 's.organization_id');
  const trainer = authz.trainerWhere(req, params);
  const filters = [];
  if (clientId) { params.push(clientId); filters.push(`s.client_id = $${params.length}`); }
  if (status)   { params.push(status);   filters.push(`s.status = $${params.length}`); }
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT s.* FROM training_sessions s
       JOIN pt_clients c ON c.id = s.client_id
      WHERE s.deleted_at IS NULL AND c.deleted_at IS NULL${org}${trainer}
        ${filters.length ? `AND ${filters.join(' AND ')}` : ''}
      ORDER BY s.session_date DESC, s.created_at DESC LIMIT $${params.length}`,
    params
  );
  return rows;
}

/** Patch a session's notes. Null when the body named no patchable field. */
async function updateSession(id, body) {
  const { sets, values } = patchFrom(body, SESSION_PATCH_COLS, 2);
  if (!sets.length) return null;
  const { rows } = await pool.query(
    `UPDATE training_sessions SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id, ...values]
  );
  return rows[0];
}

// ── Performances, sets and cardio ───────────────────────────────────────────

const SET_PATCH_COLS = [
  'set_number', 'set_type', 'planned_reps', 'actual_reps', 'planned_weight', 'actual_weight',
  'weight_unit', 'planned_rpe', 'actual_rpe', 'planned_rir', 'actual_rir',
  'tempo', 'rest_seconds', 'duration_seconds', 'completed', 'failure', 'notes',
];

const CARDIO_PATCH_COLS = [
  'cardio_type', 'duration_seconds', 'distance', 'distance_unit', 'average_speed', 'max_speed',
  'speed_unit', 'incline', 'resistance', 'average_heart_rate', 'max_heart_rate',
  'calories_burned', 'pace_seconds', 'pace_distance', 'cadence', 'floors_completed',
  'steps_completed', 'elevation_gain',
  'work_interval_seconds', 'rest_interval_seconds', 'rounds_completed', 'rpe', 'completed', 'notes',
];

/**
 * Add an exercise to a logged session.
 *
 * The name is snapshotted from the library at log time and falls back to
 * 'Exercise' — a session logged years ago must still read correctly after the
 * exercise it used has been renamed or removed. The order index defaults to
 * one past the current maximum, computed in the same statement so two devices
 * logging at once cannot both claim the same slot.
 */
async function createPerformance(sessionId, b) {
  const { rows } = await pool.query(
    `INSERT INTO exercise_performances
       (session_id, exercise_id, template_exercise_id, exercise_name, section, order_index, notes)
     VALUES ($1,$2,$3,COALESCE((SELECT name FROM exercises WHERE id = $2), 'Exercise'),$4,
             COALESCE($5, (SELECT COALESCE(MAX(order_index),-1)+1 FROM exercise_performances WHERE session_id=$1)),$6)
     RETURNING *`,
    [sessionId, b.exercise_id, b.template_exercise_id ?? null, b.section ?? null,
      b.order_index ?? null, b.notes ?? null]
  );
  return rows[0];
}

/** Patch a set. Null when the body named no patchable field. */
async function updateSet(id, body) {
  const { sets, values } = patchFrom(body, SET_PATCH_COLS, 2);
  if (!sets.length) return null;
  const { rows } = await pool.query(
    `UPDATE set_performances SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id, ...values]
  );
  return rows[0];
}

async function deleteSet(id) {
  await pool.query('DELETE FROM set_performances WHERE id = $1', [id]);
}

/** Patch a cardio effort. Null when the body named no patchable field. */
async function updateCardio(id, body) {
  const { sets, values } = patchFrom(body, CARDIO_PATCH_COLS, 2);
  if (!sets.length) return null;
  const { rows } = await pool.query(
    `UPDATE cardio_performances SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id, ...values]
  );
  return rows[0];
}

// ── Records ─────────────────────────────────────────────────────────────────

/**
 * A client's personal records.
 *
 * Live records by default; `history` includes superseded ones, which is the
 * query the old boolean flags could not answer at all. The caller has already
 * established that it may see this client — personal_records carries no
 * organization_id of its own.
 */
async function listRecords(clientId, { history = false } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM personal_records
      WHERE client_id = $1 ${history ? '' : 'AND superseded_at IS NULL'}
      ORDER BY achieved_on DESC, created_at DESC LIMIT 200`,
    [clientId]
  );
  return rows;
}

module.exports = {
  // Programmes
  listPrograms,
  loadProgramParts,
  createProgram,
  updateProgram,
  softDeleteProgram,
  createPhase,
  upsertWeek,
  // Templates and prescriptions
  listTemplates,
  loadTemplateExercises,
  createTemplate,
  createPrescription,
  loadPrescription,
  updatePrescription,
  deletePrescription,
  reorderPrescriptions,
  // Assignments
  listAssignments,
  createAssignment,
  updateAssignment,
  // Sessions
  listSessions,
  updateSession,
  // Performances, sets and cardio
  createPerformance,
  updateSet,
  deleteSet,
  updateCardio,
  // Records
  listRecords,
};

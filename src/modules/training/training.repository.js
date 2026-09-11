'use strict';
// Data access for the training domain.
//
// ── Why this file exists ────────────────────────────────────────────────────
//
// The target architecture is route → repository → database. training.routes.js
// once issued 27 SQL literals of its own, so the adapter was also the data
// layer for programmes, templates and assignments. This file is where that SQL
// belongs.
//
// It used to sit beside training.service.js, which owned the transactional
// session lifecycle. That file is gone: the session half of this module was a
// staging copy of the pt-os workout log that production never adopted, and
// migration 193 archived its tables. What remains here is programme and
// template CRUD — plain reads and single-row writes, which is all this layer
// was ever meant to hold.
//
// ── Why these functions take `req` ──────────────────────────────────────────
//
// A repository coupled to HTTP is not the textbook shape, and it is the shape
// this module already used when the service layer beside it existed: every
// exported function took `req` first. The reason is authorisation — authz.orgWhere() and authz.trainerWhere()
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
};

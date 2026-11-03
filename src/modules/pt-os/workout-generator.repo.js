'use strict';

// Data access for the workout generator.
//
// The SQL lives here, not in the route adapter — the layering convention test
// (architecture.layering.convention.test.js) is absolute for files absent
// from its debt register, and a new module has no business adding to it.
//
// Both reads are tenant-scoped by an explicit organization id. NULL org binds
// no rows, which is the fail-closed behaviour the rest of the tenant layer
// shares; the caller never passes an org it was not authenticated for.

const pool = require('../../db/pool');
const { findVisibleExercise } = require('../../lib/exercise-access');

/** The client row the generator needs, or null when it is not this org's. */
async function findClientForOrg(clientId, organizationId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.goal, c.workout_experience_level, c.injuries,
            c.sessions_per_week, c.preferred_training_days, c.frequency,
            c.session_minutes, c.equipment, c.updated_at, c.organization_id
       FROM pt_clients c
      WHERE c.id = $1 AND c.deleted_at IS NULL AND c.organization_id = $2`,
    [clientId, organizationId],
  );
  return rows[0] || null;
}

/**
 * Everything the shared fact resolver needs to answer "what is this client's
 * goal and experience level" from the records the rest of the product writes.
 *
 * The rules generator used to read pt_clients.goal and
 * pt_clients.workout_experience_level directly. The AI generator reads the
 * ACTIVE pt_goals row first, then the fitness profile, then that column — so
 * the two doors could program the same client for different goals. This loads
 * the same sources so both resolve the same way.
 *
 * Returns null when the client is not this org's, before any child query runs.
 */
async function loadClientFactSources(clientId, organizationId) {
  const client = await findClientForOrg(clientId, organizationId);
  if (!client) return null;

  const [profile, goals, lifestyle] = await Promise.all([
    pool.query(
      `SELECT goal, fitness_level
         FROM client_fitness_profiles WHERE client_id = $1 LIMIT 1`,
      [clientId],
    ),
    pool.query(
      `SELECT goal_type, training_days_per_week, preferred_training_days
         FROM pt_goals WHERE client_id = $1 AND is_active = true
        ORDER BY created_at DESC LIMIT 3`,
      [clientId],
    ),
    pool.query(
      `SELECT workout_experience_level
         FROM pt_lifestyle_assessments WHERE client_id = $1
        ORDER BY assessment_date DESC, created_at DESC LIMIT 1`,
      [clientId],
    ),
  ]);

  return {
    client,
    profile: profile.rows[0] || null,
    goals: goals.rows,
    lifestyle: lifestyle.rows[0] || null,
  };
}

/**
 * The exercise pool: shared built-ins (organization_id IS NULL) plus the org's
 * custom exercises. Archived and soft-deleted rows are never candidates.
 */
async function listLibraryPool(organizationId) {
  const { rows } = await pool.query(
    `SELECT e.id, e.name, e.mechanic, e.movement_pattern AS "movementPattern",
            e.difficulty, e.category_id,
            m.name AS "primaryMuscle",
            q.name AS equipment,
            cat.name AS category
       FROM exercises e
       LEFT JOIN muscles m           ON m.id = e.primary_muscle_id
       LEFT JOIN equipment_types q   ON q.id = e.equipment_id
       LEFT JOIN exercise_categories cat ON cat.id = e.category_id
      WHERE e.deleted_at IS NULL
        AND e.archived_at IS NULL
        AND (e.organization_id IS NULL OR e.organization_id = $1)`,
    [organizationId],
  );
  return rows;
}

/**
 * The trainer's current training max per exercise, for one client.
 *
 * One row per (client, exercise) is the table's contract, so this is a plain
 * list. The generator maps it by exercise id; a lift with no row is prescribed
 * by RPE rather than by a guessed percentage.
 */
async function listTrainingMaxes(clientId, organizationId) {
  const { rows } = await pool.query(
    `SELECT exercise_id, training_max_kg, source_e1rm_kg, source, notes, updated_at
       FROM workout_training_maxes
      WHERE client_id = $1 AND organization_id = $2
      ORDER BY updated_at DESC`,
    [clientId, organizationId],
  );
  return rows;
}

/**
 * Set or replace one training max. The trainer owns this number; the route
 * validates the shape and the exercise's visibility before calling here.
 */
async function upsertTrainingMax({
  clientId, organizationId, exerciseId, trainingMaxKg,
  sourceE1rmKg = null, source = 'manual', notes = null, createdBy = null,
}) {
  const { rows } = await pool.query(
    `INSERT INTO workout_training_maxes
       (organization_id, client_id, exercise_id, training_max_kg,
        source_e1rm_kg, source, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (client_id, exercise_id) DO UPDATE
       SET training_max_kg = EXCLUDED.training_max_kg,
           source_e1rm_kg = EXCLUDED.source_e1rm_kg,
           source         = EXCLUDED.source,
           notes          = EXCLUDED.notes,
           updated_at     = NOW()
     RETURNING exercise_id, training_max_kg, source_e1rm_kg, source, notes, updated_at`,
    [organizationId, clientId, exerciseId, trainingMaxKg,
      sourceE1rmKg, source, notes, createdBy],
  );
  return rows[0] || null;
}

/**
 * Every logged set for the client's competition lifts.
 *
 * The e1RM is computed in JS by powerlifting.js rather than in SQL so there is
 * one formula in the product, not two. The row cap keeps a long history from
 * turning a suggestions screen into a full-table read; the route only needs
 * the best set, and 2000 recent sets is far more than that requires.
 */
async function listCompetitionSets(clientId, exerciseIds) {
  if (!Array.isArray(exerciseIds) || !exerciseIds.length) return [];
  const { rows } = await pool.query(
    `SELECT wse.exercise_id, s.weight_kg, s.reps, s.rpe, ws.session_date
       FROM workout_sets s
       JOIN workout_session_exercises wse ON wse.id = s.session_exercise_id
       JOIN workout_sessions ws ON ws.id = wse.session_id
      WHERE ws.client_id = $1
        AND wse.exercise_id = ANY($2::text[])
        AND s.completed = true
        AND s.weight_kg IS NOT NULL
        AND s.reps IS NOT NULL
      ORDER BY ws.session_date DESC
      LIMIT 2000`,
    [clientId, exerciseIds],
  );
  return rows;
}

module.exports = {
  findClientForOrg,
  loadClientFactSources,
  listLibraryPool,
  listTrainingMaxes,
  upsertTrainingMax,
  listCompetitionSets,
  findVisibleExercise,
};
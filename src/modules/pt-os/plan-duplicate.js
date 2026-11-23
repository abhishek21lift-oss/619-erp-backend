'use strict';
// Copying a programme: one transaction, two tables.
//
// The route already authorised `source` (loadEditablePlan) and owns the
// response; the SQL lives here, next to the other training repositories. Both
// INSERTs are `SELECT`-from-source inside the caller's transaction, so a
// concurrent edit cannot produce a plan that is half the old prescription.
//
// Deliberately NOT a version snapshot: version/parent_plan_id describe one
// plan's history, and a duplicate is a new programme.

const { randomUUID } = require('crypto');

/**
 * @param {import('pg').PoolClient} client  transaction already begun
 * @param {{ source: object, name: string, createdBy: string }} args
 * @returns {Promise<{ plan: object, copied_exercises: number } | null>}
 *   null when the source vanished between the caller's SELECT and this INSERT.
 */
async function duplicatePlan(client, { source, name, createdBy }) {
  const id = randomUUID();

  const { rows } = await client.query(
    `INSERT INTO workout_plans (
       id, name, description, goal, difficulty, duration_weeks, sessions_per_week,
       progression_type, progression_amount, progression_every_weeks,
       warmup_protocol, mobility_protocol, cooldown_protocol,
       periodization_model, split_name, block_phases,
       deload_every_weeks, deload_intensity_pct,
       is_template, is_active, created_by, organization_id, version, parent_plan_id)
     SELECT $1, $2, description, goal, difficulty, duration_weeks, sessions_per_week,
            progression_type, progression_amount, progression_every_weeks,
            warmup_protocol, mobility_protocol, cooldown_protocol,
            periodization_model, split_name, block_phases,
            deload_every_weeks, deload_intensity_pct,
            false, true, $3, organization_id, 1, NULL
       FROM workout_plans WHERE id = $4
     RETURNING *`,
    [id, name, createdBy, source.id],
  );
  if (!rows.length) return null;

  const { rowCount } = await client.query(
    `INSERT INTO workout_exercises (
       id, workout_plan_id, exercise_id, day_of_week, week_number, sort_order,
       sets, reps, rest_seconds, notes, target_weight, tempo, rpe, rir,
       warmup_sets, superset_group, alternatives, cues, config)
     SELECT gen_random_uuid()::text, $1, exercise_id, day_of_week, week_number, sort_order,
            sets, reps, rest_seconds, notes, target_weight, tempo, rpe, rir,
            warmup_sets, superset_group, alternatives, cues, config
       FROM workout_exercises WHERE workout_plan_id = $2`,
    [id, source.id],
  );

  return { plan: rows[0], copied_exercises: rowCount };
}

module.exports = { duplicatePlan };

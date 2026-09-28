'use strict';

/**
 * A workout programme's shape: goal, difficulty and length.
 *
 * Kept beside the routes rather than in them because the SQL budget in
 * architecture.layering.convention.test.js caps what routes/workouts.js may
 * hold, and this is the rule both the create and the edit path apply.
 */

// Mirrors workout_plans_goal_check (migration 219) and
// workout_plans_difficulty_check (migration 006). Checked here as well so a
// bad value is a 400 that names the field, not a constraint violation that
// surfaces as a 500.
const PLAN_GOALS = ['weight_loss', 'muscle_gain', 'strength', 'endurance', 'general_fitness', 'recovery'];
const PLAN_DIFFICULTIES = ['beginner', 'intermediate', 'advanced'];

// The progression engine's own ceiling (pt-os/progression MAX_WEEKS). The
// app's forms stop at 52, but a longer plan that already exists must still
// accept an edit to its other fields.
const WEEKS_MIN = 1;
const { MAX_WEEKS: WEEKS_MAX } = require('../modules/pt-os/progression');

/**
 * The first problem with the shape fields present on `d`, or null.
 * Absent fields are fine — create has defaults and edit keeps what is stored.
 */
function shapeError(d) {
  if (d.goal != null && d.goal !== '' && !PLAN_GOALS.includes(d.goal)) {
    return `goal must be one of: ${PLAN_GOALS.join(', ')}`;
  }
  if (d.difficulty != null && d.difficulty !== '' && !PLAN_DIFFICULTIES.includes(d.difficulty)) {
    return `difficulty must be one of: ${PLAN_DIFFICULTIES.join(', ')}`;
  }
  if (d.duration_weeks != null && d.duration_weeks !== '') {
    const w = Number(d.duration_weeks);
    if (!Number.isInteger(w) || w < WEEKS_MIN || w > WEEKS_MAX) {
      return `duration_weeks must be a whole number from ${WEEKS_MIN} to ${WEEKS_MAX}`;
    }
  }
  return null;
}

/**
 * Move the end date of every live assignment of a plan to match its length.
 *
 * An assignment's end date is derived on assign: start + weeks − 1 day, so a
 * 4-week programme started Monday ends on the fourth Sunday. When the
 * programme's length is edited, the assignments running it follow.
 *
 * Only DERIVED dates move — rows whose end date is still exactly what the old
 * length gave. Two kinds of row are left alone:
 *
 *   · an end date the trainer set when assigning (POST /assign takes one as
 *     an override), which a shared plan's length must not silently rewrite;
 *   · NULL, meaning "open-ended" — assignments made before end dates were
 *     derived. Turning that into a date after the fact could make a
 *     programme a client is still on disappear from the Today roster without
 *     anyone having decided it should.
 *
 * `organization_id` is a UUID column, so the parameter is cast to uuid — a
 * text parameter has no `uuid = text` operator and the whole edit 500'd.
 */
async function syncAssignmentEnds(db, planId, oldWeeks, newWeeks, orgId) {
  const from = Number(oldWeeks);
  const to = Number(newWeeks);
  if (!Number.isInteger(from) || from < WEEKS_MIN) return;
  if (!Number.isInteger(to) || to < WEEKS_MIN || to === from) return;
  await db.query(
    `UPDATE workout_assignments
        SET end_date = start_date + ($3::int * 7 - 1), updated_at = NOW()
      WHERE workout_plan_id = $1
        AND status = 'active'
        AND end_date = start_date + ($2::int * 7 - 1)
        AND ($4::uuid IS NULL OR organization_id = $4::uuid)`,
    [planId, from, to, orgId ?? null]
  );
}

module.exports = { PLAN_GOALS, PLAN_DIFFICULTIES, shapeError, syncAssignmentEnds };

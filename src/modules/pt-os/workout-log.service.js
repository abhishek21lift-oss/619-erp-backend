'use strict';
// The workout-log rules that more than one writer needs.
//
// The trainer's workout log (workout-log.routes.js) and the member app's
// self-logged workouts (client-portal/member-training.service.js) both write
// sets and complete sessions. A personal best, and a plan's progress, must
// mean the same thing whichever of them wrote the row — so the rules live
// here, once.

const pool = require('../../db/pool');

// Recomputes a linked assignment's progress_pct from how many distinct
// completed sessions have been logged against it, relative to the plan's
// target (sessions_per_week * duration_weeks). The only writer of
// progress_pct outside the trainer's manual PUT /assignments/:id/progress.
//
// Scoped to the studio as well as the id: the callers have already checked
// the assignment is theirs, and this keeps it that way if one ever does not.
async function recomputeAssignmentProgress(assignmentId, orgId, db = pool) {
  if (!assignmentId) return;
  const { rows } = await db.query(
    `SELECT wp.sessions_per_week, wp.duration_weeks,
            (SELECT COUNT(DISTINCT ws.id) FROM workout_sessions ws
              WHERE ws.workout_assignment_id = wa.id AND ws.status = 'completed') AS completed_count
       FROM workout_assignments wa
       JOIN workout_plans wp ON wp.id = wa.workout_plan_id
      WHERE wa.id = $1 AND wa.organization_id = $2`,
    [assignmentId, orgId]
  );
  const row = rows[0];
  if (!row) return;
  const target = (row.sessions_per_week || 0) * (row.duration_weeks || 0);
  const pct = target > 0 ? Math.min(100, Math.round((row.completed_count / target) * 100)) : 0;
  await db.query(
    'UPDATE workout_assignments SET progress_pct = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3',
    [pct, assignmentId, orgId]
  );
}

// Never trust a client-submitted "is this a PR" flag — always recompute
// against the client's prior completed sets for the same exercise
// (matched by exercise_id when the exercise is in the library, else by
// name for ad-hoc entries). The name match ignores case and surrounding
// spaces, the way records and streaks group exercises: "Back Squat" and
// "back squat " are one lift, and an exact match made the second spelling
// read as a first-ever set — a personal best on every set.
async function computePrFlags(client, { clientId, orgId, exerciseId, exerciseName, weight, reps, excludeSetId = null }) {
  if (weight == null || reps == null) return { is_pr_weight: false, is_pr_reps: false, is_pr_volume: false };

  const matchClause = exerciseId ? 'wse.exercise_id = $3' : 'lower(btrim(wse.exercise_name)) = lower(btrim($3))';
  const matchParam = exerciseId || exerciseName;
  const params = [clientId, orgId, matchParam];
  let excludeClause = '';
  if (excludeSetId) { params.push(excludeSetId); excludeClause = `AND s.id != $${params.length}`; }

  const { rows } = await client.query(
    `SELECT MAX(s.weight_kg) AS max_weight, MAX(s.reps) AS max_reps, MAX(s.weight_kg * s.reps) AS max_volume
       FROM workout_sets s
       JOIN workout_session_exercises wse ON wse.id = s.session_exercise_id
       JOIN workout_sessions ws ON ws.id = wse.session_id
      WHERE ws.client_id = $1 AND ws.organization_id = $2 AND ${matchClause} AND s.completed = true ${excludeClause}`,
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

module.exports = { recomputeAssignmentProgress, computePrFlags };

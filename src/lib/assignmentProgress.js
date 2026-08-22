'use strict';

// How far through an assignment a client is.
//
// Extracted from pt-os/workout-log.routes.js so the voice surface can reuse
// the SAME progress recomputation the app performs when a session's status
// changes, rather than carrying a second copy that drifts. The logic is
// unchanged.
//
// It is called after any write that can change how many sessions are
// completed: without it, `workout_assignments.progress_pct` keeps whatever
// value it had before, and a client who finished a session sees the same
// percentage as yesterday.

const pool = require('../db/pool');

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

module.exports = { recomputeAssignmentProgress };

'use strict';
// src/modules/progress/habits.repo.js
// SQL for the daily journal, its preferences, and trainer insight reviews.
// Callers pass the organization; the client is always checked against it in
// the route before any of these run.

const pool = require('../../db/pool');

const LOG_COLUMNS = [
  'sleep_hours', 'sleep_quality', 'water_ml', 'electrolytes', 'steps', 'steps_source',
  'stress_level', 'energy_level', 'fatigue_level', 'soreness_level', 'recovery_level',
  'notes', 'source',
];

async function getLog(orgId, clientId, logDate) {
  const { rows } = await pool.query(
    `SELECT * FROM client_habit_logs
      WHERE organization_id = $1 AND client_id = $2 AND log_date = $3`,
    [orgId, clientId, logDate]
  );
  return rows[0] || null;
}

async function listLogs(orgId, clientId, fromDate, toDate) {
  const { rows } = await pool.query(
    `SELECT * FROM client_habit_logs
      WHERE organization_id = $1 AND client_id = $2
        AND log_date BETWEEN $3 AND $4
      ORDER BY log_date ASC`,
    [orgId, clientId, fromDate, toDate]
  );
  return rows;
}

async function upsertLog(orgId, clientId, logDate, values, userId) {
  const cols = LOG_COLUMNS.filter((c) => Object.prototype.hasOwnProperty.call(values, c));
  const params = [orgId, clientId, logDate, userId || null];
  const insertCols = ['organization_id', 'client_id', 'log_date', 'created_by', ...cols];
  const placeholders = insertCols.map((_, i) => `$${i + 1}`);
  const updates = cols.map((c) => `${c} = EXCLUDED.${c}`);
  updates.push('updated_by = EXCLUDED.created_by', 'updated_at = NOW()');
  const { rows } = await pool.query(
    `INSERT INTO client_habit_logs (${insertCols.join(', ')})
     VALUES (${placeholders.join(', ')})
     ON CONFLICT (client_id, log_date) DO UPDATE SET ${updates.join(', ')}
     RETURNING *`,
    [...params, ...cols.map((c) => values[c])]
  );
  return rows[0];
}

async function getPreferences(orgId, clientId) {
  const { rows } = await pool.query(
    `SELECT * FROM client_habit_preferences
      WHERE organization_id = $1 AND client_id = $2`,
    [orgId, clientId]
  );
  return rows[0] || null;
}

async function upsertPreferences(orgId, clientId, prefs) {
  const { rows } = await pool.query(
    `INSERT INTO client_habit_preferences
       (organization_id, client_id, sleep_target_min, sleep_target_max,
        water_target_ml, step_target, reminder_enabled, reminder_time, wearable_provider)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (client_id) DO UPDATE
       SET sleep_target_min = EXCLUDED.sleep_target_min,
           sleep_target_max = EXCLUDED.sleep_target_max,
           water_target_ml = EXCLUDED.water_target_ml,
           step_target = EXCLUDED.step_target,
           reminder_enabled = EXCLUDED.reminder_enabled,
           reminder_time = EXCLUDED.reminder_time,
           wearable_provider = EXCLUDED.wearable_provider,
           updated_at = NOW()
     RETURNING *`,
    [orgId, clientId, prefs.sleepTargetMin, prefs.sleepTargetMax,
      prefs.waterTargetMl, prefs.stepTarget, prefs.reminderEnabled,
      prefs.reminderTime, prefs.wearableProvider]
  );
  return rows[0];
}

async function activeGoal(orgId, clientId) {
  const { rows } = await pool.query(
    `SELECT * FROM pt_goals
      WHERE client_id = $1 AND (organization_id = $2 OR organization_id IS NULL)
        AND is_active = TRUE
      ORDER BY created_at DESC LIMIT 1`,
    [clientId, orgId]
  );
  return rows[0] || null;
}

/**
 * Completed workout sessions in the window and the current programme's weekly
 * frequency. Frequency is returned, never multiplied here: the caller decides
 * whether a percentage is meaningful for the window length.
 */
async function workoutAdherence(orgId, clientId, fromDate, toDate) {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM workout_sessions
         WHERE organization_id = $1 AND client_id = $2
           AND session_date BETWEEN $3 AND $4 AND status = 'completed') AS completed,
       (SELECT COALESCE(wp.sessions_per_week, 0)::int
          FROM workout_assignments wa
          JOIN workout_plans wp ON wp.id = wa.workout_plan_id
         WHERE wa.client_id = $2 AND wa.organization_id = $1 AND wa.status = 'active'
         ORDER BY wa.start_date DESC LIMIT 1) AS sessions_per_week`,
    [orgId, clientId, fromDate, toDate]
  );
  return rows[0] || { completed: 0, sessions_per_week: 0 };
}

async function insertInsightReview(orgId, clientId, review, userId) {
  const { rows } = await pool.query(
    `INSERT INTO progress_insight_reviews
       (organization_id, client_id, insight_key, insight_type, title,
        observation, recommendation, decision, reviewed_by, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [orgId, clientId, review.insight_key, review.insight_type, review.title,
      review.observation || null, review.recommendation || null,
      review.decision, userId || null, review.notes || null]
  );
  return rows[0];
}

async function listInsightReviews(orgId, clientId, limit = 50) {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const { rows } = await pool.query(
    `SELECT * FROM progress_insight_reviews
      WHERE organization_id = $1 AND client_id = $2
      ORDER BY created_at DESC LIMIT $3`,
    [orgId, clientId, cap]
  );
  return rows;
}

module.exports = {
  getLog, listLogs, upsertLog, getPreferences, upsertPreferences,
  activeGoal, workoutAdherence, insertInsightReview, listInsightReviews,
};

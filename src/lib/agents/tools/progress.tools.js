'use strict';
const { z }    = require('zod');
const pool     = require('../../../db/pool');
const { toolRegistry } = require('../registry/ToolRegistry');
const { PermissionValidator } = require('../middleware/PermissionValidator');

// ─── Tool implementations ────────────────────────────────────────────────────

async function getAssessments({ client_id, limit = 5 }, context) {
  const { rows } = await pool.query(
    `SELECT weight_kg, body_fat_pct, chest_cm, waist_cm, hips_cm,
            thigh_cm, arm_cm, bmi, notes, created_at
     FROM pt_assessments WHERE client_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [client_id, limit]
  );
  return { client_id, count: rows.length, assessments: rows };
}

async function getCheckins({ client_id, limit = 8 }, context) {
  const { rows } = await pool.query(
    `SELECT weight_kg, mood, energy_level, sleep_hours, water_ml, notes, created_at
     FROM weekly_checkins WHERE client_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [client_id, limit]
  );
  return { client_id, count: rows.length, checkins: rows };
}

async function getStrengthLogs({ client_id, limit = 20 }, context) {
  const { rows } = await pool.query(
    `SELECT exercise_name, max_weight_kg, reps, notes, created_at
     FROM strength_logs WHERE client_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [client_id, limit]
  );
  return { client_id, count: rows.length, strength_logs: rows };
}

async function getProgressSummary({ client_id }, context) {
  const [clientRes, assessRes, checkinRes, goalsRes, attRes] = await Promise.all([
    pool.query(`SELECT first_name || ' ' || last_name AS name, dob, gender, pt_start_date FROM pt_clients WHERE id=$1 AND deleted_at IS NULL`, [client_id]),
    pool.query(`SELECT weight_kg, body_fat_pct, created_at FROM pt_assessments WHERE client_id=$1 ORDER BY created_at ASC`, [client_id]),
    pool.query(`SELECT weight_kg, mood, energy_level, sleep_hours, created_at FROM weekly_checkins WHERE client_id=$1 ORDER BY created_at DESC LIMIT 4`, [client_id]),
    pool.query(`SELECT goal_type, target_value, unit, status FROM pt_goals WHERE client_id=$1 AND status='active' LIMIT 3`, [client_id]),
    pool.query(`SELECT COUNT(*) AS sessions_total FROM pt_sessions WHERE client_id=$1`, [client_id]),
  ]);

  const client = clientRes.rows[0];
  if (!client) throw new Error('Client not found');

  return {
    client:          client,
    assessment_trend: assessRes.rows,
    recent_checkins:  checkinRes.rows,
    active_goals:     goalsRes.rows,
    sessions_total:   Number(attRes.rows[0]?.sessions_total || 0),
  };
}

// ─── Registration ────────────────────────────────────────────────────────────

toolRegistry
  .register('progress.getAssessments',
    getAssessments,
    z.object({
      client_id: z.union([z.string(), z.number()]),
      limit:     z.number().int().max(20).optional(),
    }),
    ['admin','manager','trainer'],
    false
  )
  .register('progress.getCheckins',
    getCheckins,
    z.object({
      client_id: z.union([z.string(), z.number()]),
      limit:     z.number().int().max(50).optional(),
    }),
    ['admin','manager','trainer'],
    false
  )
  .register('progress.getStrengthLogs',
    getStrengthLogs,
    z.object({
      client_id: z.union([z.string(), z.number()]),
      limit:     z.number().int().max(100).optional(),
    }),
    ['admin','manager','trainer'],
    false
  )
  .register('progress.getSummary',
    getProgressSummary,
    z.object({ client_id: z.union([z.string(), z.number()]) }),
    ['admin','manager','trainer'],
    false
  );

module.exports = { getAssessments, getCheckins, getStrengthLogs, getProgressSummary };

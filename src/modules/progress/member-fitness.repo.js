'use strict';
// src/modules/progress/member-fitness.repo.js
// Read-only SQL for the member's own fitness-testing view.
//
// The trainer module reads `SELECT *`; a member-facing payload gets an
// explicit column list instead, so a future column (an internal note, an
// audit trail) cannot reach the portal by being added to the table. Every
// statement takes the organization from the caller and the client id from the
// session, never from the request.

const pool = require('../../db/pool');

// Everything the member dashboard renders: the stored overall total, the seven
// category points it shows, the readings behind them, and the vitals and body
// measurements that sit under those categories. Trainer-only notes, audit
// columns and the raw test JSON are deliberately absent — the portal is a
// result view, not the assessment record.
const ASSESSMENT_COLUMNS = `
  id, assessment_number, assessment_date, assessment_type,
  overall_fitness_score, overall_points, overall_max, scoring_formula_version,
  bp_points, anthropometric_points,
  body_composition_score, cardio_score_computed, strength_score_computed,
  endurance_score_computed, mobility_score_computed,
  bp_systolic, bp_diastolic, bp_category,
  resting_heart_rate, rhr_category, resting_spo2, spo2_category,
  weight, height_cm, bmi, bmi_category, body_fat_pct, muscle_mass_pct, lean_body_mass_kg, fat_mass_kg,
  waist_cm, waist_iliac_cm, hips_cm, waist_hip_ratio, waist_risk, whr_risk,
  visceral_fat, body_water_pct, body_comp_method,
  cardio_test_type, vo2_max, cardio_category,
  strength_exercise, strength_exercise_2, strength_category, strength_category_2,
  endurance_test_type, endurance_test_type_2, endurance_category, endurance_category_2,
  flexibility_category, flexibility_category_2, has_asymmetry,
  testing_conditions
`;

async function client(orgId, clientId) {
  const { rows } = await pool.query(
    `SELECT name, gender FROM pt_clients
      WHERE organization_id = $1 AND id = $2`,
    [orgId, clientId]
  );
  return rows[0] || null;
}

async function assessments(orgId, clientId) {
  const { rows } = await pool.query(
    `SELECT ${ASSESSMENT_COLUMNS} FROM pt_assessments
      WHERE organization_id = $1 AND client_id = $2
      ORDER BY assessment_date DESC, created_at DESC`,
    [orgId, clientId]
  );
  return rows;
}

async function latestMobility(orgId, clientId) {
  const { rows } = await pool.query(
    `SELECT id, assessment_date, mobility_score, mobility_category
       FROM pt_mobility_performance_assessments
      WHERE organization_id = $1 AND client_id = $2
      ORDER BY assessment_date DESC, created_at DESC
      LIMIT 1`,
    [orgId, clientId]
  );
  return rows[0] || null;
}

module.exports = { client, assessments, latestMobility };

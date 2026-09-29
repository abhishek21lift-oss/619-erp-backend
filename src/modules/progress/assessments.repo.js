'use strict';
// src/modules/progress/assessments.repo.js
// SQL for fitness tests and the cross-form reads the assessment routes need,
// kept out of the HTTP adapter (progress.routes.js) per the layering rule.
//
// Every read that takes an id from a request is pinned to the caller's
// organization with orgWhere(). The helpers that take a client_id are only
// ever called after clientInOrg() has already checked that client.
const pool = require('../../db/pool');
const { orgWhere } = require('../../lib/tenant-db');
const strengthLogs = require('./strength-logs.repo');

const JSONB = new Set(['cardio_test_data', 'strength_test_data', 'endurance_test_data', 'flexibility_test_data']);

const placeholders = (keys, offset = 0) =>
  keys.map((k, i) => `$${i + 1 + offset}${JSONB.has(k) ? '::jsonb' : ''}`);

/**
 * Inserts a fitness test and numbers it per client.
 *
 * The number used to be `(SELECT COUNT(*)+1 ...)` inside the INSERT, so two
 * saves for the same client at the same moment could both become
 * "Assessment 3". A transaction-scoped advisory lock on the client makes the
 * count and the insert one step. Column names come from the route, never
 * from the request.
 */
async function insertAssessment(cols) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pt_assessments:${cols.client_id}`]);
    const { rows: next } = await tx.query(
      'SELECT COUNT(*)::int + 1 AS n FROM pt_assessments WHERE client_id = $1', [cols.client_id]
    );
    const record = { ...cols, assessment_number: next[0].n };
    const keys = Object.keys(record);
    const { rows } = await tx.query(
      `INSERT INTO pt_assessments (${keys.join(', ')}) VALUES (${placeholders(keys).join(', ')}) RETURNING *`,
      keys.map((k) => record[k])
    );
    await tx.query('COMMIT');
    return rows[0];
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}

async function findAssessment(req, id) {
  const params = [id];
  const org = orgWhere(req, params);
  const { rows } = await pool.query(`SELECT * FROM pt_assessments WHERE id = $1${org}`, params);
  return rows[0] || null;
}

/** `id` must already be one the caller's organization owns (findAssessment). */
async function updateAssessment(id, cols) {
  const keys = Object.keys(cols);
  const sets = keys.map((k, i) => `${k} = ${placeholders([k], i + 1)[0]}`);
  const { rows } = await pool.query(
    `UPDATE pt_assessments SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id, ...keys.map((k) => cols[k])]
  );
  return rows[0];
}

/** Removes the test and the lifts it recorded. Returns false when not found. */
async function deleteAssessment(req, id) {
  const found = await findAssessment(req, id);
  if (!found) return false;
  await pool.query('DELETE FROM strength_logs WHERE assessment_id = $1', [id]);
  await pool.query('DELETE FROM pt_assessments WHERE id = $1', [id]);
  return true;
}

/**
 * The 1RM a fitness test measured, written where Strength Tracking reads.
 * A 1RM tested in Fitness used to exist only inside the test's JSON, so the
 * Strength page said "No baseline logged yet" the day after a squat test.
 * Replaced whole on every save of the test, so an edit cannot leave a stale
 * lift behind.
 */
async function replaceAssessmentLifts(assessment, lifts) {
  await pool.query('DELETE FROM strength_logs WHERE assessment_id = $1', [assessment.id]);
  const logDate = String(assessment.assessment_date instanceof Date
    ? assessment.assessment_date.toISOString() : assessment.assessment_date || '').slice(0, 10) || null;
  for (const l of lifts) {
    await strengthLogs.insertLog({
      clientId: assessment.client_id, exerciseName: l.exerciseName, weightKg: l.weightKg,
      setsDone: 1, repsDone: l.reps, oneRm: l.oneRm, notes: 'Recorded in a fitness test',
      assessmentId: assessment.id, formula: l.formula, direct: l.direct,
      organizationId: assessment.organization_id, logDate,
    });
  }
}

/**
 * The latest measured body, onto the client record — the one place Enrollment,
 * the PAR-Q autofill and the profile read it from. Nothing wrote these
 * columns before, so all three showed blank.
 */
async function updateClientBody(clientId, organizationId, weight, heightCm) {
  if (weight == null && heightCm == null) return;
  await pool.query(
    `UPDATE pt_clients SET weight = COALESCE($3, weight), height = COALESCE($4, height)
      WHERE id = $1 AND organization_id = $2`,
    [clientId, organizationId, weight ?? null, heightCm ?? null]
  );
}

/** Training experience, from the client record Enrollment writes. */
async function clientExperience(clientId) {
  const { rows } = await pool.query('SELECT workout_experience_level FROM pt_clients WHERE id = $1', [clientId]);
  return rows[0]?.workout_experience_level || null;
}

/**
 * What the latest Nutrition assessment says about water and meals. Nutrition
 * is where those questions live; Lifestyle and Goal read them from here
 * instead of asking again.
 */
async function latestNutritionHabits(clientId) {
  const { rows } = await pool.query(
    `SELECT water_intake_liters, meals_per_day, breakfast_regularity, late_night_eating
       FROM pt_nutrition_assessments WHERE client_id = $1
      ORDER BY assessment_date DESC, created_at DESC LIMIT 1`,
    [clientId]
  );
  return rows[0] || {};
}

/** Smoking and alcohol live in Lifestyle; Nutrition's risk reads them. */
async function latestLifestyleHabits(clientId) {
  const { rows } = await pool.query(
    `SELECT smoking_status, alcohol_status, drinks_per_week
       FROM pt_lifestyle_assessments WHERE client_id = $1
      ORDER BY assessment_date DESC, created_at DESC LIMIT 1`,
    [clientId]
  );
  return rows[0] || {};
}

/**
 * One active goal per client. Every new goal used to stay active beside the
 * old ones, and whatever read "the client's goal" took the newest by luck.
 */
async function deactivateOtherGoals(clientId, organizationId, keepId) {
  await pool.query(
    `UPDATE pt_goals SET is_active = false, updated_at = NOW()
      WHERE client_id = $1 AND organization_id = $2 AND id <> $3 AND is_active = true`,
    [clientId, organizationId, keepId]
  );
}

module.exports = {
  insertAssessment, findAssessment, updateAssessment, deleteAssessment, replaceAssessmentLifts,
  updateClientBody, clientExperience, latestNutritionHabits, latestLifestyleHabits, deactivateOtherGoals,
};

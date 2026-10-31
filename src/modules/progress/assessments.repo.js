'use strict';
// src/modules/progress/assessments.repo.js
// SQL for fitness tests and the cross-form reads the assessment routes need,
// kept out of the HTTP adapter (progress.routes.js) per the layering rule.
//
// Every read that takes an id from a request is pinned to the caller's
// organization with orgWhere(). The helpers that take a client_id are only
// ever called after clientInOrg() has already checked that client.
const pool = require('../../db/pool');
const { orgWhere, orgIdOf } = require('../../lib/tenant-db');
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
// `client` is an optional transaction connection supplied by the caller (F6
// atomicity). When omitted, this function owns its transaction (legacy callers).
async function insertAssessment(cols, client = null) {
  const own = !client;
  const tx = client || await pool.connect();
  try {
    if (own) await tx.query('BEGIN');
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pt_assessments:${cols.client_id}`]);
    // MAX (not COUNT) so a deleted assessment does not get its number reused (F11).
    const { rows: next } = await tx.query(
      'SELECT COALESCE(MAX(assessment_number), 0)::int + 1 AS n FROM pt_assessments WHERE client_id = $1', [cols.client_id]
    );
    const record = { ...cols, assessment_number: next[0].n };
    const keys = Object.keys(record);
    const { rows } = await tx.query(
      `INSERT INTO pt_assessments (${keys.join(', ')}) VALUES (${placeholders(keys).join(', ')}) RETURNING *`,
      keys.map((k) => record[k])
    );
    if (own) await tx.query('COMMIT');
    return rows[0];
  } catch (err) {
    if (own) await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    if (own) tx.release();
  }
}

async function findAssessment(req, id) {
  const params = [id];
  const org = orgWhere(req, params);
  const { rows } = await pool.query(`SELECT * FROM pt_assessments WHERE id = $1${org}`, params);
  return rows[0] || null;
}

/** `id` must already be one the caller's organization owns (findAssessment). */
async function updateAssessment(id, organizationId, cols, client = null) {
  const c = client || pool;
  const keys = Object.keys(cols);
  const sets = keys.map((k, i) => `${k} = ${placeholders([k], i + 1)[0]}`);
  const orgClause = organizationId != null ? ` AND organization_id = $${keys.length + 2}` : '';
  const params = [id, ...keys.map((k) => cols[k])];
  if (organizationId != null) params.push(organizationId);
  const { rows } = await c.query(
    `UPDATE pt_assessments SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1${orgClause} RETURNING *`,
    params
  );
  return rows[0];
}

/** Removes the test and the lifts it recorded. Returns false when not found. */
async function deleteAssessment(req, id, client = null) {
  const found = await findAssessment(req, id);
  if (!found) return false;
  const own = !client;
  const c = client || await pool.connect();
  const orgId = orgIdOf(req);
  try {
    if (own) await c.query('BEGIN');
    await c.query(`DELETE FROM strength_logs WHERE assessment_id = $1 AND organization_id = $2`, [id, orgId]);
    await c.query(`DELETE FROM pt_assessments WHERE id = $1 AND organization_id = $2`, [id, orgId]);
    if (own) await c.query('COMMIT');
    return true;
  } catch (err) {
    if (own) await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    if (own) c.release();
  }
}

/**
 * The 1RM a fitness test measured, written where Strength Tracking reads.
 * A 1RM tested in Fitness used to exist only inside the test's JSON, so the
 * Strength page said "No baseline logged yet" the day after a squat test.
 * Replaced whole on every save of the test, so an edit cannot leave a stale
 * lift behind.
 */
async function replaceAssessmentLifts(assessment, lifts, client = null) {
  const c = client || pool;
  await c.query('DELETE FROM strength_logs WHERE assessment_id = $1', [assessment.id]);
  const logDate = String(assessment.assessment_date instanceof Date
    ? assessment.assessment_date.toISOString() : assessment.assessment_date || '').slice(0, 10) || null;
  for (const l of lifts) {
    await strengthLogs.insertLog({
      clientId: assessment.client_id, exerciseName: l.exerciseName, weightKg: l.weightKg,
      setsDone: 1, repsDone: l.reps, oneRm: l.oneRm, notes: 'Recorded in a fitness test',
      assessmentId: assessment.id, formula: l.formula, direct: l.direct,
      organizationId: assessment.organization_id, logDate,
      client,
    });
  }
}

/**
 * The latest measured body, onto the client record — the one place Enrollment,
 * the PAR-Q autofill and the profile read it from. Nothing wrote these
 * columns before, so all three showed blank.
 */
async function updateClientBody(clientId, organizationId, weight, heightCm, client = null) {
  if (weight == null && heightCm == null) return;
  const c = client || pool;
  await c.query(
    `UPDATE pt_clients SET weight = COALESCE($3, weight), height = COALESCE($4, height)
      WHERE id = $1 AND organization_id = $2`,
    [clientId, organizationId, weight ?? null, heightCm ?? null]
  );
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
 * The full list the assessment page shows, newest first. The GET handler
 * rescored only the first row, so it needs the list and then a rewrite of
 * that row; both live here rather than in the adapter.
 */
async function listLifestyleAssessments(req, clientId) {
  const params = [clientId];
  const org = orgWhere(req, params);
  const { rows } = await pool.query(
    `SELECT * FROM pt_lifestyle_assessments WHERE client_id = $1${org} ORDER BY assessment_date DESC, created_at DESC`,
    params
  );
  return rows;
}

async function listNutritionAssessments(req, clientId) {
  const params = [clientId];
  const org = orgWhere(req, params);
  const { rows } = await pool.query(
    `SELECT * FROM pt_nutrition_assessments WHERE client_id = $1${org} ORDER BY assessment_date DESC, created_at DESC`,
    params
  );
  return rows;
}

/**
 * Rewrites the derived score columns on one row. `cols` keys come from
 * lifestyleAnalysisColumns()/nutritionAnalysisColumns(), never from a request.
 * updated_at is deliberately untouched: this is the same assessment, freshly
 * scored against the other module's latest answer.
 */
async function updateLifestyleScores(req, id, cols) {
  const params = [id];
  const sets = Object.keys(cols).map((col) => { params.push(cols[col]); return `${col} = $${params.length}`; });
  const org = orgWhere(req, params);
  await pool.query(`UPDATE pt_lifestyle_assessments SET ${sets.join(', ')} WHERE id = $1${org}`, params);
}

async function updateNutritionScores(req, id, cols) {
  const params = [id];
  const sets = Object.keys(cols).map((col) => { params.push(cols[col]); return `${col} = $${params.length}`; });
  const org = orgWhere(req, params);
  await pool.query(`UPDATE pt_nutrition_assessments SET ${sets.join(', ')} WHERE id = $1${org}`, params);
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
  updateClientBody, latestNutritionHabits, latestLifestyleHabits, deactivateOtherGoals,
  listLifestyleAssessments, listNutritionAssessments, updateLifestyleScores, updateNutritionScores,
};

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

/** Removes the test and the lifts it recorded. Returns the deleted row, or null. */
async function deleteAssessment(req, id, client = null) {
  const found = await findAssessment(req, id);
  if (!found) return null;
  const own = !client;
  const c = client || await pool.connect();
  const orgId = orgIdOf(req);
  try {
    if (own) await c.query('BEGIN');
    await c.query(`DELETE FROM strength_logs WHERE assessment_id = $1 AND organization_id = $2`, [id, orgId]);
    await c.query(`DELETE FROM pt_assessments WHERE id = $1 AND organization_id = $2`, [id, orgId]);
    if (own) await c.query('COMMIT');
    return found;
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
 * the PAR-Q autofill and the profile read it from.
 *
 * This is a CACHE of the latest test, not a second measurement. It used to be
 * called with whatever row was just saved, so editing a 2024 test in 2026 set
 * the client's current weight to the 2024 value. Deriving from
 * (assessment_date DESC, created_at DESC, id DESC) makes the cache a pure
 * function of the newest row: an older edit, or a backdated insert, cannot
 * move it backwards.
 *
 * No row at all leaves the previous value untouched rather than nulling it —
 * deleting the only test does not erase the last known body. The advisory lock
 * serialises concurrent create/delete for one client while the caller's
 * transaction is open; callers should pass their transaction when they have
 * one.
 */
async function syncClientBodyFromLatest(clientId, organizationId, client = null) {
  const c = client || pool;
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`client-body:${clientId}`]);
  await c.query(
    `UPDATE pt_clients c
        SET weight = latest.weight, height = latest.height_cm
       FROM (
         SELECT weight, height_cm
           FROM pt_assessments
          WHERE client_id = $1 AND organization_id = $2
          ORDER BY assessment_date DESC, created_at DESC, id DESC
          LIMIT 1
       ) latest
      WHERE c.id = $1 AND c.organization_id = $2`,
    [clientId, organizationId]
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

/**
 * The latest submitted PAR-Q, which owns the client's medical conditions.
 * A draft is not a confirmed screening, so it answers nothing here.
 */
async function latestParqMedical(clientId) {
  const { rows } = await pool.query(
    `SELECT current_health, past_history, parq_answers
       FROM pt_parq_forms
      WHERE client_id = $1 AND deleted_at IS NULL
        AND status IN ('submitted', 'reviewed')
      ORDER BY assessment_date DESC, created_at DESC LIMIT 1`,
    [clientId]
  );
  return rows[0] || null;
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
  syncClientBodyFromLatest, latestNutritionHabits, latestLifestyleHabits, latestParqMedical, deactivateOtherGoals,
  listLifestyleAssessments, listNutritionAssessments, updateLifestyleScores, updateNutritionScores,
};

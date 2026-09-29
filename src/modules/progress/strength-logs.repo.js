'use strict';
// src/modules/progress/strength-logs.repo.js
// SQL for strength logs, kept out of the HTTP adapter (progress.routes.js)
// per the layering rule. Every read and write is pinned to the caller's
// organization with orgWhere().
const pool = require('../../db/pool');
const { orgWhere } = require('../../lib/tenant-db');
const { today: studioToday } = require('../../lib/appTime');

async function assessmentBelongs(req, assessmentId, clientId) {
  const params = [assessmentId, clientId];
  const org = orgWhere(req, params);
  const { rowCount } = await pool.query(
    `SELECT 1 FROM pt_assessments WHERE id = $1 AND client_id = $2${org}`, params
  );
  return rowCount > 0;
}

async function insertLog(v) {
  const { rows } = await pool.query(
    `INSERT INTO strength_logs (client_id, exercise_name, weight_kg, sets_done, reps_done, one_rm_estimate, notes, assessment_id, one_rm_formula, is_direct_1rm, organization_id, log_date)
     VALUES ($1,$2,$3,$4,$5,ROUND($6::NUMERIC,2),$7,$8,$9,$10,$11,$12::date) RETURNING *`,
    // The studio's day, not the database's: CURRENT_DATE is UTC, which filed
    // a 5 AM lift in India under yesterday.
    [v.clientId, v.exerciseName, v.weightKg, v.setsDone, v.repsDone, v.oneRm, v.notes,
     v.assessmentId, v.formula, v.direct, v.organizationId, v.logDate || studioToday()]
  );
  return rows[0];
}

async function findLog(req, id) {
  const params = [id];
  const org = orgWhere(req, params);
  const { rows } = await pool.query(`SELECT * FROM strength_logs WHERE id = $1${org}`, params);
  return rows[0] || null;
}

async function updateLog(id, v) {
  const { rows } = await pool.query(
    `UPDATE strength_logs
        SET exercise_name = $2, weight_kg = $3, sets_done = $4, reps_done = $5,
            one_rm_estimate = ROUND($6::NUMERIC, 2), notes = $7, one_rm_formula = $8,
            is_direct_1rm = $9, log_date = $10::date
      WHERE id = $1 RETURNING *`,
    [id, v.exerciseName, v.weightKg, v.setsDone, v.repsDone, v.oneRm, v.notes, v.formula, v.direct, v.logDate]
  );
  return rows[0];
}

async function deleteLog(req, id) {
  const params = [id];
  const org = orgWhere(req, params);
  const { rowCount } = await pool.query(`DELETE FROM strength_logs WHERE id = $1${org}`, params);
  return rowCount > 0;
}

module.exports = { assessmentBelongs, insertLog, findLog, updateLog, deleteLog };

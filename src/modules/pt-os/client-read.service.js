'use strict';

const pool = require('../../db/pool');
const { hasPtTermSql, priorTermsPaidJoin, currentTermBalanceSql } = require('../../lib/ptTerm');
const { buildBrief } = require('./training-brief');
const { buildSnapshot } = require('./client-snapshot');
const { buildRecovery } = require('./recovery');
const { screeningSummary } = require('../../lib/screeningGate');
const svc = require('./pt-os.service');

/**
 * Authorization primitive: is this client visible to the organization?
 * Returns { id, name } or null.
 */
async function findVisibleClient(orgId, clientId) {
  const { rows } = await pool.query(
    `SELECT id, name FROM pt_clients WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
    [clientId, orgId]
  );
  return rows[0] || null;
}

/**
 * Client profile — mirrors GET /clients/:id in pt-os.routes.js
 * Returns the full client row with term-aware money and screening summary.
 */
async function getClientProfile(orgId, clientId) {
  const visible = await findVisibleClient(orgId, clientId);
  if (!visible) return null;

  const params = [clientId, orgId];
  const { rows } = await pool.query(`
    SELECT t.*,
           GREATEST(t.current_term_fee - t.current_term_paid, 0) AS current_term_balance,
           CASE
             WHEN GREATEST(t.current_term_fee - t.current_term_paid, 0) > 0
              AND t.pt_end_date IS NOT NULL AND t.pt_end_date::TEXT != ''
              AND t.pt_end_date::DATE < CURRENT_DATE THEN 'OVERDUE'
             WHEN GREATEST(t.current_term_fee - t.current_term_paid, 0) > 0 THEN 'DUE'
             ELSE 'CLEAR'
           END AS due_status
    FROM (
      SELECT c.*,
             ${hasPtTermSql('c')} AS has_pt_term,
             CASE
               WHEN c.pt_end_date IS NOT NULL AND c.pt_end_date::TEXT != ''
               THEN c.pt_end_date::DATE - CURRENT_DATE
               ELSE NULL
             END AS days_left,
             COALESCE(pp.total_incentives, 0) AS total_earned_commission,
             COALESCE(c.final_amount, 0) AS current_term_fee,
             GREATEST(COALESCE(c.paid_amount, 0) - COALESCE(prior.paid, 0), 0) AS current_term_paid
      FROM pt_clients c
      LEFT JOIN (
        SELECT client_id, SUM(incentive_amt) AS total_incentives
        FROM pt_payments
        WHERE deleted_at IS NULL
        GROUP BY client_id
      ) pp ON pp.client_id = c.id
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(s.amount_paid), 0) AS paid
        FROM pt_client_subscriptions s
        WHERE s.client_id = c.id
          AND s.start_date IS NOT NULL
          AND c.pt_start_date IS NOT NULL
          AND s.start_date < c.pt_start_date
      ) prior ON TRUE
      WHERE c.id = $1 AND c.deleted_at IS NULL AND c.organization_id = $2
    ) t
  `, params);

  if (rows.length === 0) return null;

  const client = rows[0];
  const screening = await screeningSummary(clientId);
  return { ...client, screening };
}

/**
 * Client snapshot — mirrors GET /clients/:id/snapshot in pt-os.routes.js
 * Returns alerts, goal card, PRs, coach prompts, and recovery.
 */
async function getClientSnapshot(orgId, clientId) {
  const visible = await findVisibleClient(orgId, clientId);
  if (!visible) return null;

  const params = [clientId, orgId];
  const { rows: clientRows } = await pool.query(
    `SELECT c.id, c.name, c.pt_end_date, c.organization_id,
            ${currentTermBalanceSql('c')} AS current_term_balance
       FROM pt_clients c
       ${priorTermsPaidJoin('c')}
      WHERE c.id = $1 AND c.deleted_at IS NULL AND c.organization_id = $2`,
    params
  );
  const client = clientRows[0];
  if (!client) return null;

  const many = (sql) => pool.query(sql, [clientId]).then((r) => r.rows);
  const one = (sql) => many(sql).then((rows) => rows[0] ?? null);

  const [lifestyle, measurements, assessments, goal, prRows, lastSession, checkins] = await Promise.all([
    one(`SELECT sleep_category, sleep_duration_hours, recovery_score, recovery_risk
           FROM pt_lifestyle_assessments WHERE client_id = $1
          ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
    many(`SELECT weight_kg, measured_at FROM pt_os_measurements
           WHERE client_id = $1 AND weight_kg IS NOT NULL
           ORDER BY measured_at DESC LIMIT 12`),
    many(`SELECT weight, assessment_date FROM pt_assessments
           WHERE client_id = $1 AND weight IS NOT NULL
           ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 12`),
    one(`SELECT goal_type, priority_goal, target_weight, starting_weight, target_date
           FROM pt_goals WHERE client_id = $1 AND is_active = true
          ORDER BY created_at DESC LIMIT 1`),
    many(`SELECT wse.exercise_name, s.weight_kg, s.reps, ws.session_date
            FROM workout_sets s
            JOIN workout_session_exercises wse ON wse.id = s.session_exercise_id
            JOIN workout_sessions ws ON ws.id = wse.session_id
           WHERE ws.client_id = $1
             AND (s.is_pr_weight OR s.is_pr_reps OR s.is_pr_volume)
           ORDER BY ws.session_date DESC LIMIT 60`),
    one(`SELECT session_date, status FROM workout_sessions
           WHERE client_id = $1 AND session_date <= CURRENT_DATE
           ORDER BY session_date DESC LIMIT 1`),
    many(`SELECT week_start_date, mood, sleep_hours, water_glasses,
                 stress_level, energy_level, soreness_level
            FROM weekly_checkins WHERE client_id = $1
           ORDER BY week_start_date DESC LIMIT 12`),
  ]);

  return {
    ...buildSnapshot({
      client, lifestyle, measurements, assessments, goal, prRows, lastSession,
    }),
    recovery: buildRecovery(checkins),
  };
}

/**
 * Training brief — mirrors GET /clients/:id/training-brief in pt-os.routes.js
 * Returns the assembled brief from all assessment sources.
 */
async function getClientTrainingBrief(orgId, clientId) {
  const visible = await findVisibleClient(orgId, clientId);
  if (!visible) return null;

  const params = [clientId, orgId];
  const { rows: clientRows } = await pool.query(
    `SELECT c.id, c.name, c.gender, c.dob, c.goal, c.injuries, c.notes, c.workout_experience_level, c.organization_id
       FROM pt_clients c WHERE c.id = $1 AND c.deleted_at IS NULL AND c.organization_id = $2`,
    params
  );
  const client = clientRows[0];
  if (!client) return null;

  const one = (sql) => pool.query(sql, [clientId]).then((r) => r.rows[0] ?? null);

  const [parq, assessment, posture, mobility, lifestyle, goal, assignment, sessions] = await Promise.all([
    one(`SELECT * FROM pt_parq_forms WHERE client_id = $1 AND deleted_at IS NULL
          ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
    one(`SELECT * FROM pt_assessments WHERE client_id = $1
          ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
    one(`SELECT * FROM pt_posture_assessments WHERE client_id = $1
          ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
    one(`SELECT * FROM pt_mobility_performance_assessments WHERE client_id = $1
          ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
    one(`SELECT * FROM pt_lifestyle_assessments WHERE client_id = $1
          ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
    one(`SELECT * FROM pt_goals WHERE client_id = $1 AND is_active = true
          ORDER BY created_at DESC LIMIT 1`),
    one(`SELECT wa.start_date, wa.progress_pct, wp.id AS plan_id, wp.name AS plan_name,
                wp.duration_weeks,
                (SELECT COUNT(DISTINCT we.day_of_week) FROM workout_exercises we
                  WHERE we.workout_plan_id = wp.id AND we.week_number = 1)::int AS planned_days_count
           FROM workout_assignments wa
           JOIN workout_plans wp ON wp.id = wa.workout_plan_id
          WHERE wa.client_id = $1 AND wa.status = 'active'
          ORDER BY wa.start_date DESC LIMIT 1`),
    pool.query(
      `SELECT status FROM workout_sessions
         WHERE client_id = $1 AND session_date >= CURRENT_DATE - INTERVAL '28 days'`,
      [clientId]
    ).then((r) => r.rows),
  ]);

  return buildBrief({
    client, parq, assessment, posture, mobility, lifestyle, goal, assignment, recentSessions: sessions,
  });
}

/**
 * Subscription history — mirrors GET /clients/:id/subscriptions in pt-os.routes.js
 * Returns array of subscription rows or null if client not visible.
 */
async function getClientSubscriptions(orgId, clientId) {
  const visible = await findVisibleClient(orgId, clientId);
  if (!visible) return null;

  const { rows } = await pool.query(`
    SELECT id, plan_name, start_date, end_date, duration_months,
           selling_price, amount_paid, balance_amount, trainer_name, status, source, created_at
    FROM pt_client_subscriptions
    WHERE client_id = $1
    ORDER BY start_date ASC NULLS LAST, created_at ASC
  `, [clientId]);
  return rows;
}

/**
 * Renewal history — mirrors GET /clients/:id/renewals in pt-os.routes.js
 * Returns array of renewal rows or null if client not visible.
 */
async function getClientRenewals(orgId, clientId) {
  const visible = await findVisibleClient(orgId, clientId);
  if (!visible) return null;

  const { rows } = await pool.query(
    `SELECT * FROM pt_client_renewals WHERE client_id = $1 ORDER BY renewed_at DESC`,
    [clientId]
  );
  return rows;
}

/**
 * Communication history — mirrors GET /clients/:id/communication in pt-os.routes.js
 * Returns array of communication log rows or null if client not visible.
 */
async function getClientCommunication(orgId, clientId) {
  const visible = await findVisibleClient(orgId, clientId);
  if (!visible) return null;

  const { rows } = await pool.query(`
    SELECT cl.*, c.name AS client_name
    FROM communication_logs cl
    LEFT JOIN pt_clients c ON c.id = cl.recipient_id
    WHERE cl.recipient_type = 'client' AND cl.recipient_id = $1
    ORDER BY cl.created_at DESC
    LIMIT 100
  `, [clientId]);
  return rows;
}

/**
 * Attendance history — mirrors GET /clients/:id/attendance in pt-os.routes.js
 * Delegates to pt-os.service.getClientAttendance with default paging.
 * Returns array of attendance rows or null if client not visible.
 */
async function getClientAttendance(orgId, clientId) {
  const visible = await findVisibleClient(orgId, clientId);
  if (!visible) return null;

  return svc.getClientAttendance(clientId, { limit: 200, offset: 0 });
}

/**
 * Payment history — mirrors GET /clients/:id/payments in pt-os.routes.js
 * Delegates to pt-os.service.getClientPayments with default paging.
 * Returns array of payment rows or null if client not visible.
 */
async function getClientPayments(orgId, clientId) {
  const visible = await findVisibleClient(orgId, clientId);
  if (!visible) return null;

  return svc.getClientPayments(clientId, { limit: 200, offset: 0 });
}

module.exports = {
  findVisibleClient,
  getClientProfile,
  getClientSnapshot,
  getClientTrainingBrief,
  getClientSubscriptions,
  getClientRenewals,
  getClientCommunication,
  getClientAttendance,
  getClientPayments,
};
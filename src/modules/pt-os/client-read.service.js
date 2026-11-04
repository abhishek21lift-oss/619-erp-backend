'use strict';

const pool = require('../../db/pool');
const { hasPtTermSql, priorTermsPaidJoin, currentTermBalanceSql } = require('../../lib/ptTerm');
const { buildBrief } = require('./training-brief');
const { buildSnapshot } = require('./client-snapshot');
const { buildRecovery } = require('./recovery');
const { loadClientSources } = require('./authoritative-client');
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
  // The balance lives on a wider select than the shared loader issues, so it
  // is read first and handed in; the loader then reads only the fact groups.
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

  const sources = await loadClientSources(clientId, orgId, {
    client, clinical: false, snapshot: true, checkins: true,
  });
  if (!sources) return null;

  return {
    ...buildSnapshot({
      client,
      lifestyle: sources.lifestyle,
      measurements: sources.measurements,
      assessments: sources.assessments,
      goal: sources.goal,
      prRows: sources.prRows,
      lastSession: sources.lastSession,
    }),
    recovery: buildRecovery(sources.checkins),
  };
}

/**
 * Training brief — mirrors GET /clients/:id/training-brief in pt-os.routes.js
 * Returns the assembled brief from all assessment sources.
 */
async function getClientTrainingBrief(orgId, clientId) {
  // The shared loader is the tenant gate too: no row, no child read.
  const sources = await loadClientSources(clientId, orgId, {
    clinical: true, training: true, interview: true, sessionDays: 28,
  });
  if (!sources) return null;

  return buildBrief({
    client: sources.client,
    parq: sources.parq,
    assessment: sources.latestAssessment,
    posture: sources.posture,
    mobility: sources.mobility,
    lifestyle: sources.lifestyle,
    interview: sources.interview,
    goal: sources.goal,
    assignment: sources.assignment,
    recentSessions: sources.sessions,
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
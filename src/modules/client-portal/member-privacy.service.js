'use strict';
// GET /api/me/export — everything the studio holds about one member.
//
// Read-only by construction: this file contains no INSERT, UPDATE or DELETE,
// and that is not an accident of the current code — opening an export must not
// change what the member sees next time they open the app. The messages read
// is deliberately a direct SELECT rather than messages.memberThread(), which
// marks the studio's messages read on open.
//
// The lists are whole, not paginated. A screen stops at 200 rows because a
// screen has to; an export that silently dropped the 201st payment would be a
// false document.

const pool = require('../../db/pool');
const portal = require('./client-portal.service');
const formChecks = require('../form-checks/form-check.service');

/** Mirrors the adapter's orgClause: filter only when the session knows a studio. */
function orgFilter(orgId, params, col = 'organization_id') {
  if (!orgId) return '';
  params.push(orgId);
  return ` AND ${col} = $${params.length}`;
}

async function listPayments(clientId, orgId) {
  const params = [clientId];
  const { rows } = await pool.query(
    `SELECT p.id, p.amount, p.date, p.payment_method, p.notes, p.created_at,
            mp.payment_order_id AS upi_order_id
       FROM pt_payments p
       LEFT JOIN pt_payment_activations mp ON mp.pt_payment_id = p.id
      WHERE p.client_id = $1 AND p.deleted_at IS NULL${orgFilter(orgId, params, 'p.organization_id')}
      ORDER BY p.date DESC, p.created_at DESC`,
    params,
  );
  return rows;
}

async function listAttendance(clientId, orgId) {
  const params = [clientId];
  const { rows } = await pool.query(
    `SELECT id, date, check_in_time, check_out_time, method, status
       FROM attendance_logs
      WHERE ref_id = $1 AND ref_type = 'client'${orgFilter(orgId, params)}
      ORDER BY date DESC, check_in_time DESC`,
    params,
  );
  return rows;
}

async function getMember(clientId, orgId) {
  const { rows } = await pool.query(
    `SELECT client_id AS member_code, name, email, mobile, whatsapp, gender, dob,
            address, package_type, goal, height, weight, joining_date,
            pt_start_date, pt_end_date, duration_months, status
       FROM pt_clients
      WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
    [clientId, orgId],
  );
  return rows[0] || null;
}

async function getMembership(clientId, orgId) {
  const { rows } = await pool.query(
    `SELECT id, package_type, base_amount, discount, final_amount,
            paid_amount, balance_amount, monthly_pt_amount,
            pt_start_date, pt_end_date, duration_months, status
       FROM pt_clients
      WHERE id = $1 AND deleted_at IS NULL AND organization_id = $2`,
    [clientId, orgId],
  );
  return rows[0] || null;
}

async function listGoals(clientId, orgId) {
  const { rows } = await pool.query(
    `SELECT id, kind, exercise_name, start_value, target_value, target_date,
            achieved_at, created_at
       FROM member_goals
      WHERE client_id = $1 AND organization_id = $2
      ORDER BY created_at`,
    [clientId, orgId],
  );
  return rows;
}

async function listMessages(clientId, orgId) {
  const { rows } = await pool.query(
    `SELECT sender, body, created_at, read_at
       FROM client_messages
      WHERE organization_id = $1 AND client_id = $2
      ORDER BY created_at`,
    [orgId, clientId],
  );
  return rows;
}

async function exportEverything(clientId, orgId, userId) {
  const [
    member, membership, payments, attendance, measurements,
    sessions, checkins, goals, progressPhotos, formChecks_, forms, achievements,
  ] = await Promise.all([
    getMember(clientId, orgId),
    getMembership(clientId, orgId),
    listPayments(clientId, orgId),
    listAttendance(clientId, orgId),
    portal.myMeasurements(clientId, orgId),
    portal.mySessions(clientId, orgId),
    portal.myCheckins(clientId, orgId),
    listGoals(clientId, orgId),
    portal.myPhotos(clientId, orgId, userId),
    formChecks.listForClient(clientId, orgId),
    portal.myForms(clientId, orgId),
    portal.myAchievements(clientId, orgId),
  ]);

  return {
    exported_at: new Date().toISOString(),
    member,
    membership,
    payments,
    attendance,
    measurements,
    sessions,
    checkins,
    goals,
    progress_photos: progressPhotos,
    form_checks: formChecks_,
    forms,
    messages: await listMessages(clientId, orgId),
    achievements,
  };
}

module.exports = { exportEverything };

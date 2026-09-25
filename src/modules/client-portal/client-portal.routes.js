'use strict';
// Everything a logged-in client can see, and nothing else.
//
// Mounted at /api/me behind auth + requireClient (see server.js). The single
// rule that makes this module safe is stated once here and obeyed everywhere
// below:
//
//   THE CLIENT ID COMES FROM req.user.pt_client_id. NEVER FROM THE REQUEST.
//
// No route in this file takes a client id, an org id or a trainer id as a
// parameter, a query value or a body field. There is nothing to tamper with,
// which is a stronger guarantee than checking that a supplied id matches —
// a check can be forgotten on the next route somebody adds, and an absent
// parameter cannot be.
//
// The org filter is belt-and-braces on top of that: pt_client_id is already
// unique platform-wide, so scoping by it alone is sufficient. The extra
// AND organization_id means a mistake in how the link was written cannot turn
// into a cross-tenant read.

const router = require('express').Router();
const pool = require('../../db/pool');
const portal = require('./client-portal.service');

/** Wrap an async handler so a rejection reaches the error middleware. */
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/**
 * The caller's own identity, from the session.
 *
 * A helper rather than four copies of `req.user.pt_client_id`, so that "which
 * client is this?" has exactly one answer in this file.
 */
function selfOf(req) {
  return { clientId: req.user.pt_client_id, orgId: req.user.organization_id || null };
}

/** `AND organization_id = $n`, or nothing when the session carries no org. */
function orgClause(orgId, params, col = 'organization_id') {
  if (!orgId) return '';
  params.push(orgId);
  return ` AND ${col} = $${params.length}`;
}

// ── GET /api/me/profile ──────────────────────────────────────────────────────
// The client's own record, and their trainer's public details.
//
// The column list is an allow-list, and deliberately narrow. `SELECT *` here
// would hand the client their own commission figures, internal notes and the
// studio's margin on them the moment somebody adds a column.
//
// trainer_photo is NULL, not t.photo_url: `trainers` has no photo column in
// any migration or in production. Selecting it made this route a 500 for
// every member, and the member dashboard — the first screen after sign-in —
// needs it, so the whole app read as broken. The field stays in the response
// so the client contract does not change; the dashboard shows initials.
router.get('/profile', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  const params = [clientId];
  const { rows } = await pool.query(
    `SELECT c.id, c.client_id AS member_code, c.name, c.email, c.mobile,
            c.gender, c.dob, c.photo_url, c.address,
            c.package_type, c.goal, c.height, c.weight,
            c.joining_date, c.pt_start_date, c.pt_end_date, c.duration_months,
            c.status,
            t.name AS trainer_name, NULL::text AS trainer_photo,
            t.specialization AS trainer_specialization,
            o.name AS studio_name, o.logo_url AS studio_logo
       FROM pt_clients c
       LEFT JOIN trainers t ON t.id = c.trainer_id AND t.organization_id = c.organization_id
       LEFT JOIN organizations o ON o.id = c.organization_id
      WHERE c.id = $1 AND c.deleted_at IS NULL${orgClause(orgId, params, 'c.organization_id')}`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Profile not found.' } });
  res.json({ data: rows[0] });
}));

// ── GET /api/me/membership ───────────────────────────────────────────────────
// What they bought and what they owe. Amounts they have a right to see —
// their own money — but nothing about what the studio keeps: trainer_commission
// is not in this list and must not be added to it.
router.get('/membership', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  const params = [clientId];
  const { rows } = await pool.query(
    `SELECT id, package_type, base_amount, discount, final_amount,
            paid_amount, balance_amount, monthly_pt_amount,
            pt_start_date, pt_end_date, duration_months, status
       FROM pt_clients
      WHERE id = $1 AND deleted_at IS NULL${orgClause(orgId, params)}`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Membership not found.' } });
  res.json({ data: rows[0] });
}));

// ── GET /api/me/payments ─────────────────────────────────────────────────────
router.get('/payments', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  const params = [clientId];
  const { rows } = await pool.query(
    `SELECT id, amount, date, payment_method, notes, created_at
       FROM pt_payments
      WHERE client_id = $1 AND deleted_at IS NULL${orgClause(orgId, params)}
      ORDER BY date DESC, created_at DESC
      LIMIT 200`,
    params
  );
  res.json({ data: rows });
}));

// ── GET /api/me/attendance ───────────────────────────────────────────────────
router.get('/attendance', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  const params = [clientId];
  const { rows } = await pool.query(
    `SELECT id, date, check_in_time, check_out_time, method, status
       FROM attendance_logs
      WHERE ref_id = $1 AND ref_type = 'client'${orgClause(orgId, params)}
      ORDER BY date DESC, check_in_time DESC
      LIMIT 200`,
    params
  );
  res.json({ data: rows });
}));

// ── GET /api/me/measurements ─────────────────────────────────────────────────
//
// Two columns, not SELECT *. `pt_os_measurements` is not defined in any
// migration in this repo — it is created elsewhere and read by the client
// snapshot — so the only columns anyone here can claim to know about are the
// ones already read in production (see pt-os.routes.js, the weight trend).
// A star select on a table whose full shape is unverified is how an internal
// note ends up on a client's screen.
//
// No org clause: the column set is unverified, so an organization_id filter
// might reference a column that does not exist and 500 the whole route. Scoping
// on client_id alone is already sufficient — pt_clients.id is unique
// platform-wide and comes from the session, never the request.
router.get('/measurements', wrap(async (req, res) => {
  const { clientId } = selfOf(req);
  const { rows } = await pool.query(
    `SELECT weight_kg, measured_at
       FROM pt_os_measurements
      WHERE client_id = $1 AND weight_kg IS NOT NULL
      ORDER BY measured_at DESC
      LIMIT 200`,
    [clientId]
  );
  res.json({ data: rows });
}));

// ── My programme, my diet, my weekly check-ins ─────────────────────────────
//
// The member app used to stop at profile, payments, attendance and weight:
// a client could not see the programme their trainer wrote, the diet they
// were given, or tell their trainer how the week went. The SQL for these is
// in client-portal.service.js; each route passes it the identity from the
// session and nothing from the request.

// GET /api/me/workout — active programmes, this week's exercises by day
router.get('/workout', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  res.json({ data: await portal.myWorkout(clientId, orgId) });
}));

// GET /api/me/diet — active diet plans with daily targets and meals
router.get('/diet', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  res.json({ data: await portal.myDiet(clientId, orgId) });
}));

// GET /api/me/checkins — recent weekly check-ins, and which week is "this week"
router.get('/checkins', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  res.json({ data: await portal.myCheckins(clientId, orgId) });
}));

// POST /api/me/checkins — this week's check-in (the server picks the week)
router.post('/checkins', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  try {
    const saved = await portal.upsertMyCheckin(clientId, orgId, req.user.id, req.body || {});
    if (!saved) {
      return res.status(409).json({ error: { code: 'CONFLICT', message: 'This week\'s check-in could not be saved.' } });
    }
    res.status(201).json({ data: saved });
  } catch (err) {
    if (err instanceof portal.PortalInputError) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: err.message } });
    }
    throw err;
  }
}));

module.exports = router;
module.exports.selfOf = selfOf;

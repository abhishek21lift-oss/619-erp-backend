'use strict';
// Self-scoped reads for the member assistant.
//
// Every function takes (clientId, orgId) — client first, matching
// client-portal.service.js — and every query filters on both. The caller is
// always the member's own tool registry, never a request value, so a member
// cannot ask for another client's row by supplying an id.
//
// ── Why the allow-lists are explicit ───────────────────────────────────────
//
// These rows feed a model prompt. A column added to pt_clients later must not
// reach a provider because somebody wrote `SELECT *`. Money fields are named
// individually so trainer commission never tags along; `notes` is absent for
// the same reason.

const pool = require('../../db/pool');

/** The member's own profile fields, minus contact details and money. */
async function profile(clientId, orgId) {
  const { rows } = await pool.query(
    `SELECT name, goal, height, weight, package_type, joining_date, status
       FROM pt_clients
      WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
    [clientId, orgId],
  );
  return rows[0] || null;
}

/** Studio visits inside the window, newest first. */
async function attendance(clientId, orgId, { days = 90 } = {}) {
  const window = Math.min(Math.max(Number(days) || 90, 1), 365);
  const { rows } = await pool.query(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date, status
       FROM attendance_logs
      WHERE ref_id = $1 AND ref_type = 'client' AND organization_id = $2
        AND date >= CURRENT_DATE - $3::int
      ORDER BY date DESC`,
    [clientId, orgId, window],
  );
  return rows;
}

/** The member's package and dues, without commission or trainer notes. */
async function membership(clientId, orgId) {
  const { rows } = await pool.query(
    `SELECT package_type, base_amount, discount, final_amount, paid_amount,
            balance_amount, monthly_pt_amount, pt_start_date, pt_end_date,
            duration_months, status
       FROM pt_clients
      WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
    [clientId, orgId],
  );
  return rows[0] || null;
}

/** The member's own payments, newest first. Internal notes are not selected. */
async function payments(clientId, orgId, { limit = 10 } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 10, 1), 50);
  const { rows } = await pool.query(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date, amount, payment_method
       FROM pt_payments
      WHERE client_id = $1 AND organization_id = $2 AND deleted_at IS NULL
      ORDER BY date DESC, created_at DESC
      LIMIT $3`,
    [clientId, orgId, cap],
  );
  return rows;
}

module.exports = { profile, attendance, membership, payments };

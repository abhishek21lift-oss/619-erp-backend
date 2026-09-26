'use strict';
// Member renewal and receipts: where the member's plan stands, the renewal
// the trainer offered (if any), asking for one, and a receipt for any payment
// on their ledger.
//
// The offer itself is a payment_orders row of kind 'renewal' (migration 213),
// created by the trainer and paid through the ordinary UPI flow. This module
// only reads it — nothing here can create, price or approve one.
//
// Same identity rule as the rest of client-portal: clientId/orgId are the
// session's, never the request's.

const pool = require('../../db/pool');
const { today, dbDate } = require('../../lib/appTime');
const upi = require('../../lib/upiPayments');

const DAY_MS = 86_400_000;

/** Whole days from today to `ymd` (negative once it has passed), or null. */
function daysUntil(ymd, nowYmd) {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  return Math.round((Date.parse(`${ymd}T00:00:00Z`) - Date.parse(`${nowYmd}T00:00:00Z`)) / DAY_MS);
}

/**
 * The phase the member's plan is in, which decides what the app shows:
 *   active    more than RENEW_WINDOW days left
 *   ending    RENEW_WINDOW days or fewer left
 *   expired   past its end date
 *   none      no end date on record
 */
const RENEW_WINDOW = 14;
function phaseOf(daysLeft) {
  if (daysLeft === null) return 'none';
  if (daysLeft < 0) return 'expired';
  if (daysLeft <= RENEW_WINDOW) return 'ending';
  return 'active';
}

/** An offer as the member sees it — no internal ids beyond the order's own. */
function offerView(order, ptEndDate) {
  if (!order) return null;
  return {
    id: order.id,
    order_no: order.order_no,
    status: order.status,
    package_name: order.plan_name,
    duration_months: order.duration_months,
    base_amount: Number(order.base_amount),
    gst_percent: Number(order.gst_percent),
    gst_amount: Number(order.gst_amount),
    total_amount: Number(order.total_amount),
    note: order.notes || null,
    expires_at: order.expires_at,
    created_at: order.created_at,
    // What paying it would buy, on the rule approval applies: an unexpired
    // plan is extended from its end date, an expired one starts today.
    window: upi.computeMembershipWindow(ptEndDate, order.duration_months, today()),
  };
}

async function myRenewal(clientId, orgId) {
  const nowYmd = today();
  const { rows } = await pool.query(
    `SELECT package_type, pt_start_date, pt_end_date, duration_months, final_amount, balance_amount, status
       FROM pt_clients
      WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
    [clientId, orgId]
  );
  const c = rows[0];
  if (!c) return null;

  // pt_end_date is a TEXT column (migration 017) and may hold '' or junk.
  const endRaw = dbDate(c.pt_end_date);
  const endYmd = endRaw && /^\d{4}-\d{2}-\d{2}$/.test(endRaw) ? endRaw : null;
  const daysLeft = daysUntil(endYmd, nowYmd);
  const [offer, requested] = await Promise.all([
    upi.currentRenewalOffer(orgId, clientId),
    pool.query(
      `SELECT MAX(n.created_at) AS at
         FROM notifications n
         JOIN users u ON u.id = n.user_id AND u.organization_id = $2 AND u.role = 'trainer'
        WHERE n.type = 'renewal_request' AND n.link = $1 AND n.is_read = FALSE`,
      [`/pt-os/clients/${clientId}`, orgId]
    ),
  ]);

  return {
    plan: {
      package_name: c.package_type || null,
      start_date: dbDate(c.pt_start_date) || null,
      end_date: endYmd,
      duration_months: c.duration_months ?? null,
      price: c.final_amount === null ? null : Number(c.final_amount),
      balance: Number(c.balance_amount) || 0,
      days_left: daysLeft,
      phase: phaseOf(daysLeft),
    },
    offer: offerView(offer, endYmd),
    // A request the trainer has not opened yet — the app says "requested"
    // instead of offering the button again.
    requested_at: requested.rows[0]?.at || null,
  };
}

class RenewalError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/**
 * Tell the trainer this member wants to renew. One unread request at a time:
 * asking again before the trainer has looked adds nothing.
 */
async function requestRenewal(clientId, orgId, note) {
  const state = await myRenewal(clientId, orgId);
  if (!state) throw new RenewalError('Membership not found.', 404);
  if (state.offer) throw new RenewalError('Your trainer has already sent your renewal — you can pay it now.', 409);

  const body = (note ? String(note).trim().slice(0, 300) : '') || 'Wants to renew their plan.';
  const { rowCount } = await pool.query(
    `INSERT INTO notifications (user_id, type, title, body, link)
     SELECT u.id, 'renewal_request', COALESCE(c.name, 'A member') || ' wants to renew', $3,
            '/pt-os/clients/' || c.id
       FROM pt_clients c
       JOIN users u ON u.organization_id = c.organization_id AND u.role = 'trainer'
                   AND u.is_active = TRUE AND u.deleted_at IS NULL
      WHERE c.id = $1 AND c.organization_id = $2
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
           WHERE n.user_id = u.id AND n.type = 'renewal_request' AND n.is_read = FALSE
             AND n.link = '/pt-os/clients/' || c.id)`,
    [clientId, orgId, body]
  );
  return { sent: rowCount > 0 };
}

/**
 * One ledger payment of this member's, with what a receipt prints. Null when
 * the id is not theirs — the route answers 404 either way.
 */
async function myPaymentForReceipt(clientId, orgId, paymentId) {
  const { rows } = await pool.query(
    `SELECT p.id, p.amount, p.date, p.payment_method, p.payment_ref, p.notes, p.created_at,
            c.name AS member_name, c.mobile AS member_mobile, c.email AS member_email,
            o.name AS studio_name
       FROM pt_payments p
       JOIN pt_clients c ON c.id = p.client_id
       LEFT JOIN organizations o ON o.id = p.organization_id
      WHERE p.id = $1 AND p.client_id = $2 AND p.organization_id = $3 AND p.deleted_at IS NULL`,
    [String(paymentId), clientId, orgId]
  );
  return rows[0] || null;
}

module.exports = {
  RenewalError,
  RENEW_WINDOW,
  myRenewal,
  requestRenewal,
  myPaymentForReceipt,
  // exported for tests
  phaseOf,
  daysUntil,
};

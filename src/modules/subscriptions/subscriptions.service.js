// src/modules/subscriptions/subscriptions.service.js
//
// Transactional subscription service (Blueprint §2.9).
//
// Why this exists
// ---------------
// The legacy add-subscription path in routes/client-actions.js only
// updates the denormalised columns on `clients`. It works, but there is
// no proper history — every renewal overwrites the previous package.
//
// This service is the source of truth going forward. It:
//   1. Locks the client row with FOR UPDATE so two staff can't double-book
//   2. Refuses overlapping active subs via daterange &&
//   3. Inserts one `subscriptions` row per plan_row plus a payment + receipt
//   4. Updates the legacy `clients` columns so existing reads keep working
//   5. Writes one immutable audit row to `membership_actions`
//
// All work happens in a single transaction; partial state is impossible.
//
// Backward compat: the route is opt-in. routes/client-actions.js continues
// to handle requests today; once the frontend switches to /api/subscriptions
// we deprecate the old path. No production data is touched destructively.

const pool             = require('../../db/pool');
const { genReceiptNo } = require('../../db/receipts');

// ─── helpers ────────────────────────────────────────────────────────
function num(v, fb = 0) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fb;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function round2(n) { return Math.round(n * 100) / 100; }

/**
 * Compute the GST + final breakdown for one plan row.
 *
 *   total = max(0, base − discount) + gstAmount + signupFee
 */
function priceBreakdown({ base, sell, gstPercent, signupFee }) {
  const baseAmount     = num(base, 0);
  const sellAmount     = num(sell, baseAmount);
  const discountAmount = Math.max(0, round2(baseAmount - sellAmount));
  const gstAmount      = round2(sellAmount * (num(gstPercent, 0) / 100));
  const fee            = num(signupFee, 0);
  const finalAmount    = round2(sellAmount + gstAmount + fee);
  return { baseAmount, sellAmount, discountAmount, gstAmount, signupFee: fee, finalAmount };
}

// ─── RBAC ───────────────────────────────────────────────────────────
function assertCanAct(user, client) {
  const role = user && user.role;
  if (role === 'admin' || role === 'manager' || role === 'reception') return;
  if (role === 'trainer') {
    if (!user.trainer_id) throw httpError(403, 'Access denied: trainer profile not linked');
    if (client.trainer_id !== user.trainer_id) {
      throw httpError(403, 'Access denied: client is not assigned to you');
    }
    return;
  }
  throw httpError(403, 'Access denied');
}

function assertCanView(user, client) {
  if (!user || !user.role) throw httpError(401, 'Unauthorized');
  if (user.role === 'admin' || user.role === 'manager' || user.role === 'reception') return;
  if (user.role === 'trainer') {
    if (!user.trainer_id || client.trainer_id !== user.trainer_id) {
      throw httpError(403, 'Access denied: client is not assigned to you');
    }
    return;
  }
  throw httpError(403, 'Access denied');
}

function validatePlanRows(planRows) {
  if (!Array.isArray(planRows) || planRows.length === 0) {
    throw httpError(400, 'At least one plan row is required');
  }
  for (let i = 0; i < planRows.length; i++) {
    const r = planRows[i], n = i + 1;
    if (!r.plan) throw httpError(400, `Row ${n}: plan is required`);
    if (!r.startDate) throw httpError(400, `Row ${n}: startDate is required`);
    if (!r.endDate) throw httpError(400, `Row ${n}: endDate is required`);
    if (new Date(r.endDate) <= new Date(r.startDate)) {
      throw httpError(400, `Row ${n}: endDate must be after startDate`);
    }
    if (num(r.sellingPrice, -1) < 0) throw httpError(400, `Row ${n}: sellingPrice cannot be negative`);
  }
}

// ─── core: addSubscription ──────────────────────────────────────────
/**
 * @param {object} args
 * @param {string} args.clientId
 * @param {Array}  args.planRows   - [{ plan, startDate, endDate, basePrice, sellingPrice, coupon }]
 * @param {string} args.paymentMethod
 * @param {string} [args.branchId]
 * @param {number} [args.gstPercent]
 * @param {number} [args.signupFee]
 * @param {string} [args.groupId]
 * @param {object} args.user        - req.user
 * @returns {Promise<{ subscriptions, payments, client }>}
 */
async function addSubscription(args) {
  const {
    clientId, planRows, paymentMethod = 'CASH',
    branchId = null, gstPercent = null, signupFee = null,
    groupId = null, user = {},
  } = args;

  validatePlanRows(planRows);

  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');

    // 1) Lock the client row to prevent races.
    const { rows: cs } = await tx.query(
      'SELECT * FROM clients WHERE id=$1 FOR UPDATE',
      [clientId],
    );
    if (!cs[0]) throw httpError(404, 'Client not found');
    const client = cs[0];

    // 2) RBAC.
    assertCanAct(user, client);

    // 3) Overlap guard — refuse if an active sub already covers the new range.
    const startMin = planRows.reduce((m, r) => r.startDate < m ? r.startDate : m, planRows[0].startDate);
    const endMax   = planRows.reduce((m, r) => r.endDate   > m ? r.endDate   : m, planRows[0].endDate);
    const { rows: overlap } = await tx.query(
      `SELECT id FROM subscriptions
        WHERE client_id = $1
          AND status   = 'active'
          AND daterange(start_date, end_date, '[]') && daterange($2::date, $3::date, '[]')
        LIMIT 1`,
      [clientId, startMin, endMax],
    );
    if (overlap[0]) throw httpError(409, 'An active subscription overlaps with this date range. Use Renew or Upgrade.');

    // 4) Resolve plan_id snapshots so renaming the plan later doesn't
    //    break analytics. Plans table is small; one IN-list lookup.
    const planNames = [...new Set(planRows.map(r => r.plan))];
    const { rows: planRowsDb } = await tx.query(
      'SELECT id, name, gst_percent, signup_fee FROM plans WHERE name = ANY($1::text[])',
      [planNames],
    );
    const planByName = Object.fromEntries(planRowsDb.map(p => [p.name, p]));

    // 5) Insert one subscription + one payment + one receipt per plan row.
    const created  = [];
    const payments = [];

    for (const r of planRows) {
      const planRecord = planByName[r.plan] || null;
      const effectiveGst =
        gstPercent == null
          ? (planRecord ? num(planRecord.gst_percent, 0) : 0)
          : num(gstPercent, 0);
      const effectiveFee =
        signupFee == null
          ? (planRecord ? num(planRecord.signup_fee, 0) : 0)
          : num(signupFee, 0);

      const bd = priceBreakdown({
        base: r.basePrice ?? r.sellingPrice,
        sell: r.sellingPrice,
        gstPercent: effectiveGst,
        signupFee:  effectiveFee,
      });

      const receipt = await genReceiptNo(tx);

      const { rows: subRows } = await tx.query(
        `INSERT INTO subscriptions
           (client_id, plan_id, plan_name, branch_id,
            start_date, end_date,
            base_amount, discount_amount, signup_fee, gst_percent, gst_amount,
            final_amount, paid_amount, payment_method, receipt_no, coupon_code,
            group_id, trainer_id, performed_by, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'active')
         RETURNING *`,
        [
          client.id, planRecord ? planRecord.id : null, r.plan, branchId,
          r.startDate, r.endDate,
          bd.baseAmount, bd.discountAmount, bd.signupFee, effectiveGst, bd.gstAmount,
          bd.finalAmount, bd.finalAmount, paymentMethod, receipt, r.coupon || null,
          groupId, client.trainer_id, user.name || null,
        ],
      );
      created.push(subRows[0]);

      // Trainer incentive (matches existing convention in client-actions.js)
      let iRate = 0.5;
      if (client.trainer_id) {
        const { rows: tr } = await tx.query('SELECT incentive_rate FROM trainers WHERE id=$1', [client.trainer_id]);
        iRate = tr[0] && tr[0].incentive_rate != null ? Number(tr[0].incentive_rate) : 0.5;
      }
      const incentiveAmt = Math.round(bd.finalAmount * iRate);

      const { rows: pay } = await tx.query(
        `INSERT INTO payments
           (id, client_id, client_name, trainer_id, trainer_name,
            amount, method, date, receipt_no, package_type, incentive_amt, notes, branch_id)
         VALUES (gen_random_uuid()::TEXT, $1,$2,$3,$4,$5,$6,CURRENT_DATE,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          client.id, client.name, client.trainer_id, client.trainer_name,
          bd.finalAmount, paymentMethod, receipt, r.plan, incentiveAmt,
          'Subscription: ' + r.plan, branchId,
        ],
      );
      payments.push(pay[0]);
    }

    // 6) Keep the legacy denorm columns in sync — last row wins (most
    //    common case is one plan row anyway).
    const last = created[created.length - 1];
    const totalFinal = created.reduce((s, x) => s + Number(x.final_amount), 0);
    await tx.query(
      `UPDATE clients SET
         package_type   = $1,
         pt_start_date  = $2,
         pt_end_date    = $3,
         final_amount   = $4,
         paid_amount    = $4,
         balance_amount = 0,
         status         = 'active',
         branch_id      = COALESCE($5, branch_id),
         updated_at     = NOW()
       WHERE id = $6`,
      [last.plan_name, last.start_date, last.end_date, totalFinal, branchId, client.id],
    );

    // 7) Audit log (best-effort — don't fail the txn if the legacy table
    //    is missing on very old installs).
    try {
      await tx.query(
        `INSERT INTO membership_actions
           (id, client_id, client_name, trainer_id, action_type,
            old_value, new_value, amount, payment_method,
            performed_by, action_date, branch_id)
         VALUES (gen_random_uuid()::TEXT, $1,$2,$3,'add_subscription',
                 $4,$5,$6,$7,$8,CURRENT_DATE,$9)`,
        [
          client.id, client.name, client.trainer_id,
          JSON.stringify({ package_type: client.package_type }),
          JSON.stringify({
            subscriptions: created.map(s => ({ id: s.id, plan: s.plan_name, end_date: s.end_date })),
            total: totalFinal,
          }),
          totalFinal, paymentMethod, user.name || null, branchId,
        ],
      );
    } catch (_) { /* legacy installs without branch_id column */ }

    await tx.query('COMMIT');

    const { rows: fresh } = await pool.query('SELECT * FROM clients WHERE id=$1', [client.id]);

    return {
      subscriptions: created,
      payments,
      client: fresh[0],
      total: totalFinal,
    };
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}

// ─── core: renewSubscription ────────────────────────────────────────
/**
 * Renew the member's most recent active subscription. The previous sub
 * is marked 'superseded' and the new one points to it via parent_id.
 */
async function renewSubscription(args) {
  const { clientId, planRows, paymentMethod = 'CASH', branchId = null,
          gstPercent = null, signupFee = null, user = {} } = args;

  validatePlanRows(planRows);

  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');

    const { rows: cs } = await tx.query('SELECT * FROM clients WHERE id=$1 FOR UPDATE', [clientId]);
    if (!cs[0]) throw httpError(404, 'Client not found');
    const client = cs[0];
    assertCanAct(user, client);

    const startMin = planRows.reduce((m, r) => r.startDate < m ? r.startDate : m, planRows[0].startDate);
    const endMax = planRows.reduce((m, r) => r.endDate > m ? r.endDate : m, planRows[0].endDate);
    const { rows: overlap } = await tx.query(
      `SELECT id FROM subscriptions
        WHERE client_id = $1
          AND status = 'active'
          AND daterange(start_date, end_date, '[]') && daterange($2::date, $3::date, '[]')
        LIMIT 1`,
      [clientId, startMin, endMax],
    );
    if (overlap[0]) throw httpError(409, 'An active subscription overlaps with this date range.');

    const { rows: prev } = await tx.query(
      `SELECT * FROM subscriptions
        WHERE client_id = $1 AND status = 'active'
        ORDER BY end_date DESC LIMIT 1`,
      [clientId],
    );
    const previous = prev[0] || null;

    const created  = [];
    const payments = [];

    for (const r of planRows) {
      const effectiveGst = gstPercent == null ? 0 : num(gstPercent, 0);
      const effectiveFee = signupFee == null ? 0 : num(signupFee, 0);
      const bd = priceBreakdown({
        base: r.basePrice ?? r.sellingPrice,
        sell: r.sellingPrice,
        gstPercent: effectiveGst,
        signupFee: effectiveFee,
      });
      const receipt = await genReceiptNo(tx);

      const { rows: subRows } = await tx.query(
        `INSERT INTO subscriptions
           (client_id, plan_name, branch_id, start_date, end_date,
            base_amount, discount_amount, signup_fee, gst_percent, gst_amount,
            final_amount, paid_amount, payment_method, receipt_no,
            coupon_code, parent_id, trainer_id, performed_by, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'active')
         RETURNING *`,
        [
          client.id, r.plan, branchId, r.startDate, r.endDate,
          bd.baseAmount, bd.discountAmount, bd.signupFee, effectiveGst, bd.gstAmount,
          bd.finalAmount, bd.finalAmount, paymentMethod, receipt,
          r.coupon || null, previous ? previous.id : null,
          client.trainer_id, user.name || null,
        ],
      );
      created.push(subRows[0]);

      let iRate = 0.5;
      if (client.trainer_id) {
        const { rows: tr } = await tx.query('SELECT incentive_rate FROM trainers WHERE id=$1', [client.trainer_id]);
        iRate = tr[0] && tr[0].incentive_rate != null ? Number(tr[0].incentive_rate) : 0.5;
      }
      const { rows: pay } = await tx.query(
        `INSERT INTO payments
           (id, client_id, client_name, trainer_id, trainer_name,
            amount, method, date, receipt_no, package_type, incentive_amt, notes, branch_id)
         VALUES (gen_random_uuid()::TEXT, $1,$2,$3,$4,$5,$6,CURRENT_DATE,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          client.id, client.name, client.trainer_id, client.trainer_name,
          bd.finalAmount, paymentMethod, receipt, r.plan,
          Math.round(bd.finalAmount * iRate),
          'Renewal: ' + r.plan, branchId,
        ],
      );
      payments.push(pay[0]);
    }

    if (previous) {
      await tx.query(
        `UPDATE subscriptions
            SET status='superseded', updated_at=NOW()
          WHERE client_id = $1 AND status = 'active'`,
        [client.id],
      );
    }

    const last = created[created.length - 1];
    const totalFinal = created.reduce((s, x) => s + Number(x.final_amount), 0);

    await tx.query(
      `UPDATE clients SET
         package_type   = $1,
         pt_start_date  = $2,
         pt_end_date    = $3,
         final_amount   = $4,
         paid_amount    = $4,
         balance_amount = 0,
         status         = 'active',
         branch_id      = COALESCE($5, branch_id),
         updated_at     = NOW()
       WHERE id = $6`,
      [last.plan_name, last.start_date, last.end_date, totalFinal, branchId, client.id],
    );

    await tx.query('COMMIT');
    const { rows: fresh } = await pool.query('SELECT * FROM clients WHERE id=$1', [client.id]);
    return { subscriptions: created, payments, client: fresh[0], total: totalFinal };
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}

// ─── reads ──────────────────────────────────────────────────────────
async function listForClient(clientId, user) {
  const { rows: cs } = await pool.query('SELECT id, trainer_id FROM clients WHERE id=$1', [clientId]);
  if (!cs[0]) throw httpError(404, 'Client not found');
  assertCanView(user, cs[0]);
  const { rows } = await pool.query(
    `SELECT * FROM subscriptions
      WHERE client_id = $1
      ORDER BY end_date DESC, created_at DESC`,
    [clientId],
  );
  return rows;
}

async function getActive(clientId, user) {
  const { rows: cs } = await pool.query('SELECT id, trainer_id FROM clients WHERE id=$1', [clientId]);
  if (!cs[0]) throw httpError(404, 'Client not found');
  assertCanView(user, cs[0]);
  const { rows } = await pool.query(
    `SELECT * FROM subscriptions
      WHERE client_id = $1 AND status = 'active'
      ORDER BY end_date DESC LIMIT 1`,
    [clientId],
  );
  return rows[0] || null;
}

async function listExpiring({ days = 7, branchId = null } = {}) {
  const params = [days];
  let where = `status = 'active'
               AND end_date >= CURRENT_DATE
               AND end_date <= CURRENT_DATE + ($1 || ' days')::INTERVAL`;
  if (branchId) { params.push(branchId); where += ` AND branch_id = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT s.*, c.name AS client_name, c.mobile, c.email
       FROM subscriptions s
       JOIN clients c ON c.id = s.client_id
      WHERE ${where}
      ORDER BY s.end_date ASC`,
    params,
  );
  return rows;
}

module.exports = {
  addSubscription,
  renewSubscription,
  listForClient,
  getActive,
  listExpiring,
  // exposed for unit tests
  _internal: { priceBreakdown, assertCanAct },
};

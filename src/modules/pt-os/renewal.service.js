'use strict';
// src/modules/pt-os/renewal.service.js
//
// Renewing a PT client: the new term, its price, and any money taken for it.
// Payments & Invoices audit 2026-09-28, PAY-2 / PAY-6 / PAY-12.
//
// This used to be four separate statements in the route — the client row, the
// renewal log, the subscription row, the ledger row — with no transaction and
// no lock. A double-tapped Renew renewed twice, adding the term's price to the
// balance twice and recording the payment twice; a failure half-way left the
// client extended with no payment on the ledger, or the reverse. And the
// ledger row had no receipt number.
//
// Now: one transaction, the client row locked FOR UPDATE, a repeat of the
// same renewal within a few minutes refused as a duplicate, and the payment
// written with a receipt number and the amount it took off the balance. Side
// effects (activity log, payment_received) run after COMMIT, as everywhere
// else, so a rolled-back renewal neither logs nor messages anyone.

const pool = require('../../db/pool');
const { genReceiptNo } = require('../../db/receipts');
const { trainerForOrg } = require('../../lib/studioTrainer');
const { logActivity } = require('../../lib/activityLog');
const { tenantScope } = require('../../lib/tenant-db');
const automation = require('../automation/automation.triggers');

// The same renewal twice inside this window is a double submit, not a second
// term: a slow network or a double tap sends the identical request again.
const DUPLICATE_WINDOW_MINUTES = 10;

/**
 * pt_start_date + N months, clamped to the end of the month. setMonth()
 * overflowed: a term starting 31 January for one month ended on 3 March.
 * Pure date arithmetic on YYYY-MM-DD, no clock and no timezone.
 */
function addMonthsIso(isoDate, months) {
  const [y, m, d] = String(isoDate).slice(0, 10).split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, lastDay));
  return first.toISOString().slice(0, 10);
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/**
 * @param {import('express').Request} req
 * @param {string} clientId
 * @param {object} d  validated body (see renewSchema in pt-os.routes.js)
 * @returns {Promise<
 *   {notFound: true} | {duplicate: true} | {overpaid: number, owed: number} |
 *   {client: object, paymentId: string|null}
 * >}
 */
async function renewClient(req, clientId, d) {
  const orgId = tenantScope(req).orgId;
  const ptEndDate = addMonthsIso(d.pt_start_date, d.duration_months);

  // The Renew screen sends the final price only. base_amount and discount used
  // to be written as 0 whenever they were absent, wiping the package's list
  // price and discount on every renewal; absent now means "the final price,
  // undiscounted".
  const finalAmt = round2(d.final_amount ?? Math.max((d.base_amount ?? 0) - (d.discount ?? 0), 0));
  const baseAmt = round2(d.base_amount ?? finalAmt);
  const disc = round2(d.discount ?? Math.max(baseAmt - finalAmt, 0));
  const paidNow = round2(d.paid_amount ?? 0);
  const monthlyAmt = round2(d.monthly_pt_amount ?? 0);
  const method = String(d.payment_method || 'CASH').toUpperCase();

  const tx = await pool.connect();
  let client;
  let updated;
  let paymentId = null;
  try {
    await tx.query('BEGIN');

    const { rows: found } = await tx.query(
      `SELECT * FROM pt_clients WHERE id = $1 AND deleted_at IS NULL AND organization_id = $2 FOR UPDATE`,
      [clientId, orgId]
    );
    client = found[0];
    if (!client) { await tx.query('ROLLBACK'); return { notFound: true }; }

    // Under the lock, so two concurrent submits cannot both pass this check.
    const { rowCount: dupes } = await tx.query(
      `SELECT 1 FROM pt_client_renewals
        WHERE client_id = $1 AND new_start_date = $2 AND duration_months = $3 AND final_amount = $4
          AND renewed_at > NOW() - make_interval(mins => $5)
        LIMIT 1`,
      [clientId, d.pt_start_date, d.duration_months, finalAmt, DUPLICATE_WINDOW_MINUTES]
    );
    if (dupes) { await tx.query('ROLLBACK'); return { duplicate: true }; }

    // What they owe once this term is added. Paying more than that used to be
    // swallowed by GREATEST(…, 0) — money taken with nowhere recorded.
    const oldBalance = round2(Number(client.balance_amount) || 0);
    const owed = round2(oldBalance + finalAmt);
    if (paidNow > owed) { await tx.query('ROLLBACK'); return { overpaid: paidNow, owed }; }

    const { rows } = await tx.query(`
      UPDATE pt_clients SET
        package_type      = COALESCE($2, package_type),
        base_amount       = $3,
        discount          = $4,
        final_amount      = $5,
        monthly_pt_amount = $6,
        pt_start_date     = $7,
        pt_end_date       = $8,
        duration_months   = $9,
        paid_amount       = paid_amount + $10,
        -- What they owed before, plus the new term, less what they paid now.
        -- paid_amount is a lifetime total, so this cannot be final - paid.
        balance_amount    = $11,
        status            = 'active',
        updated_at        = NOW()
      WHERE id = $1
      RETURNING *
    `, [clientId, d.package_type || null, baseAmt, disc, finalAmt, monthlyAmt,
        d.pt_start_date, ptEndDate, d.duration_months, paidNow, round2(owed - paidNow)]);
    updated = rows[0];

    const packageName = d.package_type || client.package_type;
    await tx.query(`
      INSERT INTO pt_client_renewals
        (client_id, client_name, trainer_name, old_package, new_package,
         old_end_date, new_start_date, new_end_date, duration_months,
         base_amount, discount, final_amount, paid_amount, balance_amount, notes,
         organization_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    `, [clientId, client.name, client.trainer_name, client.package_type, packageName,
        client.pt_end_date, d.pt_start_date, ptEndDate, d.duration_months,
        baseAmt, disc, finalAmt, paidNow, Math.max(finalAmt - paidNow, 0),
        d.notes || null, client.organization_id]);

    // Canonical term history used by the profile page.
    await tx.query(`
      INSERT INTO pt_client_subscriptions
        (client_id, plan_name, start_date, end_date, duration_months,
         selling_price, amount_paid, balance_amount, trainer_name, status, source)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active','renewal')
      ON CONFLICT DO NOTHING
    `, [clientId, packageName, d.pt_start_date, ptEndDate, d.duration_months,
        finalAmt, paidNow, Math.max(finalAmt - paidNow, 0), client.trainer_name]);

    // Money collected at renewal lands on the ledger — revenue reports sum
    // pt_payments — with a receipt number, like every other payment.
    if (paidNow > 0) {
      const tr = client.trainer_id ? await trainerForOrg(tx, client.organization_id, client.trainer_id) : null;
      const incentiveRate = tr ? (tr.incentive_rate ?? 0.5) : 0;
      const receiptNo = await genReceiptNo(tx);
      const { rows: paid } = await tx.query(
        `INSERT INTO pt_payments
           (client_id, trainer_id, amount, incentive_amt, payment_method, payment_ref,
            date, notes, organization_id, balance_applied)
         VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,$7,$8,$9)
         RETURNING id`,
        [clientId, tr?.id ?? null, paidNow, Math.round(paidNow * incentiveRate), method, receiptNo,
         `Renewal — ${packageName || 'PT package'}`, client.organization_id,
         // The whole payment went against what is owed (overpaying is refused
         // above), so deleting it later restores exactly this.
         paidNow]
      );
      paymentId = paid[0].id;
    }

    await tx.query('COMMIT');
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }

  await logActivity(req, 'client.renew', 'pt_client', clientId, {
    new_start_date: d.pt_start_date, new_end_date: ptEndDate, final_amount: finalAmt, paid_amount: paidNow,
  });
  if (paymentId) {
    // Keyed on the payment's own id — stable across a retried request, unique
    // across payments, no clock involved.
    await automation.paymentReceived(req, {
      clientId,
      amount: paidNow,
      eventKey: paymentId,
    });
  }
  return { client: updated, paymentId };
}

module.exports = { renewClient, addMonthsIso, DUPLICATE_WINDOW_MINUTES };

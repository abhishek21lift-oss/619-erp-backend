'use strict';

// Recording a payment: the ledger row and the balance move, together.
//
// Extracted from routes/payments.js — "the canonical payment API for the
// finance UI" — so the voice surface records money through the SAME code
// rather than a second implementation of it. The logic is unchanged.
//
// ── Why this is one function and not two calls at each call site ─────────
//
// The header of pt-os.routes.js records what happened when it was two bare
// queries: a failure between them left "money in the ledger that the client's
// outstanding figure does not know about, silent, and surfacing much later as
// a reconciliation discrepancy nobody can account for". The insert and the
// balance update are one operation, and a caller should not be able to
// perform half of it by accident.
//
// ── What the CALLER must have already done ───────────────────────────────
//
// This function does no authorization and opens no transaction. It is
// deliberately the innermost layer, and it assumes its caller has:
//
//   1. opened a transaction and passed it in as `tx`,
//   2. locked the client row with FOR UPDATE — which is what serialises
//      concurrent payments so the balance cannot drift, and what makes a
//      double-submitted "Record Payment" queue rather than interleave,
//   3. checked that the client belongs to the caller's organization,
//   4. checked the caller may record a payment for them.
//
// Every one of those is a decision about who is asking, and belongs in the
// route where the request is visible. What belongs here is what must happen
// to the money once those questions are answered.

const { randomUUID } = require('crypto');
const { genReceiptNo } = require('../db/receipts');

/**
 * Insert the ledger row and move the client's balance.
 *
 * @param tx      an open transaction with the client row already locked
 * @param client  the locked `pt_clients` row
 * @param amount  a positive number, already validated by the caller
 * @returns { id, receiptNo, trainerId, incentiveAmt }
 */
async function recordPayment(tx, { client, amount, method, date, notes }) {
  // Verify the FK target exists. If the trainer was deleted without the
  // cascade clearing the client's trainer_id, the INSERT fails with a 23503 —
  // mid-payment, as a 500, to whoever is standing at the desk. Fall back to
  // NULL instead: an unattributed payment is recoverable, a refused one is a
  // person who has handed over money the system will not admit to.
  let resolvedTrainerId = null;
  let incentiveRate = 0.5;
  if (client.trainer_id) {
    const { rows: tr } = await tx.query(
      'SELECT id, incentive_rate FROM trainers WHERE id=$1', [client.trainer_id]
    );
    if (tr[0]) {
      resolvedTrainerId = tr[0].id;
      incentiveRate = tr[0].incentive_rate ?? 0.5;
    }
  }

  const id = randomUUID();
  // Drawn from a Postgres sequence rather than a timestamp — see db/receipts.js
  // for the collision this replaced.
  const receiptNo = await genReceiptNo(tx);
  const incentiveAmt = Math.round(amount * incentiveRate);

  await tx.query(
    `INSERT INTO pt_payments (id, client_id, trainer_id, amount, incentive_amt,
       payment_method, payment_ref, date, notes, organization_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, client.id, resolvedTrainerId, amount, incentiveAmt,
     String(method || 'CASH').toUpperCase(), receiptNo, date, notes || null,
     client.organization_id]
  );

  // Relative, not absolute: `paid_amount + $1` means two concurrent payments
  // cannot lose each other's increments even if the lock above were ever
  // dropped. GREATEST(0, …) keeps an overpayment from driving the outstanding
  // figure negative, which the UI renders as a credit nobody granted.
  await tx.query(
    `UPDATE pt_clients
        SET paid_amount = paid_amount + $1,
            balance_amount = GREATEST(0, balance_amount - $1),
            updated_at = NOW()
      WHERE id = $2`,
    [amount, client.id]
  );

  return { id, receiptNo, trainerId: resolvedTrainerId, incentiveAmt };
}

module.exports = { recordPayment };

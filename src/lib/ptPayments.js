'use strict';

/**
 * recordPtPayment — the one way a manually recorded payment enters the ledger.
 *
 * Two screens record a payment by hand: Finance → Record Payment
 * (POST /api/payments) and a client's Payments tab (POST /api/pt-os/payments).
 * Each used to carry its own copy of the write, and the copies drifted:
 *
 *   • only the finance path issued a receipt number;
 *   • only the finance path wrote the activity log;
 *   • the client path attributed the payment to a trainer only when the form
 *     sent one, never falling back to the client's own trainer;
 *   • both locked, inserted and updated the balance, but in separately
 *     maintained SQL that had already diverged once (the client path ran as
 *     two bare queries until it was brought into a transaction).
 *
 * This is now the single implementation. Each route keeps what is genuinely
 * its own — input parsing, validation and its error and response shapes — and
 * hands the rest here, so the invariants below hold for both by construction:
 *
 *   1. The client row is locked (FOR UPDATE) before the write, so concurrent
 *      payments for one client queue instead of interleaving.
 *   2. The ledger row and the balance move in ONE transaction, or not at all.
 *   3. Every lookup and write carries the caller's organization.
 *   4. The payment has a receipt number: the caller's own reference if it
 *      supplied one, otherwise one from the receipt sequence.
 *   5. After COMMIT — never inside the transaction — the activity log is
 *      written and payment_received is raised, keyed on the payment's own id.
 *      A rolled-back payment must not be logged or message anyone, and
 *      neither side effect may be able to fail a payment.
 *
 * The two genuinely different policies stay the caller's choice, explicitly:
 *   • incentive: an amount the caller computed, or the trainer's rate;
 *   • whether a client is required (the client path allows a payment with no
 *     client, recorded without a lock or a balance to move).
 */

const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const { genReceiptNo } = require('../db/receipts');
const { trainerForOrg } = require('./studioTrainer');
const { logActivity } = require('./activityLog');
const automation = require('../modules/automation/automation.triggers');

/** The rate an incentive falls back to when the trainer has none set. */
const DEFAULT_INCENTIVE_RATE = 0.5;

/**
 * @param {import('express').Request} req  for the activity log and the event
 * @param {object}  p
 * @param {string}  p.orgId
 * @param {string|null} p.clientId        null records a payment with no client
 * @param {number}  p.amount              already validated: finite and > 0
 * @param {string|null} p.method          already normalised by the caller
 * @param {string|Date} p.date
 * @param {string|null} [p.notes]
 * @param {string|null} [p.paymentRef]    the caller's reference; null → a receipt number
 * @param {string|null} [p.trainerId]     preferred trainer; ignored unless it is this studio's
 * @param {{ amount: number } | 'trainer_rate'} p.incentive
 * @returns {Promise<{ notFound: true } | { payment: object }>}
 */
async function recordPtPayment(req, p) {
  const tx = await pool.connect();
  const paymentId = randomUUID();
  // The tenant the row is filed under. With a client it is the client row's
  // own organization — the tenant anchor — rather than anything taken from
  // the request; the lock below already refuses a client outside the caller's
  // studio, so the two agree, but the row is what the ledger is keyed on.
  let orgId = p.orgId;
  try {
    await tx.query('BEGIN');

    let client = null;
    if (p.clientId) {
      const { rows } = await tx.query(
        'SELECT * FROM pt_clients WHERE id=$1 AND deleted_at IS NULL AND organization_id=$2 FOR UPDATE',
        [p.clientId, p.orgId],
      );
      if (!rows[0]) {
        await tx.query('ROLLBACK');
        return { notFound: true };
      }
      client = rows[0];
      orgId = client.organization_id ?? p.orgId;
    }

    // The trainer this payment is attributed to, resolved inside this studio
    // only: the one the caller named if it is this studio's, else the
    // client's own. A stale or foreign id resolves to null rather than
    // failing the payment on the foreign key.
    const trainer = (await trainerForOrg(tx, orgId, p.trainerId))
      || (client ? await trainerForOrg(tx, orgId, client.trainer_id) : null);

    const incentiveAmt = p.incentive === 'trainer_rate'
      ? Math.round(p.amount * (trainer?.incentive_rate ?? DEFAULT_INCENTIVE_RATE))
      : (p.incentive?.amount ?? 0);

    const paymentRef = p.paymentRef || await genReceiptNo(tx);

    // What this payment takes off the balance: the balance is clamped at zero
    // below, so a payment larger than what is owed applies only what is owed.
    // Stored so that deleting the payment restores exactly this and no more
    // (payments audit PAY-3). Read from the row locked above.
    const balanceApplied = client
      ? Math.min(p.amount, Math.max(0, Number(client.balance_amount) || 0))
      : null;

    await tx.query(
      `INSERT INTO pt_payments (id, client_id, trainer_id, amount, incentive_amt,
         payment_method, payment_ref, date, notes, organization_id, balance_applied)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [paymentId, p.clientId || null, trainer?.id ?? null, p.amount, incentiveAmt,
       p.method ?? null, paymentRef, p.date, p.notes ?? null, orgId, balanceApplied],
    );

    if (client) {
      await tx.query(
        `UPDATE pt_clients SET
           paid_amount = paid_amount + $1,
           balance_amount = GREATEST(0, balance_amount - $1),
           updated_at = NOW()
         WHERE id = $2 AND deleted_at IS NULL AND organization_id = $3`,
        [p.amount, client.id, orgId],
      );
    }

    await tx.query('COMMIT');
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }

  // The committed row, in the shape both screens read: the raw columns plus
  // the ledger's names for them (method, receipt_no) and the client's name.
  const { rows } = await pool.query(
    `SELECT p.*, UPPER(p.payment_method) AS method, p.payment_ref AS receipt_no,
            c.name AS client_name
       FROM pt_payments p
       LEFT JOIN pt_clients c ON c.id = p.client_id AND c.organization_id = p.organization_id
      WHERE p.id = $1 AND p.organization_id = $2`,
    [paymentId, orgId],
  );
  const payment = rows[0];

  // After COMMIT, each on its own connection (see the header, rule 5).
  await logActivity(req, 'payment.create', 'pt_payment', paymentId, payment);
  if (p.clientId) {
    await automation.paymentReceived(req, {
      clientId: p.clientId,
      amount: p.amount,
      eventKey: paymentId,
    });
  }

  return { payment };
}

module.exports = { recordPtPayment, DEFAULT_INCENTIVE_RATE };

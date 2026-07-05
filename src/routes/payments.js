// src/routes/payments.js
const router = require('express').Router();
const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const { genReceiptNo } = require('../db/receipts');
const { auth, adminOnly } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { paymentSchemas } = require('../lib/validation');
const logger = require('../lib/logger');

// GET /api/payments
router.get('/', auth, async (req, res, next) => {
  try {
    const { client_id, trainer_id, from, to, limit = 200, offset = 0 } = req.query;
    const conditions = [];
    const params = [];
    let p = 1;

    if (req.user.role === 'trainer' && req.user.trainer_id) {
      conditions.push(`p.trainer_id = $${p++}`); params.push(req.user.trainer_id);
    } else if (trainer_id) {
      conditions.push(`p.trainer_id = $${p++}`); params.push(trainer_id);
    }
    if (client_id) { conditions.push(`p.client_id = $${p++}`); params.push(client_id); }
    if (from)      { conditions.push(`p.date >= $${p++}`);     params.push(from); }
    if (to)        { conditions.push(`p.date <= $${p++}`);     params.push(to); }
    // Hide soft-deleted payments unless caller explicitly asks for them.
    if (req.query.include_deleted !== '1') {
      conditions.push(`p.deleted_at IS NULL`);
    }

    // Branch scope: restrict to the caller's branch for non-admin users.
    const { sql: bsql, params: bparams } = req.branchScope.appendTo(params);
    if (bsql !== 'TRUE') conditions.push(`p.${bsql}`);
    p = bparams.length + 1;

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const { rows } = await pool.query(`
      SELECT p.*, c.name AS client_name, t.name AS trainer_name_full
      FROM payments p
      LEFT JOIN clients  c ON c.id = p.client_id
      LEFT JOIN trainers t ON t.id = p.trainer_id
      ${where}
      ORDER BY p.date DESC, p.created_at DESC
      LIMIT $${p++} OFFSET $${p++}`,
      [...bparams, parseInt(limit), parseInt(offset)]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/payments
router.post('/', auth, validate(paymentSchemas.create), async (req, res, next) => {
  const tx = await pool.connect();
  try {
    const d = req.body;
    if (!d.client_id || !d.amount || !d.date)
      return res.status(400).json({ error: 'client_id, amount and date required' });

    const amount = parseFloat(d.amount);
    if (!Number.isFinite(amount) || amount <= 0)
      return res.status(400).json({ error: 'Amount must be a positive number' });

    await tx.query('BEGIN');

    // Get client info (lock the row to prevent concurrent balance drift)
    const { rows: cl } = await tx.query(
      'SELECT * FROM clients WHERE id=$1 FOR UPDATE', [d.client_id]
    );
    if (!cl[0]) {
      await tx.query('ROLLBACK');
      return res.status(404).json({ error: 'Client not found' });
    }

    // ── RBAC: trainers can only record payments for THEIR OWN clients ──
    // (Without this check, any trainer could post a payment against any client
    // by guessing/pasting a client_id — breaking the data isolation guarantee.)
    if (req.user.role === 'trainer' && cl[0].trainer_id !== req.user.trainer_id) {
      await tx.query('ROLLBACK');
      return res.status(403).json({ error: 'Access denied: client is not assigned to you' });
    }

    // Resolve trainer — verify the FK target exists; if the trainer was deleted
    // without the cascade clearing the client's trainer_id, the INSERT would fail
    // with a FK violation (23503). Fall back to NULL in that case.
    let resolvedTrainerId = null;
    let resolvedTrainerName = null;
    let incentiveRate = 0.5;
    if (cl[0].trainer_id) {
      const { rows: tr } = await tx.query(
        'SELECT id, name, incentive_rate FROM trainers WHERE id=$1', [cl[0].trainer_id]
      );
      if (tr[0]) {
        resolvedTrainerId   = tr[0].id;
        resolvedTrainerName = tr[0].name ?? cl[0].trainer_name;
        incentiveRate       = tr[0].incentive_rate ?? 0.5;
      }
      // If trainer row is missing (deleted without cascade), keep everything NULL
      // so the payment still records and the balance still updates correctly.
    }

    const id = randomUUID();
    const receiptNo = await genReceiptNo(tx);

    await tx.query(`
      INSERT INTO payments (id,client_id,client_name,trainer_id,trainer_name,
        amount,method,date,receipt_no,package_type,incentive_amt,notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, d.client_id, cl[0].name,
       resolvedTrainerId, resolvedTrainerName,
       amount, d.method||'CASH', d.date, receiptNo,
       cl[0].package_type, Math.round(amount * incentiveRate),
       d.notes||null]
    );

    // Update client balance
    await tx.query(`
      UPDATE clients
      SET paid_amount = paid_amount + $1,
          balance_amount = GREATEST(0, balance_amount - $1),
          updated_at = NOW()
      WHERE id = $2`, [amount, d.client_id]
    );

    await tx.query('COMMIT');

    const { rows } = await pool.query('SELECT * FROM payments WHERE id=$1', [id]);
    res.status(201).json({ message: 'Payment recorded', payment: rows[0] });
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    logger.error({ err: err.message }, 'Payment error');
    next(err);
  } finally {
    tx.release();
  }
});

// GET /api/payments/stats — server-side aggregation for KPI cards
// Avoids the 200-row paginated list being used for totals.
router.get('/stats', auth, async (req, res, next) => {
  try {
    const { from, to, trainer_id } = req.query;
    const conditions = ['p.deleted_at IS NULL'];
    const params = [];
    let p = 1;

    if (req.user.role === 'trainer' && req.user.trainer_id) {
      conditions.push(`p.trainer_id = $${p++}`); params.push(req.user.trainer_id);
    } else if (trainer_id) {
      conditions.push(`p.trainer_id = $${p++}`); params.push(trainer_id);
    }
    if (from) { conditions.push(`p.date >= $${p++}`); params.push(from); }
    if (to)   { conditions.push(`p.date <= $${p++}`); params.push(to); }

    const { sql: bsql, params: bparams } = req.branchScope.appendTo(params);
    if (bsql !== 'TRUE') conditions.push(`p.${bsql}`);

    const where = 'WHERE ' + conditions.join(' AND ');

    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::int                                                          AS count,
        COALESCE(SUM(p.amount), 0)                                            AS total,
        COALESCE(SUM(p.amount) FILTER (WHERE p.method = 'CASH'),  0)          AS cash,
        COALESCE(SUM(p.amount) FILTER (WHERE p.method = 'UPI'),   0)          AS upi,
        COALESCE(SUM(p.amount) FILTER (WHERE p.method = 'CARD'),  0)          AS card,
        COALESCE(SUM(p.amount) FILTER (WHERE p.method = 'NEFT' OR p.method = 'BANK'), 0) AS bank,
        COALESCE(SUM(p.incentive_amt), 0)                                     AS total_incentives
      FROM payments p
      ${where}
    `, bparams);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/payments/:id (admin only)
//
// Soft delete by default (sets deleted_at). The balance reversal still runs
// so the client's paid/balance figures stay correct. Pass ?hard=1 to fully
// remove the row — only do this for tests.
router.delete('/:id', auth, adminOnly, async (req, res, next) => {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');

    let payment;
    let alreadyReversed = false;
    if (req.query.hard === '1') {
      // Don't double-reverse a balance that a prior soft-delete already reset.
      const { rows } = await tx.query(
        'DELETE FROM payments WHERE id=$1 RETURNING *', [req.params.id]
      );
      payment = rows[0];
      if (payment && payment.deleted_at) alreadyReversed = true;
    } else {
      const { rows } = await tx.query(
        `UPDATE payments
            SET deleted_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING *`, [req.params.id]
      );
      payment = rows[0];
    }

    if (!payment) {
      await tx.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }

    // Reverse the balance change atomically (only if not already done
    // by a previous soft-delete of the same row).
    if (!alreadyReversed) {
      await tx.query(`
        UPDATE clients
        SET paid_amount = GREATEST(0, paid_amount - $1),
            balance_amount = balance_amount + $1,
            updated_at = NOW()
        WHERE id = $2`, [payment.amount, payment.client_id]
      );
    }
    await tx.query('COMMIT');
    res.json({ message: 'Payment deleted' });
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    tx.release();
  }
});

module.exports = router;

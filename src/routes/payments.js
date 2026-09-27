// src/routes/payments.js
//
// Canonical payment API for the finance UI.
//
// History: the app originally kept clients in `clients` and payments in
// `payments`. The PT-OS enrolment flow replaced that world with `pt_clients`
// + `pt_payments`, leaving the legacy pair permanently empty — which meant
// POST /api/payments could never find a real client (404 on every attempt)
// and no payment was ever recordable through the finance UI.
//
// Now:
//   • POST writes to pt_payments and updates pt_clients balances.
//   • GET / and GET /stats read BOTH ledgers (legacy rows still surface if
//     any old install has them) with pt_payments columns aliased to the
//     legacy response shape (method, receipt_no).
//   • DELETE handles rows from either ledger and reverses the balance on
//     the owning client table.
const router = require('express').Router();
const pool = require('../db/pool');
const { auth, requireTrainer } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { paymentSchemas } = require('../lib/validation');
const { tenantScope } = require('../lib/tenant-db');
const logger = require('../lib/logger');
const { logActivity } = require('../lib/activityLog');
const { recordPtPayment } = require('../lib/ptPayments');

// The studio's finance ledger: the trainer's, and nobody else's. Declared on
// the router as well as at the mount (server.js) so the guard travels with the
// router. A client's own payments are served by GET /api/me/payments.
router.use(auth, requireTrainer);

// The ledger. One table, one shape.
//
// ── What the UNION ALL that used to be here was doing ───────────────────────
//
// This selected from pt_payments and then UNION ALL'd the legacy `payments`
// table, aliasing its columns into the same shape. The second half ended
// `NULL::uuid AS organization_id` — because that table has no such column,
// having never had one — and every caller then filtered on
// `p.organization_id = $n`. A NULL never equals anything, so legacy rows were
// invisible to a scoped read and visible to an unscoped one: an unscopable
// ledger sitting behind a tenant filter that could not reach it.
//
// It held 0 rows, so nothing leaked. That is the data being safe, not the code
// — one inserted row and this was a cross-tenant financial read. pt_payments
// is the only payment ledger now, it carries organization_id, and the filter
// applies to every row in it.
//
// branch_id and package_type are still selected as NULL: pt_payments has
// neither, and the branch-scope clause (`branch_id = $n OR branch_id IS NULL`)
// reads the shim as "visible", which is the behaviour these rows already had.
const LEDGER_SQL = `
  SELECT p.id, p.client_id, c.name AS client_name, p.trainer_id,
         t.name AS trainer_name, p.amount, p.incentive_amt,
         UPPER(p.payment_method) AS method, p.payment_ref AS receipt_no,
         p.date, p.notes, p.deleted_at, p.created_at,
         NULL::text AS branch_id, NULL::text AS package_type, p.organization_id
  FROM pt_payments p
  LEFT JOIN pt_clients c ON c.id = p.client_id AND c.organization_id = p.organization_id
  LEFT JOIN trainers   t ON t.id = p.trainer_id AND t.organization_id = p.organization_id
`;

// GET /api/payments
router.get('/', auth, async (req, res, next) => {
  try {
    const { client_id, trainer_id, from, to, limit = 200, offset = 0 } = req.query;
    const conditions = [];
    const params = [];
    let p = 1;

    // Optional filters. Both only narrow a query that is already scoped to
    // the caller's organization below.
    if (trainer_id) { conditions.push(`p.trainer_id = $${p++}`); params.push(trainer_id); }
    if (client_id)  { conditions.push(`p.client_id = $${p++}`);  params.push(client_id); }
    if (from)      { conditions.push(`p.date >= $${p++}`);     params.push(from); }
    if (to)        { conditions.push(`p.date <= $${p++}`);     params.push(to); }
    // Hide soft-deleted payments unless caller explicitly asks for them.
    if (req.query.include_deleted !== '1') {
      conditions.push(`p.deleted_at IS NULL`);
    }

    // Multi-tenant isolation: only this studio's payments; legacy-ledger rows
    // carry NULL org and drop out.
    const scope = tenantScope(req);
    conditions.push(`p.organization_id = $${p++}`);
    params.push(scope.orgId);
    const bparams = params;

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const { rows } = await pool.query(`
      SELECT p.*, p.trainer_name AS trainer_name_full
      FROM (${LEDGER_SQL}) p
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

// POST /api/payments — Finance → Record Payment.
//
// The write itself — the client lock, the ledger row, the balance, the
// receipt number, the activity log and payment_received after COMMIT — is
// lib/ptPayments.js, shared with the client profile's Payments tab so the two
// cannot drift. What stays here is this endpoint's own contract: a client is
// required, the incentive is the trainer's rate, and the receipt number is
// always issued rather than taken from the request.
router.post('/', auth, validate(paymentSchemas.create), async (req, res, next) => {
  try {
    const d = req.body;
    if (!d.client_id || !d.amount || !d.date)
      return res.status(400).json({ error: 'client_id, amount and date required' });

    const amount = parseFloat(d.amount);
    if (!Number.isFinite(amount) || amount <= 0)
      return res.status(400).json({ error: 'Amount must be a positive number' });

    // Scoped in the lookup itself and answered 404, so another studio's
    // client id is indistinguishable from one that does not exist.
    const result = await recordPtPayment(req, {
      orgId: tenantScope(req).orgId,
      clientId: d.client_id,
      amount,
      method: String(d.method || 'CASH').toUpperCase(),
      date: d.date,
      notes: d.notes || null,
      paymentRef: null,
      incentive: 'trainer_rate',
    });
    if (result.notFound) return res.status(404).json({ error: 'Client not found' });

    res.status(201).json({ message: 'Payment recorded', payment: result.payment });
  } catch (err) {
    logger.error({ err: err.message }, 'Payment error');
    next(err);
  }
});

// GET /api/payments/stats — server-side aggregation for KPI cards
// Avoids the 200-row paginated list being used for totals.
router.get('/stats', auth, async (req, res, next) => {
  try {
    const { from, to, trainer_id, client_id } = req.query;
    const conditions = ['p.deleted_at IS NULL'];
    const params = [];
    let p = 1;

    // Optional filters, narrowing a query already scoped to this studio.
    if (trainer_id) { conditions.push(`p.trainer_id = $${p++}`); params.push(trainer_id); }
    if (client_id)  { conditions.push(`p.client_id = $${p++}`);  params.push(client_id); }
    if (from) { conditions.push(`p.date >= $${p++}`); params.push(from); }
    if (to)   { conditions.push(`p.date <= $${p++}`); params.push(to); }

    // Multi-tenant isolation: scope KPI totals to the caller's org.
    const scope = tenantScope(req);
    conditions.push(`p.organization_id = $${p++}`);
    params.push(scope.orgId);
    const bparams = params;

    const where = 'WHERE ' + conditions.join(' AND ');

    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::int                                                          AS count,
        COALESCE(SUM(p.amount), 0)                                            AS total,
        COALESCE(SUM(p.amount) FILTER (WHERE p.method = 'CASH'),  0)          AS cash,
        COALESCE(SUM(p.amount) FILTER (WHERE p.method = 'UPI'),   0)          AS upi,
        COALESCE(SUM(p.amount) FILTER (WHERE p.method = 'CARD'),  0)          AS card,
        -- BANK_TRANSFER is what the client profile's Payments tab records;
        -- leaving it out put those payments in the total but in no method.
        COALESCE(SUM(p.amount) FILTER (WHERE p.method IN ('NEFT', 'BANK', 'BANK_TRANSFER')), 0) AS bank,
        COALESCE(SUM(p.incentive_amt), 0)                                     AS total_incentives
      FROM (${LEDGER_SQL}) p
      ${where}
    `, bparams);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/payments/:id
//
// Soft delete by default (sets deleted_at). The balance reversal still runs
// so the client's paid/balance figures stay correct.
router.delete('/:id', auth, requireTrainer, async (req, res, next) => {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');

    // Multi-tenant isolation (Phase 1): only delete payments in the caller's
    // organization — a cross-tenant id simply won't match and 404s below.
    const scope = tenantScope(req);
    const dParams = [req.params.id];
    let dOrgClause = '';
    dParams.push(scope.orgId);
    dOrgClause = ` AND organization_id = $${dParams.length}`;

    // ── Canonical ledger ──
    const { rows: ptRows } = await tx.query(
      `UPDATE pt_payments
          SET deleted_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL${dOrgClause}
        RETURNING *`, dParams
    );
    if (ptRows[0]) {
      await tx.query(`
        UPDATE pt_clients
        SET paid_amount = GREATEST(0, paid_amount - $1),
            balance_amount = balance_amount + $1,
            updated_at = NOW()
        WHERE id = $2 AND organization_id = $3`, [ptRows[0].amount, ptRows[0].client_id, scope.orgId]
      );
      await tx.query('COMMIT');
      await logActivity(req, 'payment.delete', 'pt_payment', ptRows[0].id, null, ptRows[0]);
      return res.json({ message: 'Payment deleted' });
    }

    // The legacy-ledger fallback that used to sit here is gone with the table.
    //
    // It ran when the pt_payments UPDATE above matched nothing, and issued
    // `DELETE FROM payments WHERE id=$1` / `UPDATE payments SET deleted_at`
    // with NO organization filter — the org clause built above was applied to
    // the canonical statement only. Against a table with rows that is a
    // cross-tenant delete by id; against this one it matched nothing, every
    // time, because the table has been empty since PT-OS shipped.
    //
    // A payment id that does not resolve in pt_payments for this studio is now
    // simply a 404 — which is what the fallback amounted to in practice, minus
    // the unscoped write it would have performed had a row ever existed.
    await tx.query('ROLLBACK');
    return res.status(404).json({ error: 'Not found' });
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    tx.release();
  }
});

module.exports = router;

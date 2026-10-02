// src/routes/invoices.js — Invoices CRUD + actions
const router = require('express').Router();
const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');
const { tenantScope, orgIdOf } = require('../lib/tenant-db');
const logger = require('../lib/logger');
const { parseStrict } = require('../lib/zodNumbers');
const { logActivity } = require('../lib/activityLog');
const automation = require('../modules/automation/automation.triggers');

// Payments audit PAY-5. The unpaid lifecycle states — the only ones a caller
// may set directly, on create or on edit. Paying goes through
// POST /:id/mark-paid, which records the money; cancelling through
// POST /:id/cancel. Any other status written here would claim money moved, or
// stopped moving, without the ledger knowing.
const EDITABLE_STATUSES = ['draft', 'sent', 'overdue'];

/** A line-item price and quantity, parsed as strictly as the simplified path. */
function itemNumbers(item) {
  const price = parseStrict(item?.unit_price);
  if (!price.ok || price.value < 0) return { error: 'unit_price must be a number of 0 or more' };
  let quantity = 1;
  if (item?.quantity !== undefined && item.quantity !== null && item.quantity !== '') {
    const q = parseStrict(item.quantity);
    if (!q.ok || !Number.isInteger(q.value) || q.value < 1) return { error: 'quantity must be a whole number of 1 or more' };
    quantity = q.value;
  }
  return { price: price.value, quantity };
}

// GET /api/invoices — List invoices
router.get('/', auth, async (req, res, next) => {
  try {
    const { status, search, from, to, limit = 100, offset = 0 } = req.query;
    const conds = [];
    const params = [];
    let p = 1;

    // Multi-tenant isolation: only the caller's org's invoices.
    const scope = tenantScope(req);
    conds.push(`i.organization_id = $${p++}`); params.push(scope.orgId);

    if (status && status !== 'all') {
      conds.push(`i.status = $${p++}`);
      params.push(status);
    }
    if (search) {
      conds.push(`(i.client_name ILIKE $${p} OR i.invoice_no ILIKE $${p})`);
      params.push(`%${search}%`);
      p++;
    }
    if (from) { conds.push(`i.issue_date >= $${p++}`); params.push(from); }
    if (to)   { conds.push(`i.issue_date <= $${p++}`); params.push(to); }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const { rows } = await pool.query(`
      SELECT i.*,
        pc.photo_url AS client_photo,
        COALESCE((SELECT json_agg(json_build_object(
          'id', ii.id,
          'description', ii.description,
          'quantity', ii.quantity,
          'unit_price', ii.unit_price,
          'amount', ii.amount,
          'type', ii.type
        )) FROM invoice_items ii WHERE ii.invoice_id = i.id), '[]'::json) AS items
      FROM invoices i
      -- Only for the client's face on the list. The org equality is part of
      -- the join rather than assumed from i.client_id: an invoice carries a
      -- denormalised client_name and a nullable client_id, and this must not
      -- become a way to read a row from another tenant. Legacy rows with a
      -- NULL organization_id match nothing and fall back to initials.
      LEFT JOIN pt_clients pc
        ON pc.id = i.client_id
       AND pc.organization_id = i.organization_id
       AND pc.deleted_at IS NULL
      ${where}
      ORDER BY i.issue_date DESC, i.created_at DESC
      LIMIT $${p++} OFFSET $${p++}`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    // Stats (same tenant scope as the list)
    const statsWhere  = 'WHERE organization_id = $1';
    const statsParams = [scope.orgId];
    const { rows: stats } = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COALESCE(SUM(total_amount) FILTER (WHERE status = 'paid'), 0) AS paid,
        COALESCE(SUM(total_amount) FILTER (WHERE status IN ('draft','sent','partial')), 0) AS pending,
        COALESCE(SUM(total_amount) FILTER (WHERE status = 'overdue'), 0) AS overdue
      FROM invoices
      ${statsWhere}
    `, statsParams);

    res.json({ invoices: rows, stats: stats[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/invoices/:id
router.get('/:id', auth, async (req, res, next) => {
  try {
    const scope = tenantScope(req);
    const guard = ' AND i.organization_id = $2';
    const params = [req.params.id, scope.orgId];
    const { rows } = await pool.query(`
      SELECT i.*,
        COALESCE((SELECT json_agg(json_build_object(
          'id', ii.id,
          'description', ii.description,
          'quantity', ii.quantity,
          'unit_price', ii.unit_price,
          'amount', ii.amount,
          'type', ii.type
        )) FROM invoice_items ii WHERE ii.invoice_id = i.id), '[]'::json) AS items
      FROM invoices i WHERE i.id = $1${guard}`, params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Invoice not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/invoices — Create invoice
router.post('/', auth, async (req, res, next) => {
  const tx = await pool.connect();
  try {
    const d = req.body;

    // Accept both the structured form {client_id, items[]} and the simplified
    // form {member_name, amount, description, due_date} that the frontend sends.
    const isSimplified = !d.client_id && !d.items?.length && (d.member_name || d.amount);
    if (!isSimplified && !d.client_id && !d.items?.length)
      return res.status(400).json({ error: 'client_id and items[] required' });
    // Create used to store any status, `paid` included — an invoice born paid
    // with no payment on the ledger and no change to what the client owes.
    if (d.status != null && !EDITABLE_STATUSES.includes(d.status)) {
      return res.status(400).json({
        error: `status can only be ${EDITABLE_STATUSES.join(', ')} on a new invoice — use Mark as paid or Cancel`,
      });
    }
    // `parseFloat(x) || 0` read '18%' as 18 and a negative rate as a discount.
    let taxPct = 0;
    if (d.tax_pct !== undefined && d.tax_pct !== null && d.tax_pct !== '') {
      const t = parseStrict(d.tax_pct);
      if (!t.ok || t.value < 0 || t.value > 100) {
        return res.status(400).json({ error: 'tax_pct must be a number from 0 to 100' });
      }
      taxPct = t.value;
    }
    const lines = [];
    if (!isSimplified) {
      for (const item of d.items || []) {
        const n = itemNumbers(item);
        if (n.error) return res.status(400).json({ error: n.error });
        lines.push({ item, ...n });
      }
    }

    await tx.query('BEGIN');

    const clientId = d.client_id || null;
    let clientName = d.client_name || d.member_name || '';

    // Structured form: look up the client (pt_clients is the live client
    // table — the legacy `clients` table has been empty since PT-OS shipped)
    if (!isSimplified) {
      // Multi-tenant isolation: the client must belong to the caller's
      // organization. Without the org predicate this lookup accepted ANY
      // client id, so a caller could invoice against another studio's client
      // and read that client's name back in the 201 response — a cross-tenant
      // disclosure on a route that otherwise stamps the invoice with the
      // caller's own org. 404 rather than 403, matching payments.js and
      // mark-paid below, so a miss never confirms the id exists elsewhere.
      const cScope = tenantScope(req);
      const cParams = [d.client_id];
      let cGuard = '';
      cParams.push(cScope.orgId);
      cGuard = ` AND organization_id = $${cParams.length}`;
      const { rows: cl } = await tx.query(
        `SELECT id, name FROM pt_clients WHERE id=$1 AND deleted_at IS NULL${cGuard}`, cParams
      );
      if (!cl[0]) { await tx.query('ROLLBACK'); return res.status(404).json({ error: 'Client not found' }); }
      clientName = cl[0].name;
    }

    const id = randomUUID();
    const invNo = 'INV-' + Date.now();
    let subtotal = 0;

    if (isSimplified) {
      // `parseFloat(d.amount) || 0` created a ₹0 invoice for a blank, a
      // whitespace string or anything unparseable — and parseFloat is looser
      // still, because it parses a PREFIX: '1,500' is 1 and '12abc' is 12. An
      // invoice for the wrong amount is worse than a rejected request, because
      // it is sent to a member and entered in their accounts.
      const parsed = parseStrict(d.amount);
      if (!parsed.ok) {
        await tx.query('ROLLBACK');
        return res.status(400).json({
          error: parsed.reason === 'absent' ? 'amount is required' : 'amount must be a number',
        });
      }
      if (parsed.value <= 0) {
        await tx.query('ROLLBACK');
        return res.status(400).json({ error: 'amount must be greater than 0' });
      }
      subtotal = parsed.value;
    } else {
      for (const l of lines) subtotal += l.price * l.quantity;
    }

    const taxAmt = subtotal * (taxPct / 100);
    const total = subtotal + taxAmt;

    await tx.query(`
      INSERT INTO invoices (id, invoice_no, client_id, client_name, amount, tax_amount, total_amount,
        status, due_date, issue_date, payment_method, notes, created_by, organization_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, invNo, clientId, clientName, subtotal, taxAmt, total,
       d.status || 'draft', d.due_date || null, d.issue_date || new Date().toISOString().split('T')[0],
       d.payment_method || null, d.notes || d.description || null, req.user.id, orgIdOf(req)]
    );

    if (!isSimplified) {
      for (const { item, price, quantity } of lines) {
        await tx.query(`
          INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price, amount, type)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [randomUUID(), id, item.description, quantity, price, price * quantity, item.type || 'other']
        );
      }
    } else if (d.description) {
      // Create a single line item from the simplified form
      await tx.query(`
        INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price, amount, type)
        VALUES ($1,$2,$3,1,$4,$5,'other')`,
        [randomUUID(), id, d.description, subtotal, subtotal]
      );
    }

    await tx.query('COMMIT');

    const { rows } = await pool.query('SELECT * FROM invoices WHERE id=$1', [id]);
    await logActivity(req, 'invoice.create', 'invoice', id, rows[0]);
    res.status(201).json({ message: 'Invoice created', invoice: rows[0] });
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    logger.error({ err: err.message }, 'Invoice creation error');
    next(err);
  } finally {
    tx.release();
  }
});

// PUT /api/invoices/:id — Update invoice
router.put('/:id', auth, async (req, res, next) => {
  try {
    const scope = tenantScope(req);
    const gCol = ' AND organization_id = $2';
    const gParams = [req.params.id, scope.orgId];
    const { rows: ex } = await pool.query(
      `SELECT * FROM invoices WHERE id=$1${gCol}`, gParams
    );
    if (!ex[0]) return res.status(404).json({ error: 'Invoice not found' });
    if (ex[0].status === 'paid')
      return res.status(400).json({ error: 'Cannot update a paid invoice' });

    const d = req.body;
    // Only the unpaid lifecycle states are settable (EDITABLE_STATUSES, above).
    if (d.status != null && d.status !== ex[0].status && !EDITABLE_STATUSES.includes(d.status)) {
      return res.status(400).json({
        error: `status can only be set to ${EDITABLE_STATUSES.join(', ')} here — use Mark as paid or Cancel`,
      });
    }
    const { rows } = await pool.query(`
      UPDATE invoices SET
        status = COALESCE($1, status),
        payment_method = COALESCE($2, payment_method),
        notes = COALESCE($3, notes),
        due_date = COALESCE($4, due_date),
        updated_at = NOW()
      WHERE id = $5 RETURNING *`,
      [d.status || ex[0].status, d.payment_method ?? ex[0].payment_method,
       d.notes ?? ex[0].notes, d.due_date ?? ex[0].due_date, req.params.id]
    );
    await logActivity(req, 'invoice.update', 'invoice', req.params.id, rows[0], ex[0]);
    res.json({ message: 'Invoice updated', invoice: rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/invoices/:id/send — Mark as sent
router.post('/:id/send', auth, async (req, res, next) => {
  try {
    const scope = tenantScope(req);
    const guard = ' AND organization_id = $2';
    const params = [req.params.id, scope.orgId];
    const { rows } = await pool.query(
      `UPDATE invoices SET status='sent', sent_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND status='draft'${guard} RETURNING *`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Invoice not found or already sent' });
    await logActivity(req, 'invoice.send', 'invoice', rows[0].id, { status: rows[0].status });
    res.json({ message: 'Invoice sent', invoice: rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/invoices/:id/mark-paid
router.post('/:id/mark-paid', auth, async (req, res, next) => {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const scope = tenantScope(req);
    const guard = ' AND organization_id = $2';
    const params = [req.params.id, scope.orgId];
    const { rows: inv } = await tx.query(
      // prev_paid is what had already been paid on this invoice before this
      // call (the FROM row is read from the pre-update snapshot). Only the
      // remainder is money arriving now: marking a part-paid invoice paid
      // used to book its FULL total again (payments audit PAY-5).
      `UPDATE invoices i SET status='paid', paid_at=NOW(), paid_amount=i.total_amount, updated_at=NOW()
         FROM (SELECT COALESCE(paid_amount, 0) AS prev_paid FROM invoices WHERE id=$1) prev
       WHERE i.id=$1 AND i.status IN ('sent','draft','partial','overdue')${guard.replace('organization_id', 'i.organization_id')}
       RETURNING i.*, prev.prev_paid`,
      params
    );
    if (!inv[0]) { await tx.query('ROLLBACK'); return res.status(404).json({ error: 'Invoice not found or already paid' }); }

    // Record the payment in the canonical ledger.
    //
    // ── This used to INSERT INTO `payments`, and that was the bug ───────────
    //
    // That table has no organization_id column, so the row it wrote could not
    // be attributed to a studio and no org-scoped read could ever return it.
    // Marking an invoice paid produced a financial record that was invisible
    // to the finance pages, absent from every revenue report, and — had the
    // table ever been read unscoped — visible to every tenant.
    //
    // pt_payments is the ledger the rest of the application reads, and the org
    // is taken from the INVOICE rather than from the request: the UPDATE above
    // already proved that invoice belongs to this studio, so the payment
    // inherits an ownership that has been checked rather than one asserted a
    // second time.
    // Record the payment and link the invoice to it, in one statement.
    //
    // ── The link ────────────────────────────────────────────────────────────
    //
    // invoices.payment_id has existed all along with a foreign key to the
    // legacy ledger, and nothing ever wrote it — "which payment settled this
    // invoice" was a question the schema was shaped to answer and the code
    // never did. Migration 191 repoints that key at pt_payments and adds the
    // column where a fresh build lacked it; this fills it.
    //
    // ── Why a CTE rather than an INSERT followed by an UPDATE ───────────────
    //
    // Two reasons, one of them enforced. The adapter's SQL-literal budget in
    // architecture.layering.convention.test.js only ever shrinks, and a second
    // literal here would have raised it — writing the link as a separate
    // statement made this file 18 against a budget of 17. It is also simply
    // better: the payment and its link land together or not at all, with no
    // window in which a payment exists that the invoice does not point to.
    //
    // COALESCE on the SET, because ON CONFLICT DO NOTHING can return no row —
    // without it a conflicting insert would blank an existing link.
    const receiptNo = inv[0].invoice_no;
    const remaining = Math.max(0, Number(inv[0].total_amount) - Number(inv[0].prev_paid || 0));
    // Nothing left to pay is no money arriving: no ₹0 ledger row.
    if (remaining > 0) await tx.query(`
      WITH new_payment AS (
        INSERT INTO pt_payments
          (id, client_id, trainer_id, amount, payment_method, date, payment_ref,
           notes, organization_id, created_at, updated_at)
        VALUES ($1, $2, NULL, $3, $4, CURRENT_DATE, $5, $6, $7, NOW(), NOW())
        ON CONFLICT DO NOTHING
        RETURNING id
      )
      UPDATE invoices
         SET payment_id = COALESCE((SELECT id FROM new_payment), payment_id)
       WHERE id = $8 AND organization_id = $7`,
      [randomUUID(), inv[0].client_id, remaining,
       req.body.payment_method || 'CASH', receiptNo,
       'Payment for invoice ' + inv[0].invoice_no, inv[0].organization_id, inv[0].id]
    );

    // Update the linked client's paid/balance fields so their financial record
    // stays correct. pt_clients is the live client table (the legacy `clients`
    // table has been empty since PT-OS shipped), and invoices.client_id keys
    // into it — so this is what actually reflects the payment on the client.
    if (inv[0].client_id && remaining > 0) {
      await tx.query(`
        UPDATE pt_clients
        SET paid_amount    = COALESCE(paid_amount, 0) + $1,
            balance_amount = GREATEST(0, COALESCE(balance_amount, 0) - $1),
            updated_at     = NOW()
        WHERE id = $2 AND deleted_at IS NULL AND organization_id = $3`,
        [remaining, inv[0].client_id, inv[0].organization_id]
      );
    }

    await tx.query('COMMIT');

    await logActivity(req, 'invoice.mark_paid', 'invoice', inv[0].id, {
      invoice_no: inv[0].invoice_no, client_id: inv[0].client_id, amount_booked: remaining,
      payment_method: req.body.payment_method || 'CASH',
    });

    // Marking an invoice paid IS money arriving, so the studio's
    // payment_received automation fires here as it does on every other
    // payment path. This one raised nothing, so a client invoiced and marked
    // paid heard nothing while the same money taken at the desk messaged them.
    //
    // After COMMIT, outside the transaction, like every other call site.
    //
    // The INVOICE id is the event key here, not a payment id. The insert above
    // carries ON CONFLICT DO NOTHING, so on a re-mark there may be no new
    // payment row at all and a payment id would be an unstable identity for
    // the event. "Invoice N was paid" happens once and the invoice id says so
    // exactly — which is also what makes a double-submitted mark-as-paid one
    // event rather than two messages to the client.
    //
    // Guarded on client_id because an invoice need not have one; the balance
    // update above is guarded the same way.
    if (inv[0].client_id && remaining > 0) {
      await automation.paymentReceived(req, {
        clientId: inv[0].client_id,
        amount: remaining,
        eventKey: `invoice:${inv[0].id}`,
      });
    }

    res.json({ message: 'Invoice marked as paid', invoice: inv[0] });
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    tx.release();
  }
});

// POST /api/invoices/:id/remind
//
// Payments audit PAY-4. This wrote a log line and answered "Reminder sent to
// <name>", which the Invoices page showed as success — nothing was ever sent,
// and the trainer believed the client had been reminded. Until a reminder is
// actually delivered through the studio's messaging, say so plainly.
router.post('/:id/remind', auth, async (req, res, next) => {
  try {
    const scope = tenantScope(req);
    const guard = ' AND organization_id = $2';
    const params = [req.params.id, scope.orgId];
    const { rows } = await pool.query(`SELECT * FROM invoices WHERE id=$1${guard}`, params);
    if (!rows[0]) return res.status(404).json({ error: 'Invoice not found' });
    res.status(501).json({
      error: 'Invoice reminders are not sent automatically yet — message the client from their profile.',
      code: 'NOT_IMPLEMENTED',
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/invoices/:id/cancel
router.post('/:id/cancel', auth, async (req, res, next) => {
  try {
    const scope = tenantScope(req);
    const guard = ' AND organization_id = $2';
    const params = [req.params.id, scope.orgId];
    const { rows } = await pool.query(
      `UPDATE invoices SET status='cancelled', cancelled_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND status NOT IN ('paid','cancelled')${guard} RETURNING *`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Invoice not found or cannot be cancelled' });
    await logActivity(req, 'invoice.cancel', 'invoice', rows[0].id, { invoice_no: rows[0].invoice_no, status: rows[0].status });
    res.json({ message: 'Invoice cancelled', invoice: rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

// src/routes/invoices.js — Invoices CRUD + actions
const router = require('express').Router();
const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const { auth, adminOnly } = require('../middleware/auth');
const logger = require('../lib/logger');

// GET /api/invoices — List invoices
router.get('/', auth, async (req, res, next) => {
  try {
    const { status, search, from, to, limit = 100, offset = 0 } = req.query;
    const conds = [];
    const params = [];
    let p = 1;

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
        COALESCE((SELECT json_agg(json_build_object(
          'id', ii.id,
          'description', ii.description,
          'quantity', ii.quantity,
          'unit_price', ii.unit_price,
          'amount', ii.amount,
          'type', ii.type
        )) FROM invoice_items ii WHERE ii.invoice_id = i.id), '[]'::json) AS items
      FROM invoices i
      ${where}
      ORDER BY i.issue_date DESC, i.created_at DESC
      LIMIT $${p++} OFFSET $${p++}`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    // Stats
    const { rows: stats } = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COALESCE(SUM(total_amount) FILTER (WHERE status = 'paid'), 0) AS paid,
        COALESCE(SUM(total_amount) FILTER (WHERE status IN ('draft','sent','partial')), 0) AS pending,
        COALESCE(SUM(total_amount) FILTER (WHERE status = 'overdue'), 0) AS overdue
      FROM invoices
    `);

    res.json({ invoices: rows, stats: stats[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/invoices/:id
router.get('/:id', auth, async (req, res, next) => {
  try {
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
      FROM invoices i WHERE i.id = $1`, [req.params.id]
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
    if (!d.client_id || !d.items?.length)
      return res.status(400).json({ error: 'client_id and items[] required' });

    await tx.query('BEGIN');

    // Get client info
    const { rows: cl } = await tx.query(
      'SELECT id, name FROM clients WHERE id=$1', [d.client_id]
    );
    if (!cl[0]) { await tx.query('ROLLBACK'); return res.status(404).json({ error: 'Client not found' }); }

    const id = randomUUID();
    const invNo = 'INV-' + Date.now();
    let subtotal = 0;
    for (const item of d.items) {
      const amt = (parseFloat(item.unit_price) || 0) * (parseInt(item.quantity) || 1);
      subtotal += amt;
    }
    const taxPct = parseFloat(d.tax_pct) || 0;
    const taxAmt = subtotal * (taxPct / 100);
    const total = subtotal + taxAmt;

    await tx.query(`
      INSERT INTO invoices (id, invoice_no, client_id, client_name, amount, tax_amount, total_amount,
        status, due_date, issue_date, payment_method, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, invNo, d.client_id, cl[0].name, subtotal, taxAmt, total,
       d.status || 'draft', d.due_date || null, d.issue_date || new Date().toISOString().split('T')[0],
       d.payment_method || null, d.notes || null, req.user.id]
    );

    for (const item of d.items) {
      const amt = (parseFloat(item.unit_price) || 0) * (parseInt(item.quantity) || 1);
      await tx.query(`
        INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price, amount, type)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), id, item.description, parseInt(item.quantity) || 1,
         parseFloat(item.unit_price) || 0, amt, item.type || 'other']
      );
    }

    await tx.query('COMMIT');

    const { rows } = await pool.query('SELECT * FROM invoices WHERE id=$1', [id]);
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
    const { rows: ex } = await pool.query(
      'SELECT * FROM invoices WHERE id=$1', [req.params.id]
    );
    if (!ex[0]) return res.status(404).json({ error: 'Invoice not found' });
    if (ex[0].status === 'paid')
      return res.status(400).json({ error: 'Cannot update a paid invoice' });

    const d = req.body;
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
    res.json({ message: 'Invoice updated', invoice: rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/invoices/:id/send — Mark as sent
router.post('/:id/send', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE invoices SET status='sent', sent_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND status='draft' RETURNING *`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Invoice not found or already sent' });
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
    const { rows: inv } = await tx.query(
      `UPDATE invoices SET status='paid', paid_at=NOW(), paid_amount=total_amount, updated_at=NOW()
       WHERE id=$1 AND status IN ('sent','draft','partial','overdue') RETURNING *`,
      [req.params.id]
    );
    if (!inv[0]) { await tx.query('ROLLBACK'); return res.status(404).json({ error: 'Invoice not found or already paid' }); }

    // Also record as a payment if not already recorded
    const receiptNo = 'INV-' + inv[0].invoice_no;
    await tx.query(`
      INSERT INTO payments (id, client_id, client_name, trainer_id, amount, method, date, receipt_no, notes, created_at)
      VALUES ($1, $2, $3, NULL, $4, $5, CURRENT_DATE, $6, $7, NOW())
      ON CONFLICT DO NOTHING`,
      [randomUUID(), inv[0].client_id, inv[0].client_name, inv[0].total_amount,
       req.body.payment_method || 'CASH', receiptNo, 'Payment for invoice ' + inv[0].invoice_no]
    );

    await tx.query('COMMIT');
    res.json({ message: 'Invoice marked as paid', invoice: inv[0] });
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    tx.release();
  }
});

// POST /api/invoices/:id/remind
router.post('/:id/remind', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM invoices WHERE id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Invoice not found' });
    logger.info({ invoiceId: req.params.id, userId: req.user.id }, 'Payment reminder sent');
    res.json({ message: 'Reminder sent to ' + rows[0].client_name });
  } catch (err) {
    next(err);
  }
});

// POST /api/invoices/:id/cancel
router.post('/:id/cancel', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE invoices SET status='cancelled', cancelled_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND status NOT IN ('paid','cancelled') RETURNING *`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Invoice not found or cannot be cancelled' });
    res.json({ message: 'Invoice cancelled', invoice: rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

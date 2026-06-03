const router = require('express').Router();
const pool = require('../../db/pool');
const { auth, adminOnly, adminOrManager } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const logger = require('../../lib/logger');
const svc = require('./pt-os.service');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ─── Trainers ───────────────────────────────────────────────
router.get('/trainers', auth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, name, email, mobile, specialization, incentive_rate, status, photo_url FROM pt_trainers WHERE deleted_at IS NULL AND status = 'active' ORDER BY name"
  );
  res.json({ data: rows });
}));

router.post('/trainers', auth, adminOnly, wrap(async (req, res) => {
  const { name, email, mobile, specialization, incentive_rate } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO pt_trainers (name, email, mobile, specialization, incentive_rate)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [name, email, mobile, specialization, incentive_rate ?? 0.5]
  );
  res.status(201).json({ data: rows[0] });
}));

// ─── Dashboard stats ─────────────────────────────────────────
router.get('/dashboard', auth, wrap(async (req, res) => {
  const stats = await svc.getDashboardStats();
  res.json({ data: stats });
}));

// ─── Active PT clients ───────────────────────────────────────
router.get('/clients', auth, wrap(async (req, res) => {
  const trainerId = req.query.trainer_id;
  const tid = req.user.role === 'trainer' ? req.user.trainer_id : trainerId;
  const rows = await svc.getActiveClients(tid);
  res.json({ data: rows, total: rows.length });
}));

// ─── Single client details ──────────────────────────────────
router.get('/clients/:id', auth, wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT c.*,
           (c.pt_end_date - CURRENT_DATE) AS days_left,
           CASE
             WHEN c.balance_amount > 0 AND c.pt_end_date < CURRENT_DATE THEN 'OVERDUE'
             WHEN c.balance_amount > 0 THEN 'DUE'
             ELSE 'CLEAR'
           END AS due_status
    FROM pt_clients c
    WHERE c.id = $1 AND c.deleted_at IS NULL
  `, [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  res.json({ data: rows[0] });
}));

// ─── Create / enroll client in PT ───────────────────────────
router.post('/clients', auth, requireRole('admin','manager','trainer'), wrap(async (req, res) => {
  try {
    const {
      client_id, name, gender, mobile, email, dob,
      trainer_id, package_type, base_amount, discount,
      pt_start_date, duration_months, monthly_pt_amount,
      notes, weight,
    } = req.body;

    let cid = client_id;
    if (!cid) {
      const { rows: [newCli] } = await pool.query(`
        INSERT INTO pt_clients (name, gender, mobile, email, dob, status, joining_date)
        VALUES ($1,$2,$3,$4,$5,'active',$6)
        RETURNING id
      `, [name, gender || null, mobile || null, email || null, dob || null, pt_start_date || new Date()]);
      cid = newCli.id;
    }

    const finalAmt = (base_amount || 0) - (discount || 0);
    const trainer = trainer_id ? (await pool.query('SELECT name FROM pt_trainers WHERE id=$1', [trainer_id])).rows[0] : null;

    const startDate = pt_start_date || new Date().toISOString().slice(0, 10);
    let endDate = null;
    if (duration_months && duration_months > 0) {
      const d = new Date(startDate);
      d.setMonth(d.getMonth() + Number(duration_months));
      endDate = d.toISOString().slice(0, 10);
    }

    const { rows } = await pool.query(`
      UPDATE pt_clients SET
        trainer_id = COALESCE($2, trainer_id),
        trainer_name = COALESCE($3, trainer_name),
        package_type = COALESCE($4, package_type),
        base_amount = COALESCE($5, base_amount),
        discount = COALESCE($6, discount),
        final_amount = COALESCE($7, final_amount),
        monthly_pt_amount = COALESCE($8, monthly_pt_amount),
        pt_start_date = COALESCE($9, pt_start_date),
        pt_end_date = COALESCE($10, pt_end_date),
        duration_months = COALESCE($11, duration_months),
        notes = COALESCE($12, notes),
        weight = COALESCE($13, weight),
        status = 'active',
        updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING *
    `, [
      cid, trainer_id, trainer?.name || null, package_type,
      base_amount, discount, finalAmt, monthly_pt_amount,
      startDate, endDate, duration_months,
      notes || null, weight != null ? Number(weight) : null,
    ]);

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    logger.error({ err: err.message, body: req.body, user: req.user?.id }, 'PT OS create client failed');
    throw err;
  }
}));

// ─── Update PT client ───────────────────────────────────────
router.patch('/clients/:id', auth, requireRole('admin','manager','trainer'), wrap(async (req, res) => {
  const isTrainer = req.user.role === 'trainer';
  const allowed = isTrainer
    ? ['package_type','trainer_id','trainer_name','pt_start_date','pt_end_date',
       'duration_months','status','notes','monthly_pt_amount']
    : ['package_type','base_amount','discount','final_amount','paid_amount',
       'monthly_pt_amount','trainer_id','trainer_name','pt_start_date','pt_end_date',
       'duration_months','status','notes'];
  const sets = [];
  const params = [req.params.id];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      params.push(req.body[key]);
      sets.push(`${key} = $${params.length}`);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: { code: 'NO_FIELDS', message: 'No fields to update' } });
  sets.push('updated_at = NOW()');

  const { rows } = await pool.query(
    `UPDATE pt_clients SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    params
  );
  if (rows.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  res.json({ data: rows[0] });
}));

// ─── Client photo upload ────────────────────────────────────
router.post('/clients/:id/photo', auth, wrap(async (req, res) => {
  const { photo } = req.body;
  if (!photo) return res.status(400).json({ error: { code: 'NO_PHOTO', message: 'No photo data provided' } });
  const { rows } = await pool.query(
    'UPDATE pt_clients SET photo_url = $1, updated_at = NOW() WHERE id = $2 AND deleted_at IS NULL RETURNING id',
    [photo, req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  res.json({ data: rows[0] });
}));

// ─── Balance sheet ──────────────────────────────────────────
router.get('/balance-sheet', auth, wrap(async (req, res) => {
  const trainerId = req.user.role === 'trainer' ? req.user.trainer_id : req.query.trainer_id;
  const rows = await svc.getBalanceSheet(trainerId);
  res.json({ data: rows, total: rows.length, total_outstanding: rows.reduce((s, r) => s + Number(r.balance_amount), 0) });
}));

// ─── PT Plans ───────────────────────────────────────────────
router.get('/plans', auth, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM pt_plans WHERE is_active = TRUE ORDER BY base_amount');
  res.json({ data: rows });
}));

router.post('/plans', auth, adminOnly, wrap(async (req, res) => {
  const { name, duration_months, base_amount, description } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO pt_plans (name, duration_months, base_amount, description) VALUES ($1,$2,$3,$4) RETURNING *`,
    [name, duration_months, base_amount, description]
  );
  res.status(201).json({ data: rows[0] });
}));

// ─── Commissions ────────────────────────────────────────────
router.get('/commissions', auth, wrap(async (req, res) => {
  const trainerId = req.user.role === 'trainer' ? req.user.trainer_id : req.query.trainer_id;
  const rows = await svc.getCommissionHistory(trainerId);
  res.json({ data: rows });
}));

router.post('/commissions/calculate', auth, adminOnly, wrap(async (req, res) => {
  const month = req.body.month || new Date().toISOString().slice(0, 7);
  const result = await svc.calculateMonthlyCommissions(month);
  res.json({ data: result });
}));

// ─── Payouts ────────────────────────────────────────────────
router.get('/payouts', auth, wrap(async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const rows = await svc.getTrainerPayouts(month);
  res.json({ data: rows, month });
}));

router.post('/payouts', auth, adminOnly, wrap(async (req, res) => {
  const { trainer_id, month, deductions } = req.body;
  const payout = await svc.createPayout(trainer_id, month, deductions || 0, req.user.id);
  res.status(201).json({ data: payout });
}));

router.post('/payouts/:id/approve', auth, adminOnly, wrap(async (req, res) => {
  const { payment_method, payment_ref } = req.body;
  const payout = await svc.markPayoutPaid(req.params.id, payment_method, payment_ref, req.user.id);
  res.json({ data: payout });
}));

// ─── Revenue report ─────────────────────────────────────────
router.get('/revenue', auth, wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      DATE_TRUNC('month', date)::DATE AS month,
      COUNT(*)::INT AS transactions,
      COALESCE(SUM(amount), 0) AS revenue,
      COALESCE(SUM(incentive_amt), 0) AS incentives,
      COUNT(*) FILTER (WHERE incentive_amt > 0)::INT AS incentive_count
    FROM pt_payments
    WHERE deleted_at IS NULL
      AND date >= DATE_TRUNC('year', CURRENT_DATE)
    GROUP BY DATE_TRUNC('month', date)
    ORDER BY month DESC
  `);
  res.json({ data: rows });
}));

// ─── Trainer performance ────────────────────────────────────
router.get('/trainer-performance', auth, adminOrManager, wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      t.id, t.name, t.incentive_rate,
      COUNT(c.id) FILTER (WHERE c.status = 'active')::INT AS active_clients,
      COALESCE(SUM(c.monthly_pt_amount) FILTER (WHERE c.status = 'active'), 0) AS monthly_pt_revenue,
      COALESCE(SUM(c.trainer_commission) FILTER (WHERE c.status = 'active'), 0) AS monthly_commission,
      COALESCE(SUM(p.amount) FILTER (WHERE p.deleted_at IS NULL), 0) AS total_payment_revenue,
      COALESCE(SUM(p.incentive_amt) FILTER (WHERE p.deleted_at IS NULL), 0) AS total_incentives
    FROM pt_trainers t
    LEFT JOIN pt_clients c ON c.trainer_id = t.id AND c.deleted_at IS NULL AND c.pt_start_date IS NOT NULL
    LEFT JOIN pt_payments p ON p.trainer_id = t.id AND p.deleted_at IS NULL
    WHERE t.deleted_at IS NULL AND t.status = 'active'
    GROUP BY t.id, t.name, t.incentive_rate
    ORDER BY monthly_pt_revenue DESC
  `);
  res.json({ data: rows });
}));

// ─── Sessions ───────────────────────────────────────────────
router.get('/sessions', auth, wrap(async (req, res) => {
  const { trainer_id, date } = req.query;
  const where = ['s.deleted_at IS NULL'];
  const params = [];
  if (trainer_id) { params.push(trainer_id); where.push(`s.trainer_id = $${params.length}`); }
  if (date) { params.push(date); where.push(`s.date = $${params.length}`); }
  const { rows } = await pool.query(`
    SELECT s.*, c.name AS client_name
    FROM pt_sessions s
    LEFT JOIN pt_clients c ON c.id = s.client_id
    WHERE ${where.join(' AND ')}
    ORDER BY s.date DESC, s.start_time
  `, params);
  res.json({ data: rows });
}));

router.post('/sessions', auth, wrap(async (req, res) => {
  const { client_id, client, trainer_id, title, date, start_time, end_time, notes } = req.body;
  let cid = client_id;
  if (!cid && client) {
    const { rows } = await pool.query("SELECT id FROM pt_clients WHERE name = $1 AND deleted_at IS NULL LIMIT 1", [client]);
    if (rows.length > 0) cid = rows[0].id;
  }
  const { rows } = await pool.query(
    `INSERT INTO pt_sessions (client_id, trainer_id, title, date, start_time, end_time, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [cid, trainer_id, title || 'PT Session', date, start_time, end_time, notes, req.user.id]
  );
  res.status(201).json({ data: rows[0] });
}));

// ─── Payments ───────────────────────────────────────────────
router.get('/payments', auth, wrap(async (req, res) => {
  const { client_id, trainer_id } = req.query;
  const where = ['p.deleted_at IS NULL'];
  const params = [];
  if (client_id) { params.push(client_id); where.push(`p.client_id = $${params.length}`); }
  if (trainer_id) { params.push(trainer_id); where.push(`p.trainer_id = $${params.length}`); }
  const { rows } = await pool.query(`
    SELECT p.*, c.name AS client_name, t.name AS trainer_name
    FROM pt_payments p
    LEFT JOIN pt_clients c ON c.id = p.client_id
    LEFT JOIN pt_trainers t ON t.id = p.trainer_id
    WHERE ${where.join(' AND ')}
    ORDER BY p.date DESC
  `, params);
  res.json({ data: rows });
}));

router.post('/payments', auth, wrap(async (req, res) => {
  const { client_id, trainer_id, amount, incentive_amt, payment_method, payment_ref, date, notes } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO pt_payments (client_id, trainer_id, amount, incentive_amt, payment_method, payment_ref, date, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [client_id, trainer_id, amount, incentive_amt ?? 0, payment_method, payment_ref, date || new Date(), notes]
  );
  res.status(201).json({ data: rows[0] });
}));

module.exports = router;

const router = require('express').Router();
const pool = require('../../db/pool');
const { auth, adminOnly, adminOrManager } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const logger = require('../../lib/logger');
const svc = require('./pt-os.service');
const { generateClientId, generateMemberCode } = require('../../db/id-gen');

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

// ─── Duplicate Client Audit (MUST be before /clients/:id) ───
router.get('/clients/duplicates', auth, adminOnly, wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      TRIM(LOWER(REGEXP_REPLACE(name, '\\s+', ' ', 'g'))) AS normalized_name,
      (ARRAY_AGG(name ORDER BY created_at ASC))[1] AS display_name,
      COUNT(*)::int AS record_count,
      MIN(created_at)::date AS first_seen,
      ARRAY_AGG(pt_start_date ORDER BY pt_start_date NULLS LAST)
        FILTER (WHERE pt_start_date IS NOT NULL) AS subscription_starts,
      SUM(final_amount)::numeric AS total_final,
      SUM(paid_amount)::numeric  AS total_paid,
      GREATEST(0, SUM(final_amount) - SUM(paid_amount))::numeric AS balance,
      (ARRAY_AGG(id ORDER BY created_at ASC))[1] AS master_id,
      ARRAY_AGG(id ORDER BY created_at ASC) AS all_ids,
      (ARRAY_AGG(mobile ORDER BY created_at ASC NULLS LAST)
        FILTER (WHERE mobile IS NOT NULL AND mobile != ''))[1] AS mobile,
      (ARRAY_AGG(package_type ORDER BY pt_start_date DESC NULLS LAST)
        FILTER (WHERE package_type IS NOT NULL))[1] AS latest_plan,
      (ARRAY_AGG(trainer_name ORDER BY pt_start_date DESC NULLS LAST)
        FILTER (WHERE trainer_name IS NOT NULL))[1] AS trainer_name
    FROM pt_clients
    WHERE deleted_at IS NULL
    GROUP BY TRIM(LOWER(REGEXP_REPLACE(name, '\\s+', ' ', 'g')))
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC, normalized_name
  `);
  res.json({
    data: rows,
    total_groups: rows.length,
    total_records: rows.reduce((s, r) => s + r.record_count, 0),
    total_duplicates: rows.reduce((s, r) => s + r.record_count - 1, 0),
    total_financial_value: rows.reduce((s, r) => s + Number(r.total_final), 0),
  });
}));

// ─── Single client details ──────────────────────────────────
router.get('/clients/:id', auth, wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT c.*,
           CASE
             WHEN c.pt_end_date IS NOT NULL AND c.pt_end_date::TEXT != ''
             THEN c.pt_end_date::DATE - CURRENT_DATE
             ELSE NULL
           END AS days_left,
           COALESCE(pp.total_incentives, 0) AS total_earned_commission,
           CASE
             WHEN c.balance_amount > 0
              AND c.pt_end_date IS NOT NULL AND c.pt_end_date::TEXT != ''
              AND c.pt_end_date::DATE < CURRENT_DATE THEN 'OVERDUE'
             WHEN c.balance_amount > 0 THEN 'DUE'
             ELSE 'CLEAR'
           END AS due_status
    FROM pt_clients c
    LEFT JOIN (
      SELECT client_id, SUM(incentive_amt) AS total_incentives
      FROM pt_payments
      WHERE deleted_at IS NULL
      GROUP BY client_id
    ) pp ON pp.client_id = c.id
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
          pt_package_id, base_price, selling_price,
        } = req.body;

    let cid = client_id;
    let memberCode = null;
    if (!cid) {
      const pgClient = await pool.connect();
      try {
        await pgClient.query('BEGIN');
        await pgClient.query("SELECT pg_advisory_xact_lock(1937456102)");
        memberCode = await generateMemberCode(pgClient);
        const { rows: [newCli] } = await pgClient.query(`
          INSERT INTO pt_clients (name, gender, mobile, email, dob, status, joining_date)
          VALUES ($1,$2,$3,$4,$5,'active',$6)
          RETURNING id
        `, [name, gender || null, mobile || null, email || null, dob || null, pt_start_date || new Date()]);
        await pgClient.query('COMMIT');
        cid = newCli.id;
      } catch (txErr) {
        await pgClient.query('ROLLBACK');
        throw txErr;
      } finally {
        pgClient.release();
      }
    } else {
      const { rows: [row] } = await pool.query('SELECT member_code FROM pt_clients WHERE id=$1', [cid]);
      memberCode = row?.member_code || null;
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
        member_code = COALESCE($14, member_code),
        status = 'active',
        updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING *
    `, [
      cid, trainer_id, trainer?.name || null, package_type,
      base_amount, discount, finalAmt, monthly_pt_amount,
      startDate, endDate, duration_months,
      notes || null, weight != null ? Number(weight) : null,
      memberCode,
    ]);

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    logger.error({ err: err.message, body: req.body, user: req.user?.id }, 'PT OS create client failed');
    throw err;
  }
}));

// ─── Renewal history for a client ───────────────────────────
router.get('/clients/:id/renewals', auth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM pt_client_renewals WHERE client_id = $1 ORDER BY renewed_at DESC`,
    [req.params.id]
  );
  res.json({ data: rows });
}));

// ─── Renew PT client ────────────────────────────────────────
router.post('/clients/:id/renew', auth, requireRole('admin','manager','trainer'), wrap(async (req, res) => {
  const d = req.body;
  if (!d.pt_start_date || !d.duration_months)
    return res.status(400).json({ error: { code: 'VALIDATION', message: 'pt_start_date and duration_months are required' } });

  const endDate = new Date(d.pt_start_date);
  endDate.setMonth(endDate.getMonth() + Number(d.duration_months));
  const ptEndDate = endDate.toISOString().slice(0, 10);

  const baseAmt    = Number(d.base_amount)       || 0;
  const disc       = Number(d.discount)           || 0;
  const finalAmt   = d.final_amount !== undefined ? Number(d.final_amount) : Math.max(baseAmt - disc, 0);
  const paidNow    = Number(d.paid_amount)        || 0;
  const monthlyAmt = Number(d.monthly_pt_amount)  || 0;
  const packageType = d.package_type || null;

  const { rows: existing } = await pool.query(
    'SELECT * FROM pt_clients WHERE id = $1 AND deleted_at IS NULL',
    [req.params.id]
  );
  if (existing.length === 0)
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  const c = existing[0];

  const { rows } = await pool.query(`
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
      balance_amount    = GREATEST($5 - (paid_amount + $10), 0),
      status            = 'active',
      updated_at        = NOW()
    WHERE id = $1 AND deleted_at IS NULL
    RETURNING *
  `, [req.params.id, packageType, baseAmt, disc, finalAmt, monthlyAmt,
      d.pt_start_date, ptEndDate, d.duration_months, paidNow]);

  // Log to renewal history
  await pool.query(`
    INSERT INTO pt_client_renewals
      (client_id, client_name, trainer_name, old_package, new_package,
       old_end_date, new_start_date, new_end_date, duration_months,
       base_amount, discount, final_amount, paid_amount, balance_amount, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
  `, [
    req.params.id, c.name, c.trainer_name,
    c.package_type, packageType || c.package_type,
    c.pt_end_date, d.pt_start_date, ptEndDate, d.duration_months,
    baseAmt, disc, finalAmt, paidNow, Math.max(finalAmt - paidNow, 0),
    d.notes || null,
  ]);

  res.json({ data: rows[0] });
}));

// ─── Update PT client ───────────────────────────────────────
router.patch('/clients/:id', auth, requireRole('admin','manager','trainer'), wrap(async (req, res) => {
  const isTrainer = req.user.role === 'trainer';
  const allowed = isTrainer
    ? ['package_type','trainer_id','trainer_name','pt_start_date','pt_end_date',
       'duration_months','status','notes','monthly_pt_amount']
    : ['package_type','base_amount','discount','final_amount','paid_amount',
       'monthly_pt_amount','trainer_id','trainer_name','pt_start_date','pt_end_date',
       'duration_months','status','notes',
       'name','email','mobile','gender','dob','address','weight','photo_url','emergency_contact'];
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

// ─── Save client notes ──────────────────────────────────────
router.put('/clients/:id/notes', auth, wrap(async (req, res) => {
  const { notes } = req.body;
  if (notes === undefined) return res.status(400).json({ error: { code: 'NO_NOTES', message: 'Missing notes' } });
  const { rows } = await pool.query(
    'UPDATE pt_clients SET notes = $1, updated_at = NOW() WHERE id = $2 AND deleted_at IS NULL RETURNING id, notes',
    [notes, req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  res.json({ data: rows[0] });
}));

// ─── Delete PT client (soft-delete) ─────────────────────────
router.delete('/clients/:id', auth, requireRole('admin','manager'), wrap(async (req, res) => {
  const { rows } = await pool.query(`
    UPDATE pt_clients
    SET deleted_at = NOW(), updated_at = NOW(), status = 'inactive'
    WHERE id = $1 AND deleted_at IS NULL
    RETURNING id
  `, [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  res.json({ message: 'Client deleted' });
}));

// ─── Client communication history ───────────────────────────
router.get('/clients/:id/communication', auth, wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT cl.*, c.name AS client_name
    FROM communication_logs cl
    LEFT JOIN pt_clients c ON c.id = cl.recipient_id
    WHERE cl.recipient_type = 'client' AND cl.recipient_id = $1
    ORDER BY cl.created_at DESC
    LIMIT 100
  `, [req.params.id]);
  res.json({ data: rows, total: rows.length });
}));

// ─── Balance sheet ──────────────────────────────────────────
router.get('/balance-sheet', auth, wrap(async (req, res) => {
  const trainerId = req.user.role === 'trainer' ? req.user.trainer_id : req.query.trainer_id;
  const rows = await svc.getBalanceSheet(trainerId);
  res.json({ data: rows, total: rows.length, total_outstanding: rows.reduce((s, r) => s + Number(r.balance_amount), 0) });
}));

// ─── PT Plans ───────────────────────────────────────────────
router.get('/plans', auth, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM pt_plans ORDER BY base_amount');
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

router.put('/plans/:id', auth, adminOnly, wrap(async (req, res) => {
  const { name, duration_months, base_amount, description, is_active } = req.body;
  const { rows } = await pool.query(`
    UPDATE pt_plans SET
      name = COALESCE($2, name),
      duration_months = COALESCE($3, duration_months),
      base_amount = COALESCE($4, base_amount),
      description = COALESCE($5, description),
      is_active = COALESCE($6, is_active),
      updated_at = NOW()
    WHERE id = $1 RETURNING *
  `, [req.params.id, name, duration_months, base_amount, description, is_active]);
  if (rows.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
  res.json({ data: rows[0] });
}));

router.delete('/plans/:id', auth, adminOnly, wrap(async (req, res) => {
  const { rows } = await pool.query('DELETE FROM pt_plans WHERE id = $1 RETURNING id', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
  res.json({ message: 'Plan deleted' });
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
  if (date) { params.push(date); where.push(`s.session_date = $${params.length}`); }
  const { rows } = await pool.query(`
    SELECT s.*, c.name AS client_name
    FROM pt_sessions s
    LEFT JOIN pt_clients c ON c.id = s.client_id
    WHERE ${where.join(' AND ')}
    ORDER BY s.session_date DESC, s.start_time
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
    `INSERT INTO pt_sessions (client_id, trainer_id, title, session_date, start_time, end_time, notes, created_by)
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
  const numAmount = Number(amount) || 0;
  const { rows } = await pool.query(
    `INSERT INTO pt_payments (client_id, trainer_id, amount, incentive_amt, payment_method, payment_ref, date, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [client_id, trainer_id, numAmount, incentive_amt ?? 0, payment_method, payment_ref, date || new Date(), notes]
  );
  // update client paid_amount and balance_amount
  await pool.query(
    `UPDATE pt_clients SET
       paid_amount = paid_amount + $1,
       balance_amount = GREATEST(balance_amount - $1, 0),
       updated_at = NOW()
     WHERE id = $2 AND deleted_at IS NULL`,
    [numAmount, client_id]
  );
  res.status(201).json({ data: rows[0] });
}));

// ─── Execute Duplicate Merge ─────────────────────────────────
router.post('/clients/merge-duplicates', auth, adminOnly, wrap(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Ensure backup table exists and snapshot affected records
    await client.query(`
      CREATE TABLE IF NOT EXISTS pt_clients_merge_backup (
        LIKE pt_clients INCLUDING ALL,
        backed_up_at TIMESTAMPTZ DEFAULT NOW(),
        merge_run TEXT
      )
    `);
    const mergeRun = new Date().toISOString();
    await client.query(`
      INSERT INTO pt_clients_merge_backup
        SELECT *, NOW(), $1 FROM pt_clients
        WHERE deleted_at IS NULL
          AND TRIM(LOWER(REGEXP_REPLACE(name, '\\s+', ' ', 'g'))) IN (
            SELECT TRIM(LOWER(REGEXP_REPLACE(name, '\\s+', ' ', 'g')))
            FROM pt_clients WHERE deleted_at IS NULL
            GROUP BY TRIM(LOWER(REGEXP_REPLACE(name, '\\s+', ' ', 'g')))
            HAVING COUNT(*) > 1
          )
    `, [mergeRun]);

    // 2. Ensure merge log table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS pt_clients_merge_log (
        id            SERIAL PRIMARY KEY,
        run_id        TEXT,
        run_at        TIMESTAMPTZ DEFAULT NOW(),
        master_id     TEXT,
        merged_ids    TEXT[],
        normalized_name TEXT,
        record_count  INT,
        subs_merged   INT,
        total_final   NUMERIC,
        total_paid    NUMERIC,
        balance       NUMERIC
      )
    `);

    // 3. Fetch all duplicate groups in one shot
    const { rows: groups } = await client.query(`
      SELECT
        TRIM(LOWER(REGEXP_REPLACE(name, '\\s+', ' ', 'g'))) AS norm,
        ARRAY_AGG(id ORDER BY created_at ASC) AS all_ids,
        COUNT(*)::int AS cnt,
        SUM(final_amount)  AS total_final,
        SUM(paid_amount)   AS total_paid,
        SUM(base_amount)   AS total_base,
        GREATEST(0, SUM(final_amount) - SUM(paid_amount)) AS balance
      FROM pt_clients WHERE deleted_at IS NULL
      GROUP BY TRIM(LOWER(REGEXP_REPLACE(name, '\\s+', ' ', 'g')))
      HAVING COUNT(*) > 1
    `);

    const results = [];

    // Tables that may hold references to pt_clients.id via client_id
    const refTables = [
      'pt_payments','pt_sessions','pt_commissions',
      'pt_assessments','pt_goals','weekly_checkins',
      'workout_assignments','diet_assignments','session_balance',
      'strength_logs','progress_photos','weight_logs',
      'pt_os_measurements','pt_os_sessions','pt_os_payments',
      'pt_os_assignments','pt_os_ai_insights','pt_os_coaching_events',
      'trial_sessions','churn_risk_log','client_notifications','follow_ups',
      'client_documents','client_fitness_profiles','nutrition_logs',
      'face_checkin_logs','face_descriptors',
    ];

    for (const grp of groups) {
      const masterId = grp.all_ids[0];
      const dupIds   = grp.all_ids.slice(1);

      // Update master: aggregate financials + latest subscription info
      await client.query(`
        UPDATE pt_clients SET
          final_amount    = $1,
          paid_amount     = $2,
          base_amount     = $3,
          balance_amount  = GREATEST(0, $1 - $2),
          pt_start_date   = (SELECT pt_start_date  FROM pt_clients WHERE id = ANY($4) AND pt_start_date IS NOT NULL ORDER BY pt_start_date DESC NULLS LAST LIMIT 1),
          pt_end_date     = (SELECT pt_end_date    FROM pt_clients WHERE id = ANY($4) AND pt_start_date IS NOT NULL ORDER BY pt_start_date DESC NULLS LAST LIMIT 1),
          duration_months = (SELECT duration_months FROM pt_clients WHERE id = ANY($4) AND pt_start_date IS NOT NULL ORDER BY pt_start_date DESC NULLS LAST LIMIT 1),
          package_type    = (SELECT package_type   FROM pt_clients WHERE id = ANY($4) AND package_type IS NOT NULL ORDER BY COALESCE(pt_start_date,'1970-01-01') DESC LIMIT 1),
          monthly_pt_amount = (SELECT monthly_pt_amount FROM pt_clients WHERE id = ANY($4) AND pt_start_date IS NOT NULL ORDER BY pt_start_date DESC NULLS LAST LIMIT 1),
          trainer_name    = (SELECT trainer_name   FROM pt_clients WHERE id = ANY($4) AND trainer_name IS NOT NULL ORDER BY COALESCE(pt_start_date,'1970-01-01') DESC LIMIT 1),
          mobile          = COALESCE((SELECT mobile  FROM pt_clients WHERE id = ANY($4) AND mobile IS NOT NULL AND mobile != '' ORDER BY updated_at DESC LIMIT 1), mobile),
          email           = COALESCE((SELECT email   FROM pt_clients WHERE id = ANY($4) AND email  IS NOT NULL ORDER BY updated_at DESC LIMIT 1), email),
          address         = COALESCE((SELECT address FROM pt_clients WHERE id = ANY($4) AND address IS NOT NULL ORDER BY updated_at DESC LIMIT 1), address),
          notes           = COALESCE((SELECT notes   FROM pt_clients WHERE id = ANY($4) AND notes  IS NOT NULL ORDER BY updated_at DESC LIMIT 1), notes),
          joining_date    = (SELECT MIN(joining_date) FROM pt_clients WHERE id = ANY($4) AND joining_date IS NOT NULL),
          updated_at      = NOW()
        WHERE id = $5 AND deleted_at IS NULL
      `, [grp.total_final, grp.total_paid, grp.total_base, grp.all_ids, masterId]);

      // Re-point all related records to master
      for (const tbl of refTables) {
        await client.query(
          `UPDATE ${tbl} SET client_id = $1 WHERE client_id = ANY($2)`,
          [masterId, dupIds]
        );
      }

      // Soft-delete duplicates
      await client.query(
        `UPDATE pt_clients SET deleted_at = NOW(), updated_at = NOW() WHERE id = ANY($1)`,
        [dupIds]
      );

      // Log this merge
      await client.query(`
        INSERT INTO pt_clients_merge_log
          (run_id, master_id, merged_ids, normalized_name, record_count, subs_merged, total_final, total_paid, balance)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, [mergeRun, masterId, dupIds, grp.norm, grp.cnt, grp.cnt - 1,
          grp.total_final, grp.total_paid, grp.balance]);

      results.push({
        name: grp.norm,
        master_id: masterId,
        merged_count: dupIds.length,
        total_final: Number(grp.total_final),
        total_paid: Number(grp.total_paid),
        balance: Number(grp.balance),
      });
    }

    await client.query('COMMIT');

    logger.info(`[merge-duplicates] run_id=${mergeRun} groups=${results.length} records_removed=${results.reduce((s,r)=>s+r.merged_count,0)}`);
    res.json({
      success: true,
      run_id: mergeRun,
      merged_groups: results.length,
      records_removed: results.reduce((s, r) => s + r.merged_count, 0),
      results,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('[merge-duplicates] error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
}));

module.exports = router;

// src/routes/client-actions.js
// All membership action endpoints: freeze, extension, upgrade, downgrade,
// transfer, combo, trial, assign-pt, add-subscription, renew-subscription
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const pool = require('../db/pool');
const { genReceiptNo } = require('../db/receipts');
const { auth } = require('../middleware/auth');

function num(v, fb = 0) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fb;
}

// ── RBAC GUARD ──────────────────────────────────────────────────────
// Without this guard a trainer could freeze, transfer, upgrade or otherwise
// mutate ANY client in the system (privilege escalation).
//   admin / manager / reception → may act on any client
//   trainer                     → only on clients with matching trainer_id
//   anything else               → denied
async function assertCanActOnClient(req, res, tx, client) {
  const role = req.user && req.user.role;
  if (role === 'admin' || role === 'manager' || role === 'reception') return true;
  if (role === 'trainer') {
    if (!req.user.trainer_id) {
      await tx.query('ROLLBACK');
      res.status(403).json({ error: 'Access denied: trainer profile not linked' });
      return false;
    }
    if (client.trainer_id !== req.user.trainer_id) {
      await tx.query('ROLLBACK');
      res.status(403).json({ error: 'Access denied: client is not assigned to you' });
      return false;
    }
    return true;
  }
  await tx.query('ROLLBACK');
  res.status(403).json({ error: 'Access denied' });
  return false;
}

async function logAction(tx, clientId, clientName, trainerId, type, oldVal, newVal, amount, method, notes, performedBy) {
  try {
    await tx.query(
      `INSERT INTO membership_actions
         (id,client_id,client_name,trainer_id,action_type,old_value,new_value,amount,payment_method,notes,performed_by,action_date)
       VALUES (gen_random_uuid()::TEXT,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CURRENT_DATE)`,
      [clientId, clientName, trainerId, type,
       JSON.stringify(oldVal), JSON.stringify(newVal),
       amount, method || 'CASH', notes || null, performedBy || null]
    );
  } catch (_) { /* non-fatal — action log failure shouldn't break the action */ }
}

// ── FREEZE ───────────────────────────────────────────────────────────────
// POST /api/clients/:id/freeze
router.post('/:id/freeze', auth, async (req, res, next) => {
  const tx = await pool.connect();
  try {
    const d = req.body;
    if (!d.freeze_from || !d.freeze_until)
      return res.status(400).json({ error: 'freeze_from and freeze_until are required' });

    await tx.query('BEGIN');
    const { rows } = await tx.query('SELECT * FROM clients WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!rows[0]) { await tx.query('ROLLBACK'); return res.status(404).json({ error: 'Client not found' }); }
    const c = rows[0];
    if (!(await assertCanActOnClient(req, res, tx, c))) return;

    await tx.query(
      `UPDATE clients SET freeze_from=$1, freeze_until=$2, freeze_reason=$3,
         is_frozen=TRUE, status='frozen', updated_at=NOW() WHERE id=$4`,
      [d.freeze_from, d.freeze_until, d.reason || null, req.params.id]
    );
    await logAction(tx, c.id, c.name, c.trainer_id, 'freeze',
      { status: c.status }, { freeze_from: d.freeze_from, freeze_until: d.freeze_until, reason: d.reason },
      0, null, d.reason, req.user?.name);

    await tx.query('COMMIT');
    const { rows: fresh } = await pool.query('SELECT * FROM clients WHERE id=$1', [req.params.id]);
    res.json({ message: 'Membership frozen', client: fresh[0] });
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    next(err);
  } finally { tx.release(); }
});

// ── EXTENSION ────────────────────────────────────────────────────────────
// POST /api/clients/:id/extension
router.post('/:id/extension', auth, async (req, res, next) => {
  const tx = await pool.connect();
  try {
    const d = req.body;
    const days = parseInt(d.days) || 0;
    if (days <= 0) return res.status(400).json({ error: 'days must be a positive number' });

    await tx.query('BEGIN');
    const { rows } = await tx.query('SELECT * FROM clients WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!rows[0]) { await tx.query('ROLLBACK'); return res.status(404).json({ error: 'Client not found' }); }
    const c = rows[0];
    if (!(await assertCanActOnClient(req, res, tx, c))) return;

    const { rows: ext } = await tx.query(
      `UPDATE clients SET
         pt_end_date = COALESCE(pt_end_date, CURRENT_DATE) + ($1 || ' days')::INTERVAL,
         updated_at = NOW()
       WHERE id=$2 RETURNING pt_end_date`,
      [days, req.params.id]
    );
    await logAction(tx, c.id, c.name, c.trainer_id, 'extension',
      { pt_end_date: c.pt_end_date }, { days_added: days, new_end_date: ext[0].pt_end_date },
      0, null, d.reason, req.user?.name);

    await tx.query('COMMIT');
    const { rows: fresh } = await pool.query('SELECT * FROM clients WHERE id=$1', [req.params.id]);
    res.json({ message: `Membership extended by ${days} days`, client: fresh[0] });
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    next(err);
  } finally { tx.release(); }
});

// ── UPGRADE ──────────────────────────────────────────────────────────────
// POST /api/clients/:id/upgrade
router.post('/:id/upgrade', auth, async (req, res, next) => {
  const tx = await pool.connect();
  try {
    const d = req.body;
    if (!d.package_type) return res.status(400).json({ error: 'package_type is required' });

    await tx.query('BEGIN');
    const { rows } = await tx.query('SELECT * FROM clients WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!rows[0]) { await tx.query('ROLLBACK'); return res.status(404).json({ error: 'Client not found' }); }
    const c = rows[0];
    if (!(await assertCanActOnClient(req, res, tx, c))) return;

    const amount = num(d.amount, 0);
    await tx.query(
      `UPDATE clients SET package_type=$1,
         pt_start_date=COALESCE($2, pt_start_date),
         pt_end_date=COALESCE($3, pt_end_date),
         final_amount=CASE WHEN $4>0 THEN $4 ELSE final_amount END,
         balance_amount=CASE WHEN $4>0 THEN GREATEST(0,$4-paid_amount) ELSE balance_amount END,
         status='active', updated_at=NOW()
       WHERE id=$5`,
      [d.package_type, d.start_date || null, d.end_date || null, amount, req.params.id]
    );

    await tx.query(`INSERT INTO renewals (id,client_id,client_name,trainer_id,trainer_name,
        old_package,new_package,old_end_date,new_end_date,amount,paid_amount,payment_method,renewed_on,notes,action_type)
      VALUES (gen_random_uuid()::TEXT,$1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,CURRENT_DATE,$11,'upgrade')`,
      [c.id, c.name, c.trainer_id, c.trainer_name, c.package_type, d.package_type,
       c.pt_end_date, d.end_date || c.pt_end_date, amount, d.payment_method || 'CASH', d.reason || null]);

    if (amount > 0) {
      const rcp = await genReceiptNo(tx);
      let iRate = 0.5;
      if (c.trainer_id) {
        const { rows: tr } = await tx.query('SELECT incentive_rate FROM trainers WHERE id=$1', [c.trainer_id]);
        iRate = tr[0]?.incentive_rate ?? 0.5;
      }
      await tx.query(`INSERT INTO payments (id,client_id,client_name,trainer_id,trainer_name,
          amount,method,date,receipt_no,package_type,incentive_amt,notes)
        VALUES (gen_random_uuid()::TEXT,$1,$2,$3,$4,$5,$6,CURRENT_DATE,$7,$8,$9,$10)`,
        [c.id, c.name, c.trainer_id, c.trainer_name, amount,
         d.payment_method || 'CASH', rcp, d.package_type,
         Math.round(amount * iRate), `Upgrade to ${d.package_type}`]);
    }

    await logAction(tx, c.id, c.name, c.trainer_id, 'upgrade',
      { package_type: c.package_type }, { package_type: d.package_type, amount },
      amount, d.payment_method, d.reason, req.user?.name);

    await tx.query('COMMIT');
    const { rows: fresh } = await pool.query('SELECT * FROM clients WHERE id=$1', [req.params.id]);
    res.json({ message: `Upgraded to ${d.package_type}`, client: fresh[0] });
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    next(err);
  } finally { tx.release(); }
});

// ── DOWNGRADE ────────────────────────────────────────────────────────────
// POST /api/clients/:id/downgrade
router.post('/:id/downgrade', auth, async (req, res, next) => {
  const tx = await pool.connect();
  try {
    const d = req.body;
    if (!d.package_type) return res.status(400).json({ error: 'package_type is required' });
    if (!d.reason) return res.status(400).json({ error: 'reason is required for downgrades' });

    await tx.query('BEGIN');
    const { rows } = await tx.query('SELECT * FROM clients WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!rows[0]) { await tx.query('ROLLBACK'); return res.status(404).json({ error: 'Client not found' }); }
    const c = rows[0];
    if (!(await assertCanActOnClient(req, res, tx, c))) return;

    const amount = num(d.amount, 0);
    await tx.query(
      `UPDATE clients SET package_type=$1,
         final_amount=CASE WHEN $2>0 THEN $2 ELSE final_amount END,
         balance_amount=CASE WHEN $2>0 THEN GREATEST(0,$2-paid_amount) ELSE balance_amount END,
         updated_at=NOW()
       WHERE id=$3`,
      [d.package_type, amount, req.params.id]
    );

    await tx.query(`INSERT INTO renewals (id,client_id,client_name,trainer_id,trainer_name,
        old_package,new_package,old_end_date,new_end_date,amount,paid_amount,payment_method,renewed_on,notes,action_type)
      VALUES (gen_random_uuid()::TEXT,$1,$2,$3,$4,$5,$6,$7,$7,0,0,'DOWNGRADE',CURRENT_DATE,$8,'downgrade')`,
      [c.id, c.name, c.trainer_id, c.trainer_name, c.package_type, d.package_type, c.pt_end_date, d.reason]);

    await logAction(tx, c.id, c.name, c.trainer_id, 'downgrade',
      { package_type: c.package_type }, { package_type: d.package_type },
      0, null, d.reason, req.user?.name);

    await tx.query('COMMIT');
    const { rows: fresh } = await pool.query('SELECT * FROM clients WHERE id=$1', [req.params.id]);
    res.json({ message: `Downgraded to ${d.package_type}`, client: fresh[0] });
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    next(err);
  } finally { tx.release(); }
});

// ── TRANSFER (change trainer) ─────────────────────────────────────────────
// POST /api/clients/:id/transfer  — admin/manager/reception only.
// Trainers must NOT initiate transfers (they could otherwise reassign
// clients to themselves to inflate their book / incentives).
router.post('/:id/transfer', auth, async (req, res, next) => {
  const tx = await pool.connect();
  try {
    if (!['admin', 'manager', 'reception'].includes(req.user && req.user.role)) {
      return res.status(403).json({ error: 'Only admin/manager/reception can transfer clients' });
    }
    const d = req.body;
    if (!d.new_trainer_id) return res.status(400).json({ error: 'new_trainer_id is required' });

    await tx.query('BEGIN');
    const { rows } = await tx.query('SELECT * FROM clients WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!rows[0]) { await tx.query('ROLLBACK'); return res.status(404).json({ error: 'Client not found' }); }
    const c = rows[0];
    if (!(await assertCanActOnClient(req, res, tx, c))) return;

    const { rows: tr } = await tx.query('SELECT name FROM trainers WHERE id=$1', [d.new_trainer_id]);
    if (!tr[0]) { await tx.query('ROLLBACK'); return res.status(404).json({ error: 'New trainer not found' }); }

    await tx.query(
      `UPDATE clients SET trainer_id=$1, trainer_name=$2, updated_at=NOW() WHERE id=$3`,
      [d.new_trainer_id, tr[0].name, req.params.id]
    );

    await logAction(tx, c.id, c.name, c.trainer_id, 'transfer',
      { trainer_id: c.trainer_id, trainer_name: c.trainer_name },
      { trainer_id: d.new_trainer_id, trainer_name: tr[0].name },
      0, null, d.reason, req.user?.name);

    await tx.query('COMMIT');
    const { rows: fresh } = await pool.query('SELECT * FROM clients WHERE id=$1', [req.params.id]);
    res.json({ message: `Transferred to ${tr[0].name}`, client: fresh[0] });
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    next(err);
  } finally { tx.release(); }
});

// ── COMBO OFFER ──────────────────────────────────────────────────────────
// POST /api/clients/:id/combo
router.post('/:id/combo', auth, async (req, res, next) => {
  const tx = await pool.connect();
  try {
    const d = req.body;
    if (!d.combo_plan) return res.status(400).json({ error: 'combo_plan is required' });

    await tx.query('BEGIN');
    const { rows } = await tx.query('SELECT * FROM clients WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!rows[0]) { await tx.query('ROLLBACK'); return res.status(404).json({ error: 'Client not found' }); }
    const c = rows[0];
    if (!(await assertCanActOnClient(req, res, tx, c))) return;

    const amount = num(d.amount, 0);
    const trainerId = d.trainer_id || c.trainer_id;

    await tx.query(
      `UPDATE clients SET combo_plan=$1, package_type=$2,
         trainer_id=COALESCE($3, trainer_id),
         pt_start_date=COALESCE($4, pt_start_date),
         pt_end_date=COALESCE($5, pt_end_date),
         final_amount=CASE WHEN $6>0 THEN $6 ELSE final_amount END,
         balance_amount=CASE WHEN $6>0 THEN GREATEST(0,$6-paid_amount) ELSE balance_amount END,
         status='active', updated_at=NOW()
       WHERE id=$7`,
      [d.combo_plan, d.combo_plan, trainerId, d.start_date || null,
       d.end_date || null, amount, req.params.id]
    );

    if (amount > 0) {
      let iRate = 0.5;
      if (trainerId) {
        const { rows: tr } = await tx.query('SELECT incentive_rate FROM trainers WHERE id=$1', [trainerId]);
        iRate = tr[0]?.incentive_rate ?? 0.5;
      }
      await tx.query(`INSERT INTO payments (id,client_id,client_name,trainer_id,trainer_name,
          amount,method,date,receipt_no,package_type,incentive_amt,notes)
        VALUES (gen_random_uuid()::TEXT,$1,$2,$3,$4,$5,$6,CURRENT_DATE,$7,$8,$9,$10)`,
        [c.id, c.name, trainerId, c.trainer_name, amount,
         d.payment_method || 'CASH', await genReceiptNo(tx), d.combo_plan,
         Math.round(amount * iRate), `Combo: ${d.combo_plan}`]);
    }

    await logAction(tx, c.id, c.name, c.trainer_id, 'combo',
      { package_type: c.package_type }, { combo_plan: d.combo_plan, amount },
      amount, d.payment_method, null, req.user?.name);

    await tx.query('COMMIT');
    const { rows: fresh } = await pool.query('SELECT * FROM clients WHERE id=$1', [req.params.id]);
    res.json({ message: 'Combo offer applied', client: fresh[0] });
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    next(err);
  } finally { tx.release(); }
});

// ── TRIAL ────────────────────────────────────────────────────────────────
// POST /api/clients/:id/trial
router.post('/:id/trial', auth, async (req, res, next) => {
  const tx = await pool.connect();
  try {
    const d = req.body;
    if (!d.trial_date) return res.status(400).json({ error: 'trial_date is required' });

    await tx.query('BEGIN');
    const { rows } = await tx.query('SELECT * FROM clients WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!rows[0]) { await tx.query('ROLLBACK'); return res.status(404).json({ error: 'Client not found' }); }
    const c = rows[0];
    if (!(await assertCanActOnClient(req, res, tx, c))) return;

    await tx.query(
      `INSERT INTO trials (id,client_id,client_name,trainer_id,trainer_name,
         trial_date,time_slot,focus_area,notes,status)
       VALUES (gen_random_uuid()::TEXT,$1,$2,$3,$4,$5,$6,$7,$8,'scheduled')`,
      [c.id, c.name, d.trainer_id || c.trainer_id, c.trainer_name,
       d.trial_date, d.time_slot || null, d.focus_area || null, d.notes || null]
    );

    await logAction(tx, c.id, c.name, c.trainer_id, 'trial',
      {}, { trial_date: d.trial_date, time_slot: d.time_slot },
      0, null, d.notes, req.user?.name);

    await tx.query('COMMIT');
    res.json({ message: 'Trial session booked' });
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    // trials table might not exist yet
    if (err && typeof err.message === 'string' && err.message.includes('does not exist')) {
      return res.json({ message: 'Trial booked (sync pending)' });
    }
    next(err);
  } finally { tx.release(); }
});

// ── ASSIGN PT ────────────────────────────────────────────────────────────
// POST /api/clients/:id/assign-pt
router.post('/:id/assign-pt', auth, async (req, res, next) => {
  const tx = await pool.connect();
  try {
    const d = req.body;
    if (!d.trainer_id)     return res.status(400).json({ error: 'trainer_id is required' });
    if (!d.pt_start_date || !d.pt_end_date)
      return res.status(400).json({ error: 'pt_start_date and pt_end_date are required' });

    await tx.query('BEGIN');
    const { rows } = await tx.query('SELECT * FROM clients WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!rows[0]) { await tx.query('ROLLBACK'); return res.status(404).json({ error: 'Client not found' }); }
    const c = rows[0];
    if (!(await assertCanActOnClient(req, res, tx, c))) return;

    const { rows: tr } = await tx.query('SELECT name, incentive_rate FROM trainers WHERE id=$1', [d.trainer_id]);
    if (!tr[0]) { await tx.query('ROLLBACK'); return res.status(404).json({ error: 'Trainer not found' }); }

    const amount = num(d.amount, 0);
    await tx.query(
      `UPDATE clients SET trainer_id=$1, trainer_name=$2,
         pt_start_date=$3, pt_end_date=$4,
         package_type=COALESCE($5, package_type),
         pt_sessions_total=COALESCE($6, pt_sessions_total),
         final_amount=CASE WHEN $7>0 THEN $7 ELSE final_amount END,
         balance_amount=CASE WHEN $7>0 THEN GREATEST(0,$7-paid_amount) ELSE balance_amount END,
         status='active', updated_at=NOW()
       WHERE id=$8`,
      [d.trainer_id, tr[0].name, d.pt_start_date, d.pt_end_date,
       d.membership_plan || null, d.sessions ? parseInt(d.sessions) : null,
       amount, req.params.id]
    );

    if (amount > 0) {
      await tx.query(`INSERT INTO payments (id,client_id,client_name,trainer_id,trainer_name,
          amount,method,date,receipt_no,package_type,incentive_amt,notes)
        VALUES (gen_random_uuid()::TEXT,$1,$2,$3,$4,$5,$6,CURRENT_DATE,$7,$8,$9,$10)`,
        [c.id, c.name, d.trainer_id, tr[0].name, amount,
         d.payment_method || 'CASH', await genReceiptNo(tx),
         d.membership_plan || 'PT',
         Math.round(amount * (tr[0].incentive_rate ?? 0.5)),
         `PT Assignment — ${d.membership_plan || 'PT'}`]);
    }

    await logAction(tx, c.id, c.name, d.trainer_id, 'assign_pt',
      { trainer_id: c.trainer_id }, { trainer_id: d.trainer_id, trainer_name: tr[0].name, plan: d.membership_plan },
      amount, d.payment_method, null, req.user?.name);

    await tx.query('COMMIT');
    const { rows: fresh } = await pool.query('SELECT * FROM clients WHERE id=$1', [req.params.id]);
    res.json({ message: 'Personal Training assigned', client: fresh[0] });
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    next(err);
  } finally { tx.release(); }
});

// ── RENEW PT (alias for existing pt-renew) ───────────────────────────────
// POST /api/clients/:id/renew-pt
router.post('/:id/renew-pt', auth, async (req, res, next) => {
  req.url = `/${req.params.id}/pt-renew`;
  // delegate to clients router — inline implementation to avoid circular deps
  const tx = await pool.connect();
  try {
    const d = req.body;
    if (!d.pt_start_date || !d.pt_end_date)
      return res.status(400).json({ error: 'pt_start_date and pt_end_date are required' });

    await tx.query('BEGIN');
    const { rows } = await tx.query('SELECT * FROM clients WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!rows[0]) { await tx.query('ROLLBACK'); return res.status(404).json({ error: 'Client not found' }); }
    const c = rows[0];
    if (!(await assertCanActOnClient(req, res, tx, c))) return;

    const amount = num(d.amount, 0);
    const trainerId = d.trainer_id || c.trainer_id;

    await tx.query(
      `UPDATE clients SET
         package_type=COALESCE($1, package_type),
         trainer_id=COALESCE($2, trainer_id),
         pt_start_date=$3, pt_end_date=$4,
         final_amount=CASE WHEN $5>0 THEN $5 ELSE final_amount END,
         balance_amount=CASE WHEN $5>0 THEN GREATEST(0,$5-paid_amount) ELSE balance_amount END,
         status='active', updated_at=NOW()
       WHERE id=$6`,
      [d.membership_plan || d.package_type || null, trainerId,
       d.pt_start_date, d.pt_end_date, amount, req.params.id]
    );

    await tx.query(`INSERT INTO renewals (id,client_id,client_name,trainer_id,trainer_name,
        old_package,new_package,old_end_date,new_end_date,amount,paid_amount,payment_method,renewed_on,notes,action_type)
      VALUES (gen_random_uuid()::TEXT,$1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,CURRENT_DATE,$11,'renew_pt')`,
      [c.id, c.name, trainerId, c.trainer_name, c.package_type,
       d.membership_plan || d.package_type || 'PT',
       c.pt_end_date, d.pt_end_date, amount,
       d.payment_method || 'CASH', d.notes || null]);

    if (amount > 0) {
      let iRate = 0.5;
      if (trainerId) {
        const { rows: tr } = await tx.query('SELECT incentive_rate FROM trainers WHERE id=$1', [trainerId]);
        iRate = tr[0]?.incentive_rate ?? 0.5;
      }
      await tx.query(`INSERT INTO payments (id,client_id,client_name,trainer_id,trainer_name,
          amount,method,date,receipt_no,package_type,incentive_amt,notes)
        VALUES (gen_random_uuid()::TEXT,$1,$2,$3,$4,$5,$6,CURRENT_DATE,$7,$8,$9,$10)`,
        [c.id, c.name, trainerId, c.trainer_name, amount,
         d.payment_method || 'CASH', await genReceiptNo(tx),
         d.membership_plan || 'PT',
         Math.round(amount * iRate), 'PT Renewal']);
    }

    await tx.query('COMMIT');
    const { rows: fresh } = await pool.query('SELECT * FROM clients WHERE id=$1', [req.params.id]);
    res.json({ message: 'Personal Training renewed', client: fresh[0] });
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    next(err);
  } finally { tx.release(); }
});

// ── ADD SUBSCRIPTION ──────────────────────────────────────────────────────
// POST /api/clients/:id/add-subscription
router.post('/:id/add-subscription', auth, async (req, res, next) => {
  const tx = await pool.connect();
  try {
    const d = req.body;
    const planRows = Array.isArray(d.plan_rows) ? d.plan_rows : [];

    await tx.query('BEGIN');
    const { rows } = await tx.query('SELECT * FROM clients WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!rows[0]) { await tx.query('ROLLBACK'); return res.status(404).json({ error: 'Client not found' }); }
    const c = rows[0];
    if (!(await assertCanActOnClient(req, res, tx, c))) return;

    const totalAmount = planRows.reduce((s, r) => s + (parseFloat(r.sellingPrice) || 0), 0);
    const primaryRow  = planRows[0] || {};

    await tx.query(
      `UPDATE clients SET
         package_type=COALESCE($1, package_type),
         pt_start_date=COALESCE($2, pt_start_date),
         pt_end_date=COALESCE($3, pt_end_date),
         final_amount=CASE WHEN $4>0 THEN $4 ELSE final_amount END,
         balance_amount=CASE WHEN $4>0 THEN GREATEST(0,$4-paid_amount) ELSE balance_amount END,
         status='active', updated_at=NOW()
       WHERE id=$5`,
      [primaryRow.plan || null, primaryRow.startDate || null,
       primaryRow.endDate || null, totalAmount, req.params.id]
    );

    if (totalAmount > 0) {
      let iRate = 0.5;
      if (c.trainer_id) {
        const { rows: tr } = await tx.query('SELECT incentive_rate FROM trainers WHERE id=$1', [c.trainer_id]);
        iRate = tr[0]?.incentive_rate ?? 0.5;
      }
      await tx.query(`INSERT INTO payments (id,client_id,client_name,trainer_id,trainer_name,
          amount,method,date,receipt_no,package_type,incentive_amt,notes)
        VALUES (gen_random_uuid()::TEXT,$1,$2,$3,$4,$5,$6,CURRENT_DATE,$7,$8,$9,$10)`,
        [c.id, c.name, c.trainer_id, c.trainer_name, totalAmount,
         d.payment_method || 'CASH', await genReceiptNo(tx),
         primaryRow.plan || c.package_type,
         Math.round(totalAmount * iRate), 'Add Subscription']);
    }

    await logAction(tx, c.id, c.name, c.trainer_id, 'add_subscription',
      { package_type: c.package_type },
      { plan_rows: planRows, total: totalAmount },
      totalAmount, d.payment_method, null, req.user?.name);

    await tx.query('COMMIT');
    const { rows: fresh } = await pool.query('SELECT * FROM clients WHERE id=$1', [req.params.id]);
    res.json({ message: 'Subscription added', client: fresh[0] });
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    next(err);
  } finally { tx.release(); }
});

// ── RENEW SUBSCRIPTION ───────────────────────────────────────────────────
// POST /api/clients/:id/renew-subscription
// (mirrors /renew but uses the new route name the frontend calls)
router.post('/:id/renew-subscription', auth, async (req, res, next) => {
  const tx = await pool.connect();
  try {
    const d = req.body;
    const planRows = Array.isArray(d.plan_rows) ? d.plan_rows : [];
    const primaryRow = planRows[0] || {};

    const pkg = d.renew_plan || primaryRow.plan || d.package_type;
    if (!pkg) return res.status(400).json({ error: 'Plan is required' });

    await tx.query('BEGIN');
    const { rows } = await tx.query('SELECT * FROM clients WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!rows[0]) { await tx.query('ROLLBACK'); return res.status(404).json({ error: 'Client not found' }); }
    const c = rows[0];
    if (!(await assertCanActOnClient(req, res, tx, c))) return;

    const totalAmount = planRows.length > 0
      ? planRows.reduce((s, r) => s + (parseFloat(r.sellingPrice) || 0), 0)
      : num(d.amount, 0);

    await tx.query(
      `UPDATE clients SET
         package_type=$1,
         pt_start_date=COALESCE($2, pt_start_date),
         pt_end_date=COALESCE($3, pt_end_date),
         final_amount=CASE WHEN $4>0 THEN $4 ELSE final_amount END,
         balance_amount=CASE WHEN $4>0 THEN GREATEST(0,$4-paid_amount) ELSE balance_amount END,
         status='active', updated_at=NOW()
       WHERE id=$5`,
      [pkg, primaryRow.startDate || d.pt_start_date || null,
       primaryRow.endDate || d.pt_end_date || null, totalAmount, req.params.id]
    );

    await tx.query(`INSERT INTO renewals (id,client_id,client_name,trainer_id,trainer_name,
        old_package,new_package,old_end_date,new_end_date,amount,paid_amount,payment_method,renewed_on,notes,action_type)
      VALUES (gen_random_uuid()::TEXT,$1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,CURRENT_DATE,$11,'renew_subscription')`,
      [c.id, c.name, c.trainer_id, c.trainer_name, c.package_type, pkg,
       c.pt_end_date, primaryRow.endDate || d.pt_end_date || c.pt_end_date,
       totalAmount, d.payment_method || 'CASH', d.notes || null]);

    if (totalAmount > 0) {
      let iRate = 0.5;
      if (c.trainer_id) {
        const { rows: tr } = await tx.query('SELECT incentive_rate FROM trainers WHERE id=$1', [c.trainer_id]);
        iRate = tr[0]?.incentive_rate ?? 0.5;
      }
      await tx.query(`INSERT INTO payments (id,client_id,client_name,trainer_id,trainer_name,
          amount,method,date,receipt_no,package_type,incentive_amt,notes)
        VALUES (gen_random_uuid()::TEXT,$1,$2,$3,$4,$5,$6,CURRENT_DATE,$7,$8,$9,$10)`,
        [c.id, c.name, c.trainer_id, c.trainer_name, totalAmount,
         d.payment_method || 'CASH', await genReceiptNo(tx), pkg,
         Math.round(totalAmount * iRate), `Renewal — ${pkg}`]);
    }

    await tx.query('COMMIT');
    const { rows: fresh } = await pool.query('SELECT * FROM clients WHERE id=$1', [req.params.id]);
    res.json({ message: `Subscription renewed — ${pkg}`, client: fresh[0] });
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    next(err);
  } finally { tx.release(); }
});

module.exports = router;

// POST /api/clients/:id/unfreeze
router.post('/:id/unfreeze', auth, async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { rows } = await pool.query('SELECT * FROM clients WHERE id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Client not found' });
    const c = rows[0];

    const tx = pool;
    await tx.query(
      `UPDATE clients
         SET status='active', is_frozen=FALSE,
             freeze_from=NULL, freeze_until=NULL, freeze_reason=NULL,
             updated_at=NOW()
       WHERE id=$1`,
      [c.id]
    );
    await logAction(tx, c.id, c.name, c.trainer_id, 'unfreeze',
      { status: c.status, is_frozen: c.is_frozen },
      { status: 'active', is_frozen: false },
      0, null, req.body?.notes || null, req.user?.name
    );
    const { rows: updated } = await pool.query('SELECT * FROM clients WHERE id=$1', [c.id]);
    res.json({ message: 'Membership unfrozen successfully', client: updated[0] });
  } catch (err) { next(err); }
});

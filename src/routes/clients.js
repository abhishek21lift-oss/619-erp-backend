// src/routes/clients.js
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const pool   = require('../db/pool');
const { auth, adminOnly } = require('../middleware/auth');

// Helper: parse a value as a finite number, or return fallback.
// parseFloat('') is NaN — `??` does NOT catch that. Use this guard instead.
function num(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

// Track last auto-expire run so we don't fire the UPDATE on every list call.
let lastExpireRun = 0;
async function maybeAutoExpire() {
  const now = Date.now();
  // Run at most once per hour
  if (now - lastExpireRun < 60 * 60 * 1000) return;
  lastExpireRun = now;
  try {
    await pool.query(
      `UPDATE clients SET status='expired', updated_at=NOW()
       WHERE status='active' AND pt_end_date < CURRENT_DATE`
    );
  } catch (err) {
    console.error('Auto-expire error:', err.message);
  }
}

// GET /api/clients
router.get('/', auth, async (req, res) => {
  try {
    const { search, status, trainer_id, dues, limit = 500, offset = 0 } = req.query;
    const conditions = [];
    const params = [];
    let p = 1;

    // Scope trainer to own clients only
    if (req.user.role === 'trainer' && req.user.trainer_id) {
      conditions.push(`c.trainer_id = $${p++}`);
      params.push(req.user.trainer_id);
    } else if (trainer_id) {
      conditions.push(`c.trainer_id = $${p++}`);
      params.push(trainer_id);
    }

    if (search) {
      conditions.push(`(LOWER(c.name) LIKE $${p} OR c.mobile LIKE $${p} OR c.client_id LIKE $${p} OR LOWER(c.email) LIKE $${p})`);
      params.push(`%${search.toLowerCase()}%`);
      p++;
    }

    if (status === 'expiring') {
      conditions.push(`c.status = 'active' AND c.pt_end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'`);
    } else if (status === 'dues') {
      conditions.push(`c.balance_amount > 0`);
    } else if (status) {
      conditions.push(`c.status = $${p++}`);
      params.push(status);
    }

    if (dues === 'yes') conditions.push('c.balance_amount > 0');

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    // Auto-expire is rate-limited to once an hour, off the hot read path
    maybeAutoExpire();

    const { rows } = await pool.query(
      `SELECT c.*, t.name as computed_trainer_name
       FROM clients c
       LEFT JOIN trainers t ON t.id = c.trainer_id
       ${where}
       ORDER BY c.created_at DESC
       LIMIT $${p++} OFFSET $${p++}`,
      [...params, parseInt(limit), parseInt(offset)]
    );
    res.json(rows);
  } catch (err) {
    console.error('Get clients error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/clients/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*, t.name as trainer_full_name, t.mobile as trainer_mobile
       FROM clients c LEFT JOIN trainers t ON t.id = c.trainer_id
       WHERE c.id = $1`, [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Client not found' });

    if (req.user.role === 'trainer' && rows[0].trainer_id !== req.user.trainer_id)
      return res.status(403).json({ error: 'Access denied' });

    // Also fetch payment history for this client
    const { rows: payments } = await pool.query(
      'SELECT * FROM payments WHERE client_id=$1 ORDER BY date DESC LIMIT 20', [req.params.id]
    );
    const { rows: weightLogs } = await pool.query(
      'SELECT * FROM weight_logs WHERE client_id=$1 ORDER BY date DESC LIMIT 10', [req.params.id]
    );

    res.json({ ...rows[0], payments, weight_logs: weightLogs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/clients
router.post('/', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const d = req.body;
    if (!d.name?.trim()) return res.status(400).json({ error: 'Client name is required' });

    await client.query('BEGIN');

    // Generate next sequential client ID inside the transaction
    const { rows: last } = await client.query(
      `SELECT client_id FROM clients ORDER BY client_id DESC LIMIT 1 FOR UPDATE`
    );
    let clientId = 'FS0001';
    if (last[0]?.client_id) {
      const n = parseInt((last[0].client_id || 'FS0000').replace('FS', '')) + 1;
      clientId = 'FS' + String(n).padStart(4, '0');
    }

    const id = uuid();
    const base    = num(d.base_amount,  0);
    const disc    = num(d.discount,     0);
    const final   = num(d.final_amount, base - disc);
    const paid    = num(d.paid_amount,  0);
    const balance = final - paid;

    // If trainer is adding, force their trainer_id
    const trainer_id = req.user.role === 'trainer' ? req.user.trainer_id : (d.trainer_id || null);

    // Get trainer name + incentive_rate in a single query
    let trainer_name = d.trainer_name || null;
    let incentiveRate = 0.5;
    if (trainer_id) {
      const { rows: tr } = await client.query(
        'SELECT name, incentive_rate FROM trainers WHERE id=$1', [trainer_id]
      );
      if (tr[0]) {
        if (!trainer_name) trainer_name = tr[0].name || null;
        incentiveRate = tr[0].incentive_rate ?? 0.5;
      }
    }

    await client.query(`
      INSERT INTO clients (
        id, client_id, name, mobile, email, gender, dob, address,
        trainer_id, trainer_name, joining_date, pt_start_date, pt_end_date,
        package_type, base_amount, discount, final_amount, paid_amount, balance_amount,
        payment_method, payment_date, weight, notes, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [id, clientId, d.name.trim(), d.mobile||null, d.email?.toLowerCase()||null,
       d.gender||null, d.dob||null, d.address||null,
       trainer_id, trainer_name,
       d.joining_date||null, d.pt_start_date||null, d.pt_end_date||null,
       d.package_type||null, base, disc, final, paid, balance,
       d.payment_method||'CASH', d.payment_date||null,
       num(d.weight, null), d.notes||null, d.status||'active']
    );

    // If paid > 0, auto-create a payment record (in same transaction)
    if (paid > 0) {
      const receiptNo = `RCP-${Date.now()}`;
      await client.query(`
        INSERT INTO payments (id, client_id, client_name, trainer_id, trainer_name,
          amount, method, date, receipt_no, package_type, incentive_amt)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [uuid(), id, d.name.trim(), trainer_id, trainer_name, paid,
         d.payment_method||'CASH', d.payment_date||new Date().toISOString().split('T')[0],
         receiptNo, d.package_type||null, Math.round(paid * incentiveRate)]
      );
    }

    await client.query('COMMIT');

    const { rows } = await pool.query('SELECT * FROM clients WHERE id=$1', [id]);
    res.status(201).json({ message: 'Client created', client: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Create client error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PUT /api/clients/:id
router.put('/:id', auth, async (req, res) => {
  try {
    const d = req.body;
    const { rows: existing } = await pool.query('SELECT * FROM clients WHERE id=$1', [req.params.id]);
    if (!existing[0]) return res.status(404).json({ error: 'Client not found' });
    if (req.user.role === 'trainer' && existing[0].trainer_id !== req.user.trainer_id)
      return res.status(403).json({ error: 'Access denied' });

    const base    = num(d.base_amount,   existing[0].base_amount);
    const disc    = num(d.discount,      existing[0].discount);
    const final   = num(d.final_amount,  existing[0].final_amount);
    const paid    = num(d.paid_amount,   existing[0].paid_amount);

    // Trainers cannot reassign clients to a different trainer
    const trainer_id = req.user.role === 'trainer'
      ? req.user.trainer_id
      : (d.trainer_id || existing[0].trainer_id || null);

    // Resolve trainer_name from supplied id when admin changes it
    let trainer_name = d.trainer_name || existing[0].trainer_name || null;
    if (req.user.role !== 'trainer' && d.trainer_id && d.trainer_id !== existing[0].trainer_id) {
      const { rows: tr } = await pool.query('SELECT name FROM trainers WHERE id=$1', [d.trainer_id]);
      trainer_name = tr[0]?.name || null;
    }

    await pool.query(`
      UPDATE clients SET
        name=$1, mobile=$2, email=$3, gender=$4, dob=$5, address=$6,
        trainer_id=$7, trainer_name=$8, pt_start_date=$9, pt_end_date=$10,
        package_type=$11, base_amount=$12, discount=$13, final_amount=$14,
        paid_amount=$15, balance_amount=$16, payment_method=$17, payment_date=$18,
        weight=$19, notes=$20, status=$21, updated_at=NOW()
      WHERE id=$22`,
      [d.name?.trim()||existing[0].name,
       d.mobile||null, d.email?.toLowerCase()||null,
       d.gender||null, d.dob||null, d.address||null,
       trainer_id, trainer_name,
       d.pt_start_date||null, d.pt_end_date||null,
       d.package_type||null, base, disc, final, paid, final-paid,
       d.payment_method||'CASH', d.payment_date||null,
       num(d.weight, null), d.notes||null,
       d.status||existing[0].status,
       req.params.id]
    );
    const { rows } = await pool.query('SELECT * FROM clients WHERE id=$1', [req.params.id]);
    res.json({ message: 'Updated', client: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/clients/:id (admin only)
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM clients WHERE id=$1 RETURNING id', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Client not found' });
    res.json({ message: 'Client deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// src/routes/payments.js
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const pool = require('../db/pool');
const { auth, adminOnly } = require('../middleware/auth');

// GET /api/payments
router.get('/', auth, async (req, res) => {
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

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const { rows } = await pool.query(`
      SELECT p.*, c.name AS client_name, t.name AS trainer_name_full
      FROM payments p
      LEFT JOIN clients  c ON c.id = p.client_id
      LEFT JOIN trainers t ON t.id = p.trainer_id
      ${where}
      ORDER BY p.date DESC, p.created_at DESC
      LIMIT $${p++} OFFSET $${p++}`,
      [...params, parseInt(limit), parseInt(offset)]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payments
router.post('/', auth, async (req, res) => {
  try {
    const d = req.body;
    if (!d.client_id || !d.amount || !d.date)
      return res.status(400).json({ error: 'client_id, amount and date required' });

    const amount = parseFloat(d.amount);
    if (isNaN(amount) || amount <= 0)
      return res.status(400).json({ error: 'Amount must be a positive number' });

    // Get client info
    const { rows: cl } = await pool.query('SELECT * FROM clients WHERE id=$1', [d.client_id]);
    if (!cl[0]) return res.status(404).json({ error: 'Client not found' });

    // Get trainer incentive rate
    let incentiveRate = 0.5;
    if (cl[0].trainer_id) {
      const { rows: tr } = await pool.query('SELECT incentive_rate FROM trainers WHERE id=$1', [cl[0].trainer_id]);
      incentiveRate = parseFloat(tr[0]?.incentive_rate || 0.5);
    }

    const id = uuid();
    const receiptNo = `RCP-${new Date().toISOString().split('T')[0].replace(/-/g,'')}-${Math.floor(1000+Math.random()*9000)}`;

    await pool.query(`
      INSERT INTO payments (id,client_id,client_name,trainer_id,trainer_name,
        amount,method,date,receipt_no,package_type,incentive_amt,notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, d.client_id, cl[0].name,
       cl[0].trainer_id, cl[0].trainer_name,
       amount, d.method||'CASH', d.date, receiptNo,
       cl[0].package_type, Math.round(amount * incentiveRate),
       d.notes||null]
    );

    // Update client balance
    await pool.query(`
      UPDATE clients
      SET paid_amount = paid_amount + $1,
          balance_amount = GREATEST(0, balance_amount - $1),
          updated_at = NOW()
      WHERE id = $2`, [amount, d.client_id]
    );

    const { rows } = await pool.query('SELECT * FROM payments WHERE id=$1', [id]);
    res.status(201).json({ message: 'Payment recorded', payment: rows[0] });
  } catch (err) {
    console.error('Payment error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/payments/:id (admin only)
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM payments WHERE id=$1 RETURNING *', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    // Reverse the balance change
    await pool.query(`
      UPDATE clients
      SET paid_amount = GREATEST(0, paid_amount - $1),
          balance_amount = balance_amount + $1,
          updated_at = NOW()
      WHERE id = $2`, [rows[0].amount, rows[0].client_id]
    );
    res.json({ message: 'Payment deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

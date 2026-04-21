// src/routes/trainers.js
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const pool = require('../db/pool');
const { auth, adminOnly } = require('../middleware/auth');

// GET /api/trainers
router.get('/', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT t.*,
        COUNT(c.id) FILTER (WHERE c.status='active')  AS active_clients,
        COUNT(c.id)                                    AS total_clients,
        COALESCE(SUM(p.amount) FILTER (WHERE p.date >= DATE_TRUNC('month',NOW())),0) AS month_revenue,
        COALESCE(SUM(p.amount),0) AS all_time_revenue
      FROM trainers t
      LEFT JOIN clients  c ON c.trainer_id = t.id
      LEFT JOIN payments p ON p.trainer_id = t.id
      GROUP BY t.id
      ORDER BY t.name`);

    const withIncentive = rows.map(t => ({
      ...t,
      active_clients:  parseInt(t.active_clients),
      total_clients:   parseInt(t.total_clients),
      month_revenue:   parseFloat(t.month_revenue),
      all_time_revenue:parseFloat(t.all_time_revenue),
      month_incentive: Math.round(parseFloat(t.month_revenue) * parseFloat(t.incentive_rate||0.5))
    }));
    res.json(withIncentive);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/trainers/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM trainers WHERE id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Trainer not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/trainers (admin only)
router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const d = req.body;
    if (!d.name?.trim()) return res.status(400).json({ error: 'Name required' });
    const id = uuid();
    const rate = (parseFloat(d.incentive_rate) || 50) / 100; // convert % to decimal

    await pool.query(`
      INSERT INTO trainers (id,name,mobile,email,dob,gender,address,role,
        joining_date,salary,incentive_rate,specialization,certifications,status,notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [id, d.name.trim(), d.mobile||null, d.email?.toLowerCase()||null,
       d.dob||null, d.gender||null, d.address||null,
       d.role||'Personal Trainer', d.joining_date||null,
       parseFloat(d.salary)||0, rate,
       d.specialization||null, d.certifications||null,
       d.status||'active', d.notes||null]
    );
    const { rows } = await pool.query('SELECT * FROM trainers WHERE id=$1', [id]);
    res.status(201).json({ message: 'Trainer created', trainer: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/trainers/:id (admin only)
router.put('/:id', auth, adminOnly, async (req, res) => {
  try {
    const d = req.body;
    const rate = d.incentive_rate ? (parseFloat(d.incentive_rate)/100) : undefined;

    const { rows: ex } = await pool.query('SELECT * FROM trainers WHERE id=$1', [req.params.id]);
    if (!ex[0]) return res.status(404).json({ error: 'Not found' });

    await pool.query(`
      UPDATE trainers SET
        name=$1,mobile=$2,email=$3,dob=$4,gender=$5,address=$6,role=$7,
        joining_date=$8,salary=$9,incentive_rate=$10,specialization=$11,
        certifications=$12,status=$13,notes=$14,updated_at=NOW()
      WHERE id=$15`,
      [d.name?.trim()||ex[0].name, d.mobile||null, d.email?.toLowerCase()||null,
       d.dob||null, d.gender||null, d.address||null,
       d.role||ex[0].role, d.joining_date||null,
       parseFloat(d.salary)||0, rate??ex[0].incentive_rate,
       d.specialization||null, d.certifications||null,
       d.status||ex[0].status, d.notes||null, req.params.id]
    );
    const { rows } = await pool.query('SELECT * FROM trainers WHERE id=$1', [req.params.id]);
    res.json({ message: 'Updated', trainer: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/trainers/:id (admin only)
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM trainers WHERE id=$1 RETURNING id', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

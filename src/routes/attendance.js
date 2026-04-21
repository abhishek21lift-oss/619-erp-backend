// src/routes/attendance.js
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');

// GET /api/attendance?date=YYYY-MM-DD&type=client
router.get('/', auth, async (req, res) => {
  try {
    const { date, type = 'client', ref_id } = req.query;
    const conditions = ['1=1'];
    const params = [];
    let p = 1;

    if (req.user.role === 'trainer' && req.user.trainer_id) {
      conditions.push(`a.trainer_id = $${p++}`);
      params.push(req.user.trainer_id);
    }
    if (date)   { conditions.push(`a.date = $${p++}`);   params.push(date); }
    if (type)   { conditions.push(`a.type = $${p++}`);   params.push(type); }
    if (ref_id) { conditions.push(`a.ref_id = $${p++}`); params.push(ref_id); }

    const { rows } = await pool.query(
      `SELECT a.* FROM attendance a WHERE ${conditions.join(' AND ')} ORDER BY a.date DESC, a.check_in DESC LIMIT 200`,
      params
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/attendance — mark attendance
router.post('/', auth, async (req, res) => {
  try {
    const d = req.body;
    if (!d.ref_id || !d.date || !d.type)
      return res.status(400).json({ error: 'ref_id, date, type required' });

    const id = uuid();
    await pool.query(`
      INSERT INTO attendance (id,type,ref_id,ref_name,trainer_id,trainer_name,date,check_in,check_out,status,notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (type,ref_id,date) DO UPDATE
        SET status=$10, check_in=$8, check_out=$9, notes=$11, updated_at=NOW()`,
      [id, d.type, d.ref_id, d.ref_name||null,
       d.trainer_id||req.user.trainer_id||null,
       d.trainer_name||null, d.date,
       d.check_in||null, d.check_out||null,
       d.status||'present', d.notes||null]
    );
    res.status(201).json({ message: 'Attendance marked' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/attendance/today-summary
router.get('/today-summary', auth, async (req, res) => {
  try {
    const trainerFilter = req.user.role === 'trainer' && req.user.trainer_id
      ? `AND a.trainer_id = '${req.user.trainer_id}'` : '';

    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE a.status='present') AS present,
        COUNT(*) FILTER (WHERE a.status='absent')  AS absent,
        COUNT(*) FILTER (WHERE a.status='late')    AS late,
        COUNT(*)                                    AS total
      FROM attendance a
      WHERE a.date = CURRENT_DATE AND a.type = 'client' ${trainerFilter}`
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

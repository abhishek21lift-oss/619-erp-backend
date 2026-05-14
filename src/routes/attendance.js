// src/routes/attendance.js
// Matches the actual Supabase 619-erp database schema:
//   attendance(id, type, ref_id, ref_name, trainer_id, trainer_name,
//              date, check_in TIME, check_out TIME, status, notes,
//              created_at, updated_at, branch_id, member_id, booking_id,
//              pt_session_id, check_in_method, device_id)
// Unique constraint: (type, ref_id, date)

const router = require('express').Router();
const { v4: uuid } = require('uuid');
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');

// GET /api/attendance?date=YYYY-MM-DD&type=client
router.get('/', auth, async (req, res, next) => {
  try {
    const { date, from, to, type = 'client', ref_id } = req.query;
    const conditions = ['1=1'];
    const params = [];
    let p = 1;

    if (req.user.role === 'trainer' && req.user.trainer_id) {
      conditions.push(`a.trainer_id = $${p++}`);
      params.push(req.user.trainer_id);
    }
    if (date)   { conditions.push(`a.date = $${p++}`);   params.push(date); }
    if (from)   { conditions.push(`a.date >= $${p++}`);  params.push(from); }
    if (to)     { conditions.push(`a.date <= $${p++}`);  params.push(to); }
    if (type)   { conditions.push(`a.type = $${p++}`);   params.push(type); }
    if (ref_id) { conditions.push(`a.ref_id = $${p++}`); params.push(ref_id); }

    const limit = (from || to) ? 5000 : 200;

    const { rows } = await pool.query(
      `SELECT a.* FROM attendance a
       WHERE ${conditions.join(' AND ')}
       ORDER BY a.date DESC, a.check_in DESC NULLS LAST
       LIMIT ${limit}`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/attendance — mark attendance
router.post('/', auth, async (req, res, next) => {
  try {
    const d = req.body;
    if (!d.ref_id || !d.date)
      return res.status(400).json({ error: 'ref_id and date required' });

    const type = d.type || 'client';

    // RBAC: trainers can only mark attendance for their own clients
    if (req.user.role === 'trainer') {
      if (type === 'client') {
        const { rows: own } = await pool.query(
          'SELECT trainer_id FROM clients WHERE id=$1', [d.ref_id]
        );
        if (!own[0]) return res.status(404).json({ error: 'Client not found' });
        if (own[0].trainer_id !== req.user.trainer_id)
          return res.status(403).json({ error: 'Access denied: client is not assigned to you' });
      } else if (type === 'trainer') {
        if (d.ref_id !== req.user.trainer_id)
          return res.status(403).json({ error: 'Access denied' });
      }
      d.trainer_id = req.user.trainer_id;
    }

    const id = uuid();
    await pool.query(`
      INSERT INTO attendance
        (id, type, ref_id, ref_name, trainer_id, trainer_name, date,
         check_in, check_out, status, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (type, ref_id, date) DO UPDATE
        SET status=$10,
            check_in=COALESCE(attendance.check_in, $8),
            check_out=$9,
            notes=$11,
            updated_at=NOW()`,
      [id, type, d.ref_id, d.ref_name || null,
       d.trainer_id || req.user.trainer_id || null,
       d.trainer_name || null, d.date,
       d.check_in || null, d.check_out || null,
       d.status || 'present', d.notes || null]
    );
    res.status(201).json({ message: 'Attendance marked' });
  } catch (err) {
    next(err);
  }
});

// POST /api/attendance/biometric
router.post('/biometric', auth, async (req, res, next) => {
  try {
    const code = String(req.body?.biometric_code || '').trim();
    const requestedType = req.body?.type;
    if (!code) return res.status(400).json({ error: 'biometric_code required' });
    if (requestedType && !['client', 'trainer'].includes(requestedType)) {
      return res.status(400).json({ error: 'type must be client or trainer' });
    }

    const lookups = requestedType ? [requestedType] : ['client', 'trainer'];
    let person = null;
    let type = null;

    for (const t of lookups) {
      if (t === 'client') {
        const { rows } = await pool.query(
          `SELECT id, name, client_id, trainer_id, trainer_name
             FROM clients
            WHERE biometric_code = $1 OR client_id = $1 OR member_code = $1
            LIMIT 1`, [code]
        );
        if (rows[0]) { person = rows[0]; type = 'client'; break; }
      } else {
        const { rows } = await pool.query(
          `SELECT id, name, biometric_code FROM trainers WHERE biometric_code = $1 LIMIT 1`,
          [code]
        );
        if (rows[0]) { person = rows[0]; type = 'trainer'; break; }
      }
    }

    if (!person || !type) return res.status(404).json({ error: 'Biometric code not found' });

    if (req.user.role === 'trainer') {
      if (type === 'client' && person.trainer_id !== req.user.trainer_id)
        return res.status(403).json({ error: 'Access denied: member is not assigned to you' });
      if (type === 'trainer' && person.id !== req.user.trainer_id)
        return res.status(403).json({ error: 'Access denied' });
    }

    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const checkIn = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const id = uuid();
    const trainerId = type === 'trainer' ? person.id : (person.trainer_id || null);
    const trainerName = type === 'trainer' ? person.name : (person.trainer_name || null);

    await pool.query(`
      INSERT INTO attendance
        (id, type, ref_id, ref_name, trainer_id, trainer_name, date, check_in, status, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'present','biometric')
      ON CONFLICT (type, ref_id, date) DO UPDATE
        SET status='present',
            check_in=COALESCE(attendance.check_in, $8),
            notes='biometric',
            updated_at=NOW()`,
      [id, type, person.id, person.name, trainerId, trainerName, date, checkIn]
    );

    const { rows } = await pool.query(
      'SELECT * FROM attendance WHERE type=$1 AND ref_id=$2 AND date=$3',
      [type, person.id, date]
    );
    res.status(201).json({
      message: `${person.name} checked in by biometric`,
      attendance: rows[0],
      person: { id: person.id, name: person.name, type },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/attendance/today-summary
router.get('/today-summary', auth, async (req, res, next) => {
  try {
    const params = [];
    let trainerFilter = '';
    if (req.user.role === 'trainer' && req.user.trainer_id) {
      params.push(req.user.trainer_id);
      trainerFilter = `AND a.trainer_id = $${params.length}`;
    }

    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE a.status='present') AS present,
        COUNT(*) FILTER (WHERE a.status='absent')  AS absent,
        COUNT(*) FILTER (WHERE a.status='late')    AS late,
        COUNT(*)                                    AS total
      FROM attendance a
      WHERE a.date = CURRENT_DATE AND a.type = 'client' ${trainerFilter}`,
      params
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

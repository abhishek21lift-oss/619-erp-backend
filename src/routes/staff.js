// src/routes/staff.js
const express = require('express');
const router  = express.Router();
const { authenticate, requireRole } = require('../middleware/auth');
const db = require('../db');

// All staff routes require a valid JWT
router.use(authenticate);

// ─────────────────────────────────────────────
// STAFF TABLE
//   Assumes a `staff` table with columns:
//   id, name, email, phone, role, status, created_at
// ─────────────────────────────────────────────

// GET /api/staff  — list all staff (optional ?role= filter)
router.get('/', async (req, res, next) => {
  try {
    const { role, status, search } = req.query;
    let query = 'SELECT * FROM staff WHERE 1=1';
    const params = [];

    if (role) {
      params.push(role);
      query += ` AND role = $${params.length}`;
    }
    if (status) {
      params.push(status);
      query += ` AND status = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (name ILIKE $${params.length} OR email ILIKE $${params.length} OR phone ILIKE $${params.length})`;
    }

    query += ' ORDER BY created_at DESC';
    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/staff/:id
router.get('/:id', async (req, res, next) => {
  try {
    const result = await db.query('SELECT * FROM staff WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Staff member not found' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/staff
router.post('/', async (req, res, next) => {
  try {
    const { name, email, phone, role, status = 'active' } = req.body;
    if (!name || !role) return res.status(400).json({ error: 'name and role are required' });

    const result = await db.query(
      `INSERT INTO staff (name, email, phone, role, status, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING *`,
      [name, email || null, phone || null, role, status]
    );
    res.status(201).json({ message: 'Staff member created', staff: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PUT /api/staff/:id
router.put('/:id', async (req, res, next) => {
  try {
    const { name, email, phone, role, status } = req.body;

    const existing = await db.query('SELECT * FROM staff WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Staff member not found' });
    const cur = existing.rows[0];

    const result = await db.query(
      `UPDATE staff
       SET name=$1, email=$2, phone=$3, role=$4, status=$5
       WHERE id=$6
       RETURNING *`,
      [
        name   ?? cur.name,
        email  ?? cur.email,
        phone  ?? cur.phone,
        role   ?? cur.role,
        status ?? cur.status,
        req.params.id,
      ]
    );
    res.json({ message: 'Staff member updated', staff: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/staff/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM staff WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Staff member not found' });
    res.json({ message: 'Staff member deleted' });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────
// STAFF TARGETS
//   Assumes a `staff_targets` table with columns:
//   id, staff_id, staff_name, role, month,
//   target_revenue, target_clients, target_sessions,
//   achieved_revenue, achieved_clients, achieved_sessions
// ─────────────────────────────────────────────

// GET /api/staff/targets  — list targets (optional ?month=YYYY-MM)
router.get('/targets', async (req, res, next) => {
  try {
    const { month } = req.query;
    let query = `
      SELECT st.*, s.name AS staff_name, s.role
      FROM staff_targets st
      LEFT JOIN staff s ON s.id = st.staff_id
      WHERE 1=1`;
    const params = [];

    if (month) {
      params.push(month);
      query += ` AND st.month = $${params.length}`;
    }
    query += ' ORDER BY st.month DESC, s.name';
    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/staff/targets
router.post('/targets', async (req, res, next) => {
  try {
    const {
      staff_id, month,
      target_revenue = 0, target_clients = 0, target_sessions = 0,
      achieved_revenue = 0, achieved_clients = 0, achieved_sessions = 0,
    } = req.body;
    if (!staff_id || !month) return res.status(400).json({ error: 'staff_id and month are required' });

    const result = await db.query(
      `INSERT INTO staff_targets
         (staff_id, month, target_revenue, target_clients, target_sessions,
          achieved_revenue, achieved_clients, achieved_sessions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [staff_id, month, target_revenue, target_clients, target_sessions,
       achieved_revenue, achieved_clients, achieved_sessions]
    );
    res.status(201).json({ message: 'Target created', target: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PUT /api/staff/targets/:id
router.put('/targets/:id', async (req, res, next) => {
  try {
    const fields = [
      'target_revenue','target_clients','target_sessions',
      'achieved_revenue','achieved_clients','achieved_sessions','month',
    ];
    const updates = [];
    const params  = [];

    fields.forEach((f) => {
      if (req.body[f] !== undefined) {
        params.push(req.body[f]);
        updates.push(`${f} = $${params.length}`);
      }
    });
    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

    params.push(req.params.id);
    const result = await db.query(
      `UPDATE staff_targets SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Target not found' });
    res.json({ message: 'Target updated', target: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/staff/targets/:id
router.delete('/targets/:id', async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM staff_targets WHERE id=$1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Target not found' });
    res.json({ message: 'Target deleted' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

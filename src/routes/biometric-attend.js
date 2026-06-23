'use strict';
// biometric-attend.js
// All check-ins now write to the canonical attendance_logs table so that
// every report, dashboard, and history page sees a single unified dataset.
// The biometric_attendance table is kept for historical data only.

const express = require('express');
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');
const { randomUUID } = require('crypto');

const router = express.Router();
router.use(auth);

async function getLateHour() {
  const { rows } = await pool.query("SELECT value FROM system_settings WHERE key = 'late_threshold_hour' LIMIT 1");
  return rows[0] ? parseInt(rows[0].value) : 10;
}

function verificationMethodToLogMethod(vm) {
  if (!vm) return 'passkey';
  const v = vm.toLowerCase();
  if (v.includes('face')) return 'face_id';
  if (v.includes('touch') || v.includes('fingerprint')) return 'touch_id';
  if (v.includes('passkey')) return 'passkey';
  return 'biometric';
}

// POST /api/biometric-attend/mark
router.post('/mark', async (req, res, next) => {
  try {
    const { memberId, memberName, verificationMethod, deviceName, latitude, longitude } = req.body;
    if (!memberId || !verificationMethod) {
      return res.status(400).json({ success: false, error: 'memberId and verificationMethod are required' });
    }

    const today = new Date().toISOString().split('T')[0];
    const now   = new Date();
    const lateHour = await getLateHour();
    const isLate = now.getHours() >= lateHour;
    const status = isLate ? 'late' : 'present';
    const method = verificationMethodToLogMethod(verificationMethod);
    const location = (latitude != null && longitude != null) ? `${latitude},${longitude}` : null;

    // Resolve member name if not provided
    let resolvedName = memberName;
    if (!resolvedName) {
      const { rows } = await pool.query('SELECT name FROM clients WHERE id = $1', [memberId]);
      resolvedName = rows[0]?.name || 'Unknown';
    }

    const id = randomUUID();
    await pool.query(`
      INSERT INTO attendance_logs
        (id, ref_id, ref_type, ref_name, date, check_in_time, status, method, device_info, location)
      VALUES ($1, $2, 'client', $3, $4, NOW(), $5, $6, $7, $8)
      ON CONFLICT (ref_id, ref_type, date) DO NOTHING`,
      [id, memberId, resolvedName, today, status, method, deviceName || null, location]
    );

    // Check if a record now exists (might have been blocked by conflict = already checked in)
    const { rows: existing } = await pool.query(
      `SELECT id FROM attendance_logs WHERE ref_id = $1 AND ref_type = 'client' AND date = $2`,
      [memberId, today]
    );
    const attendanceId = existing[0]?.id;

    // Check if the insert was blocked (duplicate)
    if (attendanceId && attendanceId !== id) {
      return res.status(409).json({ success: false, error: 'Member already checked in today', attendanceId });
    }

    res.json({ success: true, attendanceId: attendanceId || id });
  } catch (err) {
    next(err);
  }
});

// POST /api/biometric-attend/checkout
router.post('/checkout', async (req, res, next) => {
  try {
    const { memberId } = req.body;
    if (!memberId) return res.status(400).json({ success: false, error: 'memberId is required' });

    const today = new Date().toISOString().split('T')[0];
    const { rows } = await pool.query(
      `SELECT id, check_in_time FROM attendance_logs
       WHERE ref_id = $1 AND ref_type = 'client' AND date = $2
         AND check_out_time IS NULL AND check_in_time IS NOT NULL
       ORDER BY check_in_time DESC LIMIT 1`,
      [memberId, today]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, error: 'No active check-in found for today' });
    }

    const { id, check_in_time } = rows[0];
    const durationMinutes = Math.round((Date.now() - new Date(check_in_time)) / 60000);

    await pool.query(
      `UPDATE attendance_logs
       SET check_out_time = NOW(), duration_minutes = $2
       WHERE id = $1`,
      [id, durationMinutes]
    );
    res.json({ success: true, sessionDurationMinutes: durationMinutes });
  } catch (err) {
    next(err);
  }
});

// GET /api/biometric-attend/today
// Returns today's biometric/passkey/face_id/touch_id check-ins from attendance_logs
router.get('/today', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         a.id, a.ref_id AS member_id,
         a.ref_name AS member_name,
         a.check_in_time  AS check_in_at,
         a.check_out_time AS check_out_at,
         a.method         AS verification_method,
         a.device_info    AS device_name,
         a.status
       FROM attendance_logs a
       WHERE a.date = CURRENT_DATE
         AND a.ref_type = 'client'
         AND a.method IN ('passkey', 'face_id', 'touch_id', 'fingerprint', 'biometric', 'face')
       ORDER BY a.check_in_time DESC
       LIMIT 200`
    );

    const present = rows.filter(r => r.check_out_at).length;
    const active  = rows.filter(r => !r.check_out_at).length;
    const late    = rows.filter(r => r.status === 'late').length;

    res.json({
      present,
      late,
      active,
      feed: rows.slice(0, 50).map(r => ({
        id: r.id,
        memberName: r.member_name || 'Unknown',
        checkInTime: r.check_in_at,
        verificationMethod: r.verification_method,
        deviceName: r.device_name || 'Unknown',
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/biometric-attend/history
router.get('/history', async (req, res, next) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 50);
    const from   = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to     = req.query.to   || new Date().toISOString().slice(0, 10);
    const offset = (page - 1) * limit;

    const { rows } = await pool.query(
      `SELECT
         a.id, a.ref_id AS member_id,
         a.ref_name AS member_name,
         a.check_in_time  AS check_in_at,
         a.check_out_time AS check_out_at,
         a.method         AS verification_method,
         a.device_info    AS device_name,
         a.duration_minutes AS session_duration_minutes,
         a.status
       FROM attendance_logs a
       WHERE a.date BETWEEN $1 AND $2
         AND a.ref_type = 'client'
         AND a.method IN ('passkey', 'face_id', 'touch_id', 'fingerprint', 'biometric', 'face')
       ORDER BY a.check_in_time DESC
       LIMIT $3 OFFSET $4`,
      [from, to, limit, offset]
    );

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) FROM attendance_logs
       WHERE date BETWEEN $1 AND $2
         AND ref_type = 'client'
         AND method IN ('passkey', 'face_id', 'touch_id', 'fingerprint', 'biometric', 'face')`,
      [from, to]
    );

    res.json({ records: rows, total: parseInt(countRows[0].count), page, limit });
  } catch (err) {
    next(err);
  }
});

// GET /api/biometric-attend/member/:memberId
router.get('/member/:memberId', async (req, res, next) => {
  try {
    const { memberId } = req.params;
    const limit = Math.min(100, parseInt(req.query.limit) || 30);
    const from  = req.query.from || new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);

    const { rows } = await pool.query(
      `SELECT
         id,
         check_in_time  AS check_in_at,
         check_out_time AS check_out_at,
         method         AS verification_method,
         device_info    AS device_name,
         duration_minutes AS session_duration_minutes,
         status
       FROM attendance_logs
       WHERE ref_id = $1 AND ref_type = 'client' AND date >= $2
         AND method IN ('passkey', 'face_id', 'touch_id', 'fingerprint', 'biometric', 'face')
       ORDER BY check_in_time DESC LIMIT $3`,
      [memberId, from, limit]
    );
    res.json({ records: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/biometric-attend/report
router.get('/report', async (req, res, next) => {
  try {
    const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to   = req.query.to   || new Date().toISOString().slice(0, 10);

    const { rows } = await pool.query(
      `SELECT
         a.ref_id     AS member_id,
         a.ref_name   AS member_name,
         COUNT(*)                          AS total_sessions,
         ROUND(AVG(a.duration_minutes))    AS avg_duration,
         MAX(a.check_in_time)              AS last_checkin
       FROM attendance_logs a
       WHERE a.date BETWEEN $1 AND $2
         AND a.ref_type = 'client'
         AND a.method IN ('passkey', 'face_id', 'touch_id', 'fingerprint', 'biometric', 'face')
       GROUP BY a.ref_id, a.ref_name
       ORDER BY total_sessions DESC`,
      [from, to]
    );
    res.json({ from, to, data: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

'use strict';
const express = require('express');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// POST /api/biometric-attend/mark
router.post('/mark', async (req, res, next) => {
  try {
    const { memberId, memberName, verificationMethod, deviceName, latitude, longitude } = req.body;
    if (!memberId || !verificationMethod) {
      return res.status(400).json({ success: false, error: 'memberId and verificationMethod are required' });
    }

    // Check for duplicate check-in today
    const existing = await pool.query(
      `SELECT id FROM biometric_attendance
       WHERE member_id = $1 AND check_out_at IS NULL
         AND check_in_at >= CURRENT_DATE`,
      [memberId]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, error: 'Member already checked in today', attendanceId: existing.rows[0].id });
    }

    const result = await pool.query(
      `INSERT INTO biometric_attendance
         (member_id, member_name, verification_method, device_name, latitude, longitude)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [memberId, memberName || null, verificationMethod, deviceName || null,
       latitude ?? null, longitude ?? null]
    );
    res.json({ success: true, attendanceId: result.rows[0].id });
  } catch (err) {
    next(err);
  }
});

// POST /api/biometric-attend/checkout
router.post('/checkout', async (req, res, next) => {
  try {
    const { memberId } = req.body;
    if (!memberId) return res.status(400).json({ success: false, error: 'memberId is required' });

    const open = await pool.query(
      `SELECT id, check_in_at FROM biometric_attendance
       WHERE member_id = $1 AND check_out_at IS NULL
         AND check_in_at >= CURRENT_DATE
       ORDER BY check_in_at DESC LIMIT 1`,
      [memberId]
    );
    if (open.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'No active check-in found for today' });
    }

    const { id, check_in_at } = open.rows[0];
    const now = new Date();
    const durationMinutes = Math.round((now - new Date(check_in_at)) / 60000);

    await pool.query(
      `UPDATE biometric_attendance
       SET check_out_at = NOW(), session_duration_minutes = $2
       WHERE id = $1`,
      [id, durationMinutes]
    );
    res.json({ success: true, sessionDurationMinutes: durationMinutes });
  } catch (err) {
    next(err);
  }
});

// GET /api/biometric-attend/today
router.get('/today', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT
         ba.id,
         ba.member_id,
         COALESCE(ba.member_name, c.name) AS member_name,
         ba.check_in_at,
         ba.check_out_at,
         ba.verification_method,
         ba.device_name
       FROM biometric_attendance ba
       LEFT JOIN clients c ON c.id = ba.member_id
       WHERE ba.check_in_at >= CURRENT_DATE
       ORDER BY ba.check_in_at DESC
       LIMIT 200`
    );

    const rows = result.rows;
    const present = rows.filter(r => r.check_out_at).length;
    const active  = rows.filter(r => !r.check_out_at).length;
    const lateThreshold = new Date();
    lateThreshold.setHours(9, 30, 0, 0);
    const late = rows.filter(r => new Date(r.check_in_at) > lateThreshold).length;

    res.json({
      present,
      absent: 0,
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
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const from  = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to    = req.query.to   || new Date().toISOString().slice(0, 10);
    const offset = (page - 1) * limit;

    const result = await pool.query(
      `SELECT
         ba.id, ba.member_id,
         COALESCE(ba.member_name, c.name) AS member_name,
         ba.check_in_at, ba.check_out_at,
         ba.verification_method, ba.device_name,
         ba.session_duration_minutes
       FROM biometric_attendance ba
       LEFT JOIN clients c ON c.id = ba.member_id
       WHERE ba.check_in_at::date BETWEEN $1 AND $2
       ORDER BY ba.check_in_at DESC
       LIMIT $3 OFFSET $4`,
      [from, to, limit, offset]
    );

    const total = await pool.query(
      `SELECT COUNT(*) FROM biometric_attendance
       WHERE check_in_at::date BETWEEN $1 AND $2`,
      [from, to]
    );

    res.json({ records: result.rows, total: parseInt(total.rows[0].count), page, limit });
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

    const result = await pool.query(
      `SELECT id, check_in_at, check_out_at, verification_method,
              device_name, session_duration_minutes
       FROM biometric_attendance
       WHERE member_id = $1 AND check_in_at::date >= $2
       ORDER BY check_in_at DESC LIMIT $3`,
      [memberId, from, limit]
    );
    res.json({ records: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/biometric-attend/report
router.get('/report', async (req, res, next) => {
  try {
    const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to   = req.query.to   || new Date().toISOString().slice(0, 10);

    const result = await pool.query(
      `SELECT
         ba.member_id,
         COALESCE(ba.member_name, c.name) AS member_name,
         COUNT(*)                          AS total_sessions,
         AVG(ba.session_duration_minutes)  AS avg_duration,
         MAX(ba.check_in_at)               AS last_checkin
       FROM biometric_attendance ba
       LEFT JOIN clients c ON c.id = ba.member_id
       WHERE ba.check_in_at::date BETWEEN $1 AND $2
       GROUP BY ba.member_id, member_name
       ORDER BY total_sessions DESC`,
      [from, to]
    );
    res.json({ from, to, data: result.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

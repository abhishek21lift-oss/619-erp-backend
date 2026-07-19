// src/routes/qr-checkin.js
// QR Code check-in system — generation, scanning, dashboard, member history.
//
// GET  /api/qr/generate              — generate QR data URL for current user
// GET  /api/qr/generate/:type/:id    — generate QR for specific user (admin/trainer)
// POST /api/qr/scan                  — validate signed QR payload + mark attendance
// POST /api/qr/checkout              — check out (end gym visit)
// GET  /api/qr/dashboard             — live attendance dashboard stats
// GET  /api/qr/my-history            — member's own attendance history + streaks
// GET  /api/qr/staff-report          — staff/trainer attendance report (admin only)
'use strict';

const router   = require('express').Router();
const crypto   = require('crypto');
const QRCode   = require('qrcode');
const pool     = require('../db/pool');
const logger   = require('../lib/logger');
const { auth } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');

const qrLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

// ── Helpers ───────────────────────────────────────────────────────────────────

function hmacSecret() {
  return process.env.KIOSK_HMAC_SECRET || process.env.JWT_SECRET || 'fallback-dev-only';
}

// Build a signed QR payload: base64(userId|userType|ts|sig)
// Static mode: ts = '0' (no expiry). Dynamic mode: ts = unix seconds.
function buildQrPayload(userId, userType, dynamic = false) {
  const ts = dynamic ? Math.floor(Date.now() / 1000).toString() : '0';
  const msg = `${userId}|${userType}|${ts}`;
  const sig = crypto.createHmac('sha256', hmacSecret()).update(msg).digest('hex');
  return Buffer.from(`${msg}|${sig}`).toString('base64url');
}

// Verify a QR payload. Returns { userId, userType } or throws.
function verifyQrPayload(payload, dynamicWindowSec = 300) {
  let decoded;
  try { decoded = Buffer.from(payload, 'base64url').toString('utf8'); }
  catch { throw new Error('Invalid QR payload encoding'); }

  const parts = decoded.split('|');
  if (parts.length !== 4) throw new Error('Malformed QR payload');
  const [userId, userType, ts, sig] = parts;

  const msg = `${userId}|${userType}|${ts}`;
  const expected = crypto.createHmac('sha256', hmacSecret()).update(msg).digest('hex');
  if (sig.length !== expected.length) {
    throw new Error('QR signature invalid');
  }
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new Error('QR signature invalid');
  }

  // Check expiry for dynamic QR (ts !== '0')
  if (ts !== '0') {
    const age = Math.floor(Date.now() / 1000) - parseInt(ts, 10);
    if (age > dynamicWindowSec || age < -60) throw new Error('QR code expired');
  }

  return { userId, userType };
}

async function generateQrDataUrl(userId, userType, dynamic = false) {
  const payload = buildQrPayload(userId, userType, dynamic);
  return QRCode.toDataURL(payload, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 300,
    color: { dark: '#0f172a', light: '#ffffff' },
  });
}

// Real client data in this deployment lives in pt_clients — `clients` is
// legacy and (in production) empty. Try clients first, fall back to
// pt_clients (pt_clients has no member_code). Neither table actually has
// expiry_date/subscription_end_date columns — pt_end_date is the only
// real expiry signal membershipStatus() below can use.
async function resolveUser(userId, userType) {
  if (userType === 'client') {
    const { rows } = await pool.query(
      `SELECT id, name, status, photo_url, member_code, client_id,
              pt_end_date, package_type
         FROM clients WHERE id = $1 LIMIT 1`,
      [userId]
    );
    if (rows[0]) return { ...rows[0], _type: 'client' };

    const { rows: ptRows } = await pool.query(
      `SELECT id, name, status, photo_url, client_id AS member_code, client_id,
              pt_end_date, package_type
         FROM pt_clients WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      [userId]
    );
    return ptRows[0] ? { ...ptRows[0], _type: 'client' } : null;
  }
  if (userType === 'trainer') {
    const { rows } = await pool.query(
      'SELECT id, name, email, mobile FROM trainers WHERE id = $1 LIMIT 1',
      [userId]
    );
    return rows[0] ? { ...rows[0], status: 'active', _type: 'trainer' } : null;
  }
  // staff / user
  const { rows } = await pool.query(
    'SELECT id, name, email, role FROM users WHERE id = $1 LIMIT 1',
    [userId]
  );
  return rows[0] ? { ...rows[0], status: 'active', _type: userType } : null;
}

function membershipStatus(user) {
  if (!user) return 'not_found';
  if (user.status === 'frozen') return 'frozen';
  const today = new Date().toISOString().slice(0, 10);
  const exp = user.expiry_date || user.subscription_end_date || user.pt_end_date;
  if (exp && exp < today) return 'expired';
  if (user.status && user.status !== 'active') return user.status;
  return 'active';
}

async function markAttendance(userId, userType, userName, method, deviceInfo, location) {
  const refType = userType === 'client' ? 'client' : userType === 'trainer' ? 'trainer' : 'staff';
  const date = new Date().toISOString().slice(0, 10);

  const { rows } = await pool.query(
    `INSERT INTO attendance_logs
       (ref_id, ref_type, ref_name, date, check_in_time, method, status, notes, user_id, device_info, location)
     VALUES ($1, $2, $3, $4::date, NOW(), $5, 'present', $6, $7, $8, $9)
     ON CONFLICT (ref_id, ref_type, date) DO UPDATE
       SET check_in_time = COALESCE(attendance_logs.check_in_time, EXCLUDED.check_in_time),
           status        = 'present',
           method        = CASE WHEN attendance_logs.method = 'manual' THEN EXCLUDED.method
                                ELSE attendance_logs.method END,
           notes         = EXCLUDED.notes
     RETURNING id, check_in_time`,
    [userId, refType, userName, date, method,
     `${method.toUpperCase()} check-in`, userId, deviceInfo || null, location || null]
  );
  return rows[0];
}

// ── GET /api/qr/generate ──────────────────────────────────────────────────────
// Generate QR for the currently authenticated user.
router.get('/generate', auth, qrLimiter, async (req, res) => {
  try {
    const u = req.user;
    let userId = u.id;
    let userType = 'user';

    // Map auth role to QR user type
    if (u.member_id) { userId = u.member_id; userType = 'client'; }
    else if (u.trainer_id) { userId = u.trainer_id; userType = 'trainer'; }
    else if (['admin', 'manager', 'staff', 'reception', 'receptionist'].includes(u.role)) {
      userType = 'staff';
    }

    const dynamic = req.query.dynamic === 'true';
    const dataUrl = await generateQrDataUrl(userId, userType, dynamic);
    const payload = buildQrPayload(userId, userType, dynamic);

    res.json({ dataUrl, payload, userId, userType, dynamic, expiresIn: dynamic ? 300 : null });
  } catch (err) {
    logger.error({ err: err.message }, 'QR generate error');
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// ── GET /api/qr/generate/:type/:id ───────────────────────────────────────────
// Generate QR for any user (admin or trainer for their clients).
router.get('/generate/:type/:id', auth, qrLimiter, async (req, res) => {
  try {
    const { type, id } = req.params;
    const allowed = ['client', 'trainer', 'staff', 'user'];
    if (!allowed.includes(type)) return res.status(400).json({ error: 'Invalid user type' });

    // RBAC
    const isAdmin = ['admin', 'manager', 'owner'].includes(req.user.role);
    const isTrainer = req.user.role === 'trainer';
    if (!isAdmin && !isTrainer) return res.status(403).json({ error: 'Not authorized' });

    // Trainers can only generate for their own clients (gym and PT)
    if (isTrainer && type === 'client') {
      const { rows } = await pool.query(
        `SELECT 1 FROM clients WHERE id = $1 AND trainer_id = $2
         UNION
         SELECT 1 FROM pt_clients WHERE id = $1 AND trainer_id = $2
         LIMIT 1`,
        [id, req.user.trainer_id]
      );
      if (!rows[0]) return res.status(403).json({ error: 'Client not assigned to you' });
    } else if (isTrainer && type !== 'client') {
      return res.status(403).json({ error: 'Trainers can only generate QR for their clients' });
    }

    const dynamic = req.query.dynamic === 'true';
    const dataUrl = await generateQrDataUrl(id, type, dynamic);
    const payload = buildQrPayload(id, type, dynamic);

    res.json({ dataUrl, payload, userId: id, userType: type, dynamic, expiresIn: dynamic ? 300 : null });
  } catch (err) {
    logger.error({ err: err.message }, 'QR generate/:type/:id error');
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// ── POST /api/qr/scan ─────────────────────────────────────────────────────────
// Validate signed QR payload and mark attendance. Called by scanner.
// Auth required (reception, kiosk, trainer, admin) OR kiosk token.
const scanLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });

router.post('/scan', auth, scanLimiter, async (req, res) => {
  try {
    const { payload, device_info, location } = req.body;
    if (!payload) return res.status(400).json({ error: 'QR payload required' });

    let userId, userType;
    try {
      ({ userId, userType } = verifyQrPayload(payload));
    } catch (verifyErr) {
      return res.status(400).json({ error: verifyErr.message, success: false });
    }

    // Duplicate scan prevention: check if already checked in today within 5 minutes
    const refType = userType === 'client' ? 'client' : userType === 'trainer' ? 'trainer' : 'staff';
    const { rows: recent } = await pool.query(
      `SELECT id, check_in_time FROM attendance_logs
       WHERE ref_id = $1 AND ref_type = $2 AND date = CURRENT_DATE
         AND check_in_time > NOW() - INTERVAL '5 minutes'
       LIMIT 1`,
      [userId, refType]
    );
    if (recent[0]) {
      const user = await resolveUser(userId, userType);
      return res.json({
        success: true,
        duplicate: true,
        message: `Already checked in (${new Date(recent[0].check_in_time).toLocaleTimeString()})`,
        user: { id: userId, name: user?.name || 'Unknown', status: 'active' },
        attendance_id: recent[0].id,
      });
    }

    const user = await resolveUser(userId, userType);
    if (!user) return res.status(404).json({ error: 'User not found', success: false });

    const status = membershipStatus(user);
    if (status !== 'active' && userType === 'client') {
      return res.json({
        success: false,
        message: `Membership ${status}`,
        user: { id: userId, name: user.name, status },
      });
    }

    const att = await markAttendance(userId, userType, user.name, 'qr', device_info, location);

    return res.json({
      success: true,
      message: `Welcome, ${user.name}!`,
      user: {
        id: userId,
        name: user.name,
        status: status,
        photo_url: user.photo_url || null,
        member_code: user.member_code || user.client_id || null,
        package_type: user.package_type || null,
        role: user.role || userType,
      },
      attendance_id: att?.id,
      check_in_time: att?.check_in_time,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'QR scan error');
    res.status(500).json({ error: 'Server error', success: false });
  }
});

// ── POST /api/qr/checkout ─────────────────────────────────────────────────────
// Marks check-out time for the current user's today attendance record.
router.post('/checkout', auth, async (req, res) => {
  try {
    const u = req.user;
    let userId = u.id;
    let refType = 'staff';

    if (u.member_id) { userId = u.member_id; refType = 'client'; }
    else if (u.trainer_id) { userId = u.trainer_id; refType = 'trainer'; }

    const { rows } = await pool.query(
      `UPDATE attendance_logs
          SET check_out_time = NOW()
        WHERE ref_id = $1 AND ref_type = $2 AND date = CURRENT_DATE
          AND check_out_time IS NULL
        RETURNING id, check_in_time, check_out_time`,
      [userId, refType]
    );

    if (!rows[0]) return res.json({ success: false, message: 'No active check-in found for today' });

    const duration = rows[0].check_in_time
      ? Math.round((new Date(rows[0].check_out_time) - new Date(rows[0].check_in_time)) / 60000)
      : null;

    res.json({
      success: true,
      message: 'Checked out successfully',
      attendance_id: rows[0].id,
      duration_minutes: duration,
      check_out_time: rows[0].check_out_time,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'QR checkout error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/qr/dashboard ─────────────────────────────────────────────────────
// Live attendance dashboard: currently inside, today's count, peak hours, breakdown.
router.get('/dashboard', auth, async (req, res) => {
  try {
    const [todayStats, currentlyInside, hourlyBreakdown, weeklyTrend, methodBreakdown] =
      await Promise.all([
        // Today's totals by ref_type
        pool.query(
          `SELECT ref_type,
                  COUNT(*) FILTER (WHERE status = 'present') AS present,
                  COUNT(*) FILTER (WHERE status = 'late')    AS late,
                  COUNT(*) FILTER (WHERE status = 'absent')  AS absent,
                  COUNT(*)                                    AS total
             FROM attendance_logs
            WHERE date = CURRENT_DATE
            GROUP BY ref_type`
        ),

        // Currently inside (checked in today, not checked out)
        pool.query(
          `SELECT ref_type, COUNT(*) AS count
             FROM attendance_logs
            WHERE date = CURRENT_DATE
              AND check_in_time IS NOT NULL
              AND check_out_time IS NULL
              AND status = 'present'
            GROUP BY ref_type`
        ),

        // Hourly check-in distribution for today
        pool.query(
          `SELECT EXTRACT(HOUR FROM check_in_time)::int AS hour, COUNT(*) AS count
             FROM attendance_logs
            WHERE date = CURRENT_DATE AND check_in_time IS NOT NULL
            GROUP BY hour ORDER BY hour`
        ),

        // Past 7 days total check-ins (trend)
        pool.query(
          `SELECT date, COUNT(*) FILTER (WHERE status = 'present') AS present
             FROM attendance_logs
            WHERE date >= CURRENT_DATE - INTERVAL '6 days'
            GROUP BY date ORDER BY date`
        ),

        // Check-in method breakdown today
        pool.query(
          `SELECT method, COUNT(*) AS count
             FROM attendance_logs
            WHERE date = CURRENT_DATE AND status = 'present'
            GROUP BY method`
        ),
      ]);

    // Recent check-ins (last 20) with user info. `clients` is legacy/empty
    // in this deployment — real client rows live in pt_clients.
    const { rows: recent } = await pool.query(
      `SELECT a.id, a.ref_id, a.ref_type, a.ref_name, a.check_in_time, a.check_out_time,
              a.method, a.status,
              COALESCE(c.photo_url, pc.photo_url) AS photo_url,
              COALESCE(c.member_code, pc.client_id) AS member_code,
              COALESCE(c.status, pc.status) AS membership_status
         FROM attendance_logs a
         LEFT JOIN clients c ON c.id = a.ref_id AND a.ref_type = 'client'
         LEFT JOIN pt_clients pc ON pc.id = a.ref_id AND a.ref_type = 'client' AND pc.deleted_at IS NULL
        WHERE a.date = CURRENT_DATE AND a.status = 'present'
        ORDER BY a.check_in_time DESC NULLS LAST
        LIMIT 20`
    );

    const todayMap = {};
    for (const r of todayStats.rows) {
      todayMap[r.ref_type] = {
        present: parseInt(r.present),
        late:    parseInt(r.late),
        absent:  parseInt(r.absent),
        total:   parseInt(r.total),
      };
    }

    const insideMap = {};
    for (const r of currentlyInside.rows) insideMap[r.ref_type] = parseInt(r.count);

    const totalInside = Object.values(insideMap).reduce((s, v) => s + v, 0);
    const totalToday  = todayStats.rows.reduce((s, r) => s + parseInt(r.present) + parseInt(r.late), 0);

    res.json({
      currently_inside: { total: totalInside, breakdown: insideMap },
      today: { total: totalToday, breakdown: todayMap },
      hourly: hourlyBreakdown.rows.map((r) => ({ hour: r.hour, count: parseInt(r.count) })),
      weekly_trend: weeklyTrend.rows.map((r) => ({ date: r.date, present: parseInt(r.present) })),
      method_breakdown: methodBreakdown.rows.map((r) => ({ method: r.method, count: parseInt(r.count) })),
      recent_checkins: recent,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Dashboard error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/qr/my-history ────────────────────────────────────────────────────
// Member's own attendance history with streak calculation.
router.get('/my-history', auth, async (req, res) => {
  try {
    const u = req.user;
    let refId = u.id;
    let refType = 'staff';

    if (u.member_id) { refId = u.member_id; refType = 'client'; }
    else if (u.trainer_id) { refId = u.trainer_id; refType = 'trainer'; }

    const limit = Math.min(parseInt(req.query.limit || '90'), 365);
    const { rows } = await pool.query(
      `SELECT date, status, check_in_time, check_out_time, method, duration_minutes
         FROM attendance_logs
        WHERE ref_id = $1 AND ref_type = $2
        ORDER BY date DESC
        LIMIT $3`,
      [refId, refType, limit]
    );

    // Calculate streaks
    const presentDates = new Set(
      rows.filter((r) => r.status === 'present' || r.status === 'late').map((r) => r.date)
    );

    let currentStreak = 0;
    let longestStreak = 0;
    let tempStreak = 0;
    let d = new Date();

    // Walk backwards from today
    for (let i = 0; i < 365; i++) {
      const dateStr = d.toISOString().slice(0, 10);
      if (presentDates.has(dateStr)) {
        tempStreak++;
        if (i === 0 || (i === 1 && tempStreak > 0)) currentStreak = tempStreak;
        longestStreak = Math.max(longestStreak, tempStreak);
      } else {
        if (i < 2) currentStreak = 0;
        if (tempStreak > longestStreak) longestStreak = tempStreak;
        tempStreak = 0;
        if (i > 0) break;
      }
      d.setDate(d.getDate() - 1);
    }

    const totalPresent = rows.filter((r) => r.status === 'present' || r.status === 'late').length;
    const totalDays    = rows.length;
    const thisMonthRows = rows.filter((r) => {
      const month = new Date().toISOString().slice(0, 7);
      return r.date && r.date.toString().startsWith(month);
    });
    const thisMonthPresent = thisMonthRows.filter((r) => r.status === 'present' || r.status === 'late').length;

    // Avg duration if tracked
    const durRows = rows.filter((r) => r.duration_minutes > 0);
    const avgDuration = durRows.length
      ? Math.round(durRows.reduce((s, r) => s + r.duration_minutes, 0) / durRows.length)
      : null;

    res.json({
      history: rows,
      stats: {
        total_present: totalPresent,
        total_days: totalDays,
        current_streak: currentStreak,
        longest_streak: longestStreak,
        this_month: thisMonthPresent,
        attendance_rate: totalDays ? Math.round((totalPresent / totalDays) * 100) : 0,
        avg_duration_minutes: avgDuration,
      },
    });
  } catch (err) {
    logger.error({ err: err.message }, 'My-history error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/qr/staff-report ──────────────────────────────────────────────────
// Admin report of staff/trainer attendance for a given period.
router.get('/staff-report', auth, async (req, res) => {
  try {
    const isAdmin = ['admin', 'manager', 'owner'].includes(req.user.role);
    if (!isAdmin) return res.status(403).json({ error: 'Admin only' });

    const from  = req.query.from || new Date().toISOString().slice(0, 7) + '-01';
    const to    = req.query.to   || new Date().toISOString().slice(0, 10);
    const type  = req.query.type || 'all'; // client|trainer|staff|all

    const conds = ['date >= $1::date', 'date <= $2::date'];
    const params = [from, to];
    if (type !== 'all') {
      params.push(type);
      conds.push(`ref_type = $${params.length}`);
    }

    const { rows } = await pool.query(
      `SELECT ref_id, ref_name, ref_type,
              COUNT(*)                                    AS total_days,
              COUNT(*) FILTER (WHERE status = 'present') AS present,
              COUNT(*) FILTER (WHERE status = 'late')    AS late,
              COUNT(*) FILTER (WHERE status = 'absent')  AS absent,
              ROUND(AVG(duration_minutes))                AS avg_duration_min,
              MIN(check_in_time::time)                   AS earliest_checkin,
              MAX(check_in_time::time)                   AS latest_checkin
         FROM attendance_logs
        WHERE ${conds.join(' AND ')}
        GROUP BY ref_id, ref_name, ref_type
        ORDER BY ref_name`,
      params
    );

    res.json({ data: rows, from, to, type });
  } catch (err) {
    logger.error({ err: err.message }, 'Staff report error');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;

// src/routes/checkin.js
//
// Face check-in API
//   POST /api/checkin/face        — match descriptor & log attendance
//   POST /api/checkin/enroll      — store a member's face descriptor
//   GET  /api/checkin/logs        — recent check-in events
//
// Storage:
//   * Face descriptors live on `clients.face_descriptor` (FLOAT8[128])
//   * Each successful or failed match is appended to `face_checkin_logs`
//
// Recognition:
//   * Euclidean distance between query and stored 128-D descriptors
//   * Threshold of 0.50 — lower = stricter (face-api.js default 0.6)
//
// All routes require auth except where noted.

const router = require('express').Router();
const { v4: uuid } = require('uuid');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');
const logger = require('../lib/logger');
const { kioskTokenMiddleware } = require('../middleware/kiosk-token');

const faceLimiter = rateLimit({ windowMs: 60 * 1000, max: 15, standardHeaders: true, legacyHeaders: false });
function kioskOrAuth(req, res, next) {
  if (req.user && req.user.role === 'kiosk') return next();
  return auth(req, res, next);
}


// ──────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────
const RECOGNITION_THRESHOLD = 0.50;     // Stricter than default 0.6
const DESCRIPTOR_LENGTH     = 128;       // face-api.js descriptor size

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────
function euclideanDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function isValidDescriptor(d) {
  return Array.isArray(d)
    && d.length === DESCRIPTOR_LENGTH
    && d.every((v) => typeof v === 'number' && Number.isFinite(v));
}

function membershipStatusFor(client) {
  // Trust DB status if present; otherwise infer from pt_end_date.
  if (client.status === 'frozen') return 'frozen';
  const today = new Date().toISOString().slice(0, 10);
  if (client.pt_end_date && client.pt_end_date < today) return 'expired';
  if (client.status && client.status !== 'active') return client.status;
  return 'active';
}

async function logCheckIn({ clientId, status, distance, ip, userAgent }) {
  const id = uuid();
  await pool.query(
    `INSERT INTO face_checkin_logs
       (id, client_id, status, distance, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, clientId, status, distance, ip || null, userAgent || null]
  );
  return id;
}

// ──────────────────────────────────────────────────────────────────
// POST /api/checkin/face
// Body: { descriptor: number[128] }
// ──────────────────────────────────────────────────────────────────
router.post('/face', kioskTokenMiddleware, faceLimiter, kioskOrAuth, async (req, res, next) => {
  try {
    const descriptor = req.body?.descriptor;
    if (!isValidDescriptor(descriptor)) {
      return res.status(400).json({
        success: false,
        error: `descriptor must be a length-${DESCRIPTOR_LENGTH} array of finite numbers`,
      });
    }

    // Pull every client that has an enrolled descriptor.
    // `face_descriptor` is FLOAT8[] so we filter with IS NOT NULL.
    const { rows: clients } = await pool.query(
      `SELECT id, name, status, photo_url, member_code, client_id,
              package_type, pt_end_date, trainer_id, face_descriptor
         FROM clients
        WHERE face_descriptor IS NOT NULL`
    );

    if (clients.length === 0) {
      const logId = await logCheckIn({
        clientId: null, status: 'unknown', distance: null,
        ip: req.ip, userAgent: req.headers['user-agent'],
      });
      return res.status(404).json({
        success: false,
        error: 'No enrolled members. Ask reception to enroll faces first.',
        log_id: logId,
      });
    }

    // Find the closest match.
    // PERF: early-exit when we already have a confident match (< 0.30) so
    // we don't keep scanning the rest of the table. For real scale install
    // pgvector and switch to ORDER BY descriptor <-> $1 LIMIT 1.
    const CONFIDENT_THRESHOLD = 0.30;
    let best = { distance: Infinity, client: null };
    for (const c of clients) {
      const stored = Array.isArray(c.face_descriptor)
        ? c.face_descriptor
        : (typeof c.face_descriptor === 'string'
            ? JSON.parse(c.face_descriptor) : null);
      if (!isValidDescriptor(stored)) continue;
      const d = euclideanDistance(descriptor, stored);
      if (d < best.distance) {
        best = { distance: d, client: c };
        if (d < CONFIDENT_THRESHOLD) break;
      }
    }

    if (best.distance > RECOGNITION_THRESHOLD || !best.client) {
      const logId = await logCheckIn({
        clientId: null,
        status: 'unknown',
        distance: best.distance === Infinity ? null : best.distance,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      return res.status(404).json({
        success: false,
        error: 'Face not recognized',
        distance: best.distance === Infinity ? null : Number(best.distance.toFixed(4)),
        log_id: logId,
      });
    }

    const member = best.client;
    const memberStatus = membershipStatusFor(member);

    // Trainer RBAC: only allow trainers to check in their own clients.
    if (req.user.role === 'trainer' && member.trainer_id !== req.user.trainer_id) {
      const logId = await logCheckIn({
        clientId: member.id, status: 'denied',
        distance: best.distance,
        ip: req.ip, userAgent: req.headers['user-agent'],
      });
      return res.status(403).json({
        success: false,
        error: 'Member is not assigned to you',
        log_id: logId,
      });
    }

    // Expired / frozen → log + tell client (but don't mark attendance).
    if (memberStatus !== 'active') {
      const logId = await logCheckIn({
        clientId: member.id,
        status: memberStatus === 'expired' ? 'expired' : 'denied',
        distance: best.distance,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      return res.status(200).json({
        success: true,        // we recognized the face; UI checks `member.status`
        message: `Membership ${memberStatus}`,
        member: {
          id: member.id,
          name: member.name,
          status: memberStatus,
          photo_url: member.photo_url,
          member_code: member.member_code || member.client_id,
          package_type: member.package_type,
        },
        distance: Number(best.distance.toFixed(4)),
        log_id: logId,
      });
    }

    // Active member → mark attendance in attendance_logs (v4 schema) + log.
    const now = new Date();
    const date = now.toISOString().slice(0, 10);

    // FIX: was INSERT INTO attendance (old v3 table with wrong column names).
    // Now uses attendance_logs with the v4 schema columns.
    await pool.query(
      `INSERT INTO attendance_logs
         (ref_id, ref_type, ref_name, date, check_in_time, method, status, notes)
       VALUES ($1, 'client', $2, $3::date, NOW(), 'face', 'present', 'Face check-in')
       ON CONFLICT (ref_id, ref_type, date) DO UPDATE
         SET status       = 'present',
             check_in_time = COALESCE(attendance_logs.check_in_time, EXCLUDED.check_in_time),
             method        = 'face',
             notes         = 'Face check-in'`,
      [member.id, member.name, date]
    );

    const logId = await logCheckIn({
      clientId: member.id,
      status: 'success',
      distance: best.distance,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return res.status(200).json({
      success: true,
      message: `Welcome ${member.name}`,
      member: {
        id: member.id,
        name: member.name,
        status: 'active',
        photo_url: member.photo_url,
        member_code: member.member_code || member.client_id,
        package_type: member.package_type,
      },
      distance: Number(best.distance.toFixed(4)),
      log_id: logId,
    });
  } catch (err) {
    logger.error({ err: err.message }, '[checkin/face] error');
    return next(err);
  }
});

// ──────────────────────────────────────────────────────────────────
// POST /api/checkin/enroll
// Body: { client_id, descriptor }
// Stores the face descriptor for an existing client.
// Admin or reception only.
// ──────────────────────────────────────────────────────────────────
router.post('/enroll', auth, faceLimiter, async (req, res, next) => {
  try {
    // Owners and managers can also enroll faces — same trust level as admin
    // for a single-gym deployment. Trainers can enroll only their own
    // assigned members (validated below before the UPDATE).
    const allowedRoles = new Set(['admin', 'owner', 'manager', 'reception', 'trainer']);
    if (!allowedRoles.has(req.user.role)) {
      return res.status(403).json({ error: 'Not allowed to enroll faces' });
    }

    const { client_id, descriptor } = req.body || {};
    if (!client_id) return res.status(400).json({ error: 'client_id required' });
    if (!isValidDescriptor(descriptor)) {
      return res.status(400).json({
        error: `descriptor must be a length-${DESCRIPTOR_LENGTH} array of finite numbers`,
      });
    }

    // Trainers can only enroll their own assigned clients
    if (req.user.role === 'trainer') {
      const { rows: own } = await pool.query(
        'SELECT 1 FROM clients WHERE id = $1 AND trainer_id = $2 LIMIT 1',
        [client_id, req.user.trainer_id]
      );
      if (own.length === 0) {
        return res.status(403).json({ error: 'Member is not assigned to you' });
      }
    }

    // FIX: pg driver serialises JS Arrays as PostgreSQL array literals, but
    // uses `.toString()` on each element, which produces scientific notation
    // like "1e-8" for very small floats. PostgreSQL's float8[] parser does NOT
    // accept scientific notation. Format the array manually with toFixed(8) to
    // ensure plain decimal format.
    const pgArray = `{${descriptor.map(v => v.toFixed(8)).join(',')}}`;

    const clientResult = await pool.query(
      `UPDATE clients
          SET face_descriptor  = $1::float8[],
              face_enrolled    = TRUE,
              face_enrolled_at = NOW()
        WHERE id = $2
      RETURNING id`,
      [pgArray, client_id]
    );

    if (clientResult.rowCount === 0) return res.status(404).json({ error: 'Client not found' });

    // face_descriptors has enrolled_at (DEFAULT NOW()) and no updated_at.
    await pool.query(
      `INSERT INTO face_descriptors (client_id, descriptor, is_active)
       VALUES ($1, $2::float8[], TRUE)
       ON CONFLICT DO NOTHING`,
      [client_id, pgArray]
    ).catch(() => null);

    return res.status(200).json({ message: 'Face enrolled', client_id });
  } catch (err) {
    logger.error({ err: err.message }, '[checkin/enroll] error');
    return next(err);
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /api/checkin/logs?date=YYYY-MM-DD&limit=N
// ──────────────────────────────────────────────────────────────────
router.get('/logs', auth, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const date = req.query.date;
    const params = [];
    const conds = ['1=1'];

    if (date) {
      params.push(date);
      conds.push(`l.created_at::date = $${params.length}`);
    }

    if (req.user.role === 'trainer' && req.user.trainer_id) {
      params.push(req.user.trainer_id);
      conds.push(`(c.trainer_id = $${params.length} OR l.client_id IS NULL)`);
    }

    const { rows } = await pool.query(
      `SELECT l.id, l.client_id, l.status, l.distance, l.created_at,
              c.name AS client_name, c.photo_url, c.member_code
         FROM face_checkin_logs l
    LEFT JOIN clients c ON c.id = l.client_id
        WHERE ${conds.join(' AND ')}
        ORDER BY l.created_at DESC
        LIMIT ${limit}`,
      params
    );
    return res.json(rows);
  } catch (err) {
    logger.error({ err: err.message }, '[checkin/logs] error');
    return next(err);
  }
});

module.exports = router;

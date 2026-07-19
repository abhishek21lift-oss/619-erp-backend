// src/routes/checkin.js
//
// Face check-in API
//   POST /api/checkin/face           — match descriptor & log attendance
//   POST /api/checkin/enroll         — store a member's face descriptor
//   GET  /api/checkin/descriptors    — list all active descriptors (for kiosk-side matching)
//   GET  /api/checkin/logs           — recent check-in events
//   DELETE /api/checkin/enroll/:id   — revoke a member's face enrollment
//
// Storage:
//   * Face descriptors live in `face_descriptors` table (normalized, multi-version)
//   * `clients.face_descriptor` is kept in sync for backwards compat
//   * Each check-in attempt is appended to `face_checkin_logs`
//
// Recognition:
//   * Euclidean distance between query and stored 128-D descriptors
//   * Threshold of 0.40 — tightened from 0.50 to reduce false-positives (face-api.js default 0.6)
//
// All routes require auth except where noted.

const router = require('express').Router();
const { randomUUID } = require('crypto');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');
const logger = require('../lib/logger');
const { kioskTokenMiddleware } = require('../middleware/kiosk-token');
const { encryptDescriptor, decryptDescriptor, isEncryptionEnabled } = require('../lib/faceEncryption');

// Separate rate limiters so a burst of enrollment attempts doesn't block
// the check-in kiosk and vice versa.
const enrollLimiter = rateLimit({ windowMs: 60 * 1000, max: 15, standardHeaders: true, legacyHeaders: false });
const faceLimiter   = rateLimit({ windowMs: 60 * 1000, max: 15, standardHeaders: true, legacyHeaders: false });

function kioskOrAuth(req, res, next) {
  if (req.user && req.user.role === 'kiosk') return next();
  return auth(req, res, next);
}

function authOrKioskForEnroll(req, res, next) {
  // Enrollment with kiosk token is allowed for self-enrollment flows.
  if (req.user && req.user.role === 'kiosk') return next();
  return auth(req, res, next);
}


// ──────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────
// M-08: tightened from 0.50 to 0.40 — reduces false-positive matches
// ISSUE-047: default is 0.40 but can be overridden via system_settings key 'face_match_threshold'
const DEFAULT_RECOGNITION_THRESHOLD = 0.40;
const DESCRIPTOR_LENGTH     = 128;

// In-memory cache for the face match threshold from system_settings.
// Avoids a DB round-trip on every checkin; refreshes every 60s.
let _thresholdCache = null;

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
  if (client.status === 'frozen') return 'frozen';
  const today = new Date().toISOString().slice(0, 10);
  const expiry = client.expiry_date || client.subscription_end_date || client.pt_end_date;
  if (expiry && expiry < today) return 'expired';
  if (client.status && client.status !== 'active') return client.status;
  return 'active';
}

async function logCheckIn({ clientId, status, distance, ip, userAgent, attendanceId }) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO face_checkin_logs
       (id, client_id, status, distance, ip, user_agent, attendance_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, clientId || null, status, distance || null, ip || null, userAgent || null, attendanceId || null]
  );
  return id;
}

function formatDescriptorToJson(arr) {
  // The descriptor column is JSONB, so we need a JSON array with
  // fixed-precision values (not PostgreSQL array literal syntax).
  return JSON.stringify(arr.map(v => +v.toFixed(8)));
}

// This deployment's real client data lives in pt_clients, not the legacy
// `clients` table — so every member lookup here is a UNION of both,
// normalized to a common column shape. Neither table actually has
// expiry_date/subscription_end_date columns (despite membershipStatusFor
// below checking for them) — pt_end_date is the only real expiry signal.
const MEMBER_UNION_SQL = `
  SELECT id, name, status, photo_url, member_code, client_id,
         package_type, pt_end_date, trainer_id
    FROM clients
  UNION ALL
  SELECT id, name, status, photo_url, client_id AS member_code, client_id,
         package_type, pt_end_date, trainer_id
    FROM pt_clients WHERE deleted_at IS NULL
`;

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

    // Fetch configurable face match threshold from system_settings (ISSUE-047).
    // Cache result for 60s to avoid a DB round-trip on every checkin.
    if (!_thresholdCache || Date.now() > _thresholdCache.expiresAt) {
      const row = await pool.query("SELECT value FROM system_settings WHERE key = 'face_match_threshold' LIMIT 1");
      _thresholdCache = {
        value: row.rows[0] ? parseFloat(row.rows[0].value) || DEFAULT_RECOGNITION_THRESHOLD : DEFAULT_RECOGNITION_THRESHOLD,
        expiresAt: Date.now() + 60_000,
      };
    }
    const RECOGNITION_THRESHOLD = _thresholdCache.value;

    // Try pgvector ANN matching first (O(log N)) — falls back to O(N) JS loop if
    // the descriptor_vec column doesn't exist yet (pre-migration 046 databases).
    let best = { distance: Infinity, client: null };

    try {
      // Format the query descriptor as a Postgres vector literal.
      const vecLiteral = '[' + descriptor.map(v => v.toFixed(8)).join(',') + ']';
      const { rows: vecRows } = await pool.query(
        `SELECT c.id, c.name, c.status, c.photo_url, c.member_code, c.client_id,
                c.package_type, c.pt_end_date, c.trainer_id,
                d.descriptor_enc, d.id AS descriptor_id,
                (d.descriptor_vec <-> $1::vector) AS distance
           FROM face_descriptors d
           JOIN (${MEMBER_UNION_SQL}) c ON c.id = d.client_id
          WHERE d.is_active = TRUE
            AND d.descriptor_vec IS NOT NULL
          ORDER BY d.descriptor_vec <-> $1::vector
          LIMIT 1`,
        [vecLiteral]
      );

      if (vecRows.length > 0) {
        const row = vecRows[0];
        const distance = parseFloat(row.distance);
        // For pgvector result, descriptor is already matched server-side.
        // Decrypt enc column for membership check if needed.
        if (row.descriptor_enc && isEncryptionEnabled()) {
          row.face_descriptor = decryptDescriptor(row.descriptor_enc);
        }
        best = { distance, client: row };
      } else {
        // No vector rows — fall through to O(N) JS scan below.
        throw new Error('no_vector_rows');
      }
    } catch (_vecErr) {
      // pgvector not installed or descriptor_vec not populated — use O(N) JS fallback.
      const { rows: clients } = await pool.query(
        `SELECT c.id, c.name, c.status, c.photo_url, c.member_code, c.client_id,
                c.package_type, c.pt_end_date, c.trainer_id,
                d.descriptor AS face_descriptor, d.descriptor_enc, d.id AS descriptor_id
           FROM face_descriptors d
           JOIN (${MEMBER_UNION_SQL}) c ON c.id = d.client_id
          WHERE d.is_active = TRUE`
      );

      for (const c of clients) {
        if (c.descriptor_enc && isEncryptionEnabled()) {
          c.face_descriptor = decryptDescriptor(c.descriptor_enc);
        }
      }

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

      const CONFIDENT_THRESHOLD = 0.30;
      for (const c of clients) {
        if (!isValidDescriptor(c.face_descriptor)) continue;
        const d = euclideanDistance(descriptor, c.face_descriptor);
        if (d < best.distance) {
          best = { distance: d, client: c };
          if (d < CONFIDENT_THRESHOLD) break;
        }
      }
    }

    if (best.distance === Infinity || !best.client) {
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
    if (req.user && req.user.role === 'trainer' && member.trainer_id !== req.user.trainer_id) {
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
        success: true,
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

    // Active member → mark attendance.
    const date = new Date().toISOString().slice(0, 10);

    const { rows: attendanceRows } = await pool.query(
      `INSERT INTO attendance_logs
         (ref_id, ref_type, ref_name, date, check_in_time, method, status, notes)
       VALUES ($1, 'client', $2, $3::date, NOW(), 'face', 'present', 'Face check-in')
       ON CONFLICT (ref_id, ref_type, date) DO UPDATE
         SET status       = 'present',
             check_in_time = COALESCE(attendance_logs.check_in_time, EXCLUDED.check_in_time),
             method        = 'face',
             notes         = 'Face check-in'
       RETURNING id`,
      [member.id, member.name, date]
    );
    const attendanceId = attendanceRows?.[0]?.id || null;

    const logId = await logCheckIn({
      clientId: member.id,
      status: 'success',
      distance: best.distance,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      attendanceId,
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
// ──────────────────────────────────────────────────────────────────
router.post('/enroll', kioskTokenMiddleware, authOrKioskForEnroll, enrollLimiter, async (req, res, next) => {
  try {
    // Skip role check for kiosk tokens (self-enrollment at kiosk).
    if (!req.user || req.user.role !== 'kiosk') {
      const allowedRoles = new Set(['admin', 'owner', 'manager', 'reception', 'trainer']);
      if (!allowedRoles.has(req.user.role)) {
        return res.status(403).json({ error: 'Not allowed to enroll faces' });
      }
    }

    const { client_id, descriptor } = req.body || {};
    if (!client_id) return res.status(400).json({ error: 'client_id required' });
    if (!isValidDescriptor(descriptor)) {
      return res.status(400).json({
        error: `descriptor must be a length-${DESCRIPTOR_LENGTH} array of finite numbers`,
      });
    }

    // Trainers can only enroll their own assigned clients.
    // ISSUE-022: check both clients (gym) and pt_clients (PT OS) so PT clients
    // don't incorrectly receive a 403 during face enrollment.
    if (req.user && req.user.role === 'trainer') {
      const { rows: own } = await pool.query(
        `SELECT 1 FROM clients WHERE id = $1 AND trainer_id = $2
         UNION
         SELECT 1 FROM pt_clients WHERE id = $1 AND trainer_id = $2
         LIMIT 1`,
        [client_id, req.user.trainer_id]
      );
      if (own.length === 0) {
        return res.status(403).json({ error: 'Member is not assigned to you' });
      }
    }

    const jsonDescriptor = formatDescriptorToJson(descriptor);

    // Encrypt descriptor if key is configured; otherwise fall back to plaintext.
    let descriptorEnc = null;
    let plaintextForLegacy = jsonDescriptor;
    if (isEncryptionEnabled()) {
      descriptorEnc = encryptDescriptor(descriptor);
      // Null out the plaintext column for new enrollments once encryption is active.
      plaintextForLegacy = null;
    }

    // Advisory lock prevents concurrent enrollment for the same client
    // creating duplicate active face descriptors (race condition fix).
    const lockKey = Buffer.from(client_id).reduce((a, b) => ((a << 5) - a + b) | 0, 0);
    await pool.query('SELECT pg_advisory_lock($1)', [lockKey]);
    let descriptorId;
    try {
      // Update whichever table this client actually lives in — real client
      // data in this deployment is in pt_clients, `clients` is legacy.
      let clientResult = await pool.query(
        `UPDATE clients
            SET face_descriptor  = $1::jsonb,
                face_enrolled    = TRUE,
                face_enrolled_at = NOW()
          WHERE id = $2
        RETURNING id`,
        [jsonDescriptor, client_id]
      );

      if (clientResult.rowCount === 0) {
        clientResult = await pool.query(
          `UPDATE pt_clients
              SET face_descriptor  = $1::jsonb,
                  face_enrolled    = TRUE,
                  face_enrolled_at = NOW()
            WHERE id = $2 AND deleted_at IS NULL
          RETURNING id`,
          [jsonDescriptor, client_id]
        );
      }

      if (clientResult.rowCount === 0) {
        return res.status(404).json({ error: 'Client not found' });
      }

      // Deactivate old descriptors for this client, then insert new one.
      await pool.query(
        `UPDATE face_descriptors SET is_active = FALSE, updated_at = NOW()
          WHERE client_id = $1 AND is_active = TRUE`,
        [client_id]
      );

      descriptorId = randomUUID();
      const enrolledBy = req.user && req.user.role !== 'kiosk' ? req.user.id : null;
      // Attempt to populate the pgvector column (descriptor_vec) alongside the
      // legacy JSONB column. If pgvector isn't installed yet (pre-migration 046),
      // the INSERT falls back gracefully by omitting the column.
      const vecLiteral = '[' + descriptor.map(v => v.toFixed(8)).join(',') + ']';
      let insertResult;
      try {
        insertResult = await pool.query(
          `INSERT INTO face_descriptors
             (id, client_id, angle, descriptor, descriptor_enc, descriptor_vec, is_active, enrolled_by, updated_at)
           VALUES ($1, $2, 'front', $3::jsonb, $4, $5::vector, TRUE, $6, NOW())`,
          [descriptorId, client_id, plaintextForLegacy, descriptorEnc, vecLiteral, enrolledBy]
        );
      } catch (_vecErr) {
        // pgvector not available yet — insert without vector column
        insertResult = await pool.query(
          `INSERT INTO face_descriptors (id, client_id, angle, descriptor, descriptor_enc, is_active, enrolled_by, updated_at)
           VALUES ($1, $2, 'front', $3::jsonb, $4, TRUE, $5, NOW())`,
          [descriptorId, client_id, plaintextForLegacy, descriptorEnc, enrolledBy]
        );
      }
    } finally {
      await pool.query('SELECT pg_advisory_unlock($1)', [lockKey]).catch(() => {});
    }

    // Log the enrollment event.
    await logCheckIn({
      clientId: client_id,
      status: 'enrolled',
      distance: null,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return res.status(200).json({ message: 'Face enrolled', client_id, descriptor_id: descriptorId });
  } catch (err) {
    logger.error({ err: err.message }, '[checkin/enroll] error');
    return next(err);
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /api/checkin/descriptors
// Admin-only export of all active face descriptors.
//
// DEPRECATED: client-side matching is no longer supported. All kiosks
// must POST descriptors to /api/checkin/face for server-side matching.
// This endpoint exists only for admin backup/export purposes and is
// restricted to admin/owner roles.
// ──────────────────────────────────────────────────────────────────
router.get('/descriptors', auth, async (req, res, next) => {
  try {
    // Restrict to admin/owner — biometric data must not be bulk-exported to regular staff
    const allowedRoles = new Set(['admin', 'owner']);
    if (!req.user || !allowedRoles.has(req.user.role)) {
      return res.status(403).json({
        error: 'Admin or owner role required to export face descriptor data',
      });
    }

    res.set('Deprecation', 'true');
    res.set('Sunset', 'Client-side matching is removed. Use POST /api/checkin/face instead.');

    const { rows } = await pool.query(
      `SELECT d.client_id, c.name, d.descriptor, d.descriptor_enc
         FROM face_descriptors d
         JOIN (${MEMBER_UNION_SQL}) c ON c.id = d.client_id
        WHERE d.is_active = TRUE
        ORDER BY c.name`
    );
    const resolved = rows.map(r => {
      let descriptor = r.descriptor;
      if (r.descriptor_enc && isEncryptionEnabled()) {
        descriptor = decryptDescriptor(r.descriptor_enc) ?? descriptor;
      }
      return { client_id: r.client_id, name: r.name, descriptor };
    });
    return res.json(resolved);
  } catch (err) {
    logger.error({ err: err.message }, '[checkin/descriptors] error');
    return next(err);
  }
});

// ──────────────────────────────────────────────────────────────────
// DELETE /api/checkin/enroll/:clientId
// Revokes a member's face enrollment.
// ──────────────────────────────────────────────────────────────────
router.delete('/enroll/:clientId', auth, async (req, res, next) => {
  try {
    const { clientId } = req.params;

    const allowedRoles = new Set(['admin', 'owner', 'manager', 'reception']);
    if (!allowedRoles.has(req.user.role)) {
      return res.status(403).json({ error: 'Not allowed to revoke face enrollment' });
    }

    // Deactivate all active descriptors.
    await pool.query(
      `UPDATE face_descriptors SET is_active = FALSE, updated_at = NOW()
        WHERE client_id = $1 AND is_active = TRUE`,
      [clientId]
    );

    // Clear whichever table this client lives in.
    await pool.query(
      `UPDATE clients
          SET face_descriptor  = NULL::jsonb,
              face_enrolled    = FALSE,
              face_enrolled_at = NULL
        WHERE id = $1`,
      [clientId]
    );
    await pool.query(
      `UPDATE pt_clients
          SET face_descriptor  = NULL::jsonb,
              face_enrolled    = FALSE,
              face_enrolled_at = NULL
        WHERE id = $1`,
      [clientId]
    );

    // Log the revocation.
    await logCheckIn({
      clientId,
      status: 'revoked',
      distance: null,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return res.json({ message: 'Face enrollment revoked', client_id: clientId });
  } catch (err) {
    logger.error({ err: err.message }, '[checkin/enroll/delete] error');
    return next(err);
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /api/checkin/logs?date=YYYY-MM-DD&limit=N&status=STATUS
// ──────────────────────────────────────────────────────────────────
router.get('/logs', auth, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const date = req.query.date;
    const status = req.query.status;
    const params = [];
    const conds = ['1=1'];

    if (date) {
      params.push(date);
      conds.push(`l.created_at::date = $${params.length}`);
    }

    if (status) {
      params.push(status);
      conds.push(`l.status = $${params.length}`);
    }

    if (req.user.role === 'trainer' && req.user.trainer_id) {
      params.push(req.user.trainer_id);
      conds.push(`(c.trainer_id = $${params.length} OR l.client_id IS NULL)`);
    }

    const { rows } = await pool.query(
      `SELECT l.id, l.client_id, l.status, l.distance, l.created_at,
              c.name AS client_name, c.photo_url, c.member_code
         FROM face_checkin_logs l
    LEFT JOIN (${MEMBER_UNION_SQL}) c ON c.id = l.client_id
        WHERE ${conds.join(' AND ')}
        ORDER BY l.created_at DESC
        LIMIT $${params.length + 1}`,
      [...params, limit]
    );
    return res.json(rows);
  } catch (err) {
    logger.error({ err: err.message }, '[checkin/logs] error');
    return next(err);
  }
});

module.exports = router;

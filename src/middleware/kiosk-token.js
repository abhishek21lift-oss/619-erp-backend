// src/middleware/kiosk-token.js
//
// Kiosk-token authentication middleware (Blueprint §3.6).
//
// A wall-mounted iPad / kiosk should NOT carry a staff JWT — those have
// admin scope and 7-day expiry. Instead, each kiosk is provisioned with
// a long-lived bearer token that:
//
//   - is scoped to a single branch
//   - is scoped to a single endpoint (/api/checkin/face)
//   - can be revoked from the admin UI without rotating staff credentials
//
// The plaintext token is shown ONCE at issue time. The DB stores only
// SHA-256 of the token plus an 8-char prefix for human identification.

const crypto = require('crypto');
const pool   = require('../db/pool');

// H-05: HMAC-SHA256 prevents length-extension attacks on the token hash.
// KIOSK_HMAC_SECRET must be set in env (minimum 32 chars).
function hmacHex(s) {
  const secret = process.env.KIOSK_HMAC_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('KIOSK_HMAC_SECRET must be set and at least 32 characters');
  }
  return crypto.createHmac('sha256', secret).update(s, 'utf8').digest('hex');
}

/**
 * Express middleware. Mount BEFORE the regular `auth` middleware on
 * routes that should be reachable by kiosks AND by signed-in users:
 *
 *   router.post('/face', kioskOrUser, faceRoutes.handler);
 *
 * After this runs successfully:
 *   req.kiosk    = { id, branch_id, name, prefix }   (kiosk path)
 *   req.user     = { role: 'kiosk', branch_id, ... } (kiosk path)
 *
 * For non-kiosk requests, control falls through to the next middleware
 * unchanged so the regular `auth` JWT handler can take over.
 */
async function kioskTokenMiddleware(req, res, next) {
  const header = req.headers['x-kiosk-token'] || req.headers['authorization'];
  if (!header) return next();
  const raw = String(header).replace(/^Bearer\s+/i, '').trim();
  // Heuristic: kiosk tokens we issue have a 'k_' prefix to keep them
  // distinguishable from JWTs. JWTs always contain dots.
  if (!raw.startsWith('k_') || raw.includes('.')) return next();

  try {
    const hash = hmacHex(raw);
    const { rows } = await pool.query(
      `SELECT id, branch_id, name, token_prefix
         FROM kiosk_devices
        WHERE token_hash = $1
          AND is_active   = TRUE
          AND revoked_at IS NULL
        LIMIT 1`,
      [hash],
    );
    if (!rows[0]) {
      return res.status(401).json({ error: 'Invalid or revoked kiosk token' });
    }
    const kiosk = rows[0];

    // Update last_seen asynchronously — failures are non-fatal.
    pool.query(
      `UPDATE kiosk_devices
          SET last_seen_at = NOW(),
              last_seen_ip = $1,
              user_agent   = $2
        WHERE id = $3`,
      [req.ip || null, req.headers['user-agent'] || null, kiosk.id],
    ).catch(() => {});

    req.kiosk = kiosk;
    req.user  = {
      id:       'kiosk:' + kiosk.id,
      role:     'kiosk',
      branch_id: kiosk.branch_id,
      name:     kiosk.name,
    };
    return next();
  } catch (err) {
    // Only fail closed for actual errors; don't block staff JWT requests.
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[kiosk-token] verification error:', err.message);
    }
    return next();
  }
}

/**
 * Issue a fresh kiosk token. Returns the PLAINTEXT — the caller is
 * responsible for showing it to the admin once and never persisting it
 * elsewhere. The DB only stores the hash.
 */
async function issueKioskToken({ branchId, name, createdBy }) {
  const raw    = 'k_' + crypto.randomBytes(32).toString('hex'); // 64 hex chars after prefix
  const hash   = hmacHex(raw);
  const prefix = raw.slice(0, 10);
  const { rows } = await pool.query(
    `INSERT INTO kiosk_devices
        (branch_id, name, token_hash, token_prefix, created_by, is_active)
     VALUES ($1, $2, $3, $4, $5, TRUE)
     RETURNING id, branch_id, name, token_prefix, created_at`,
    [branchId, name, hash, prefix, createdBy || null],
  );
  return { token: raw, kiosk: rows[0] };
}

async function revokeKioskToken(id) {
  await pool.query(
    `UPDATE kiosk_devices SET is_active = FALSE, revoked_at = NOW() WHERE id = $1`,
    [id],
  );
}

module.exports = {
  kioskTokenMiddleware,
  issueKioskToken,
  revokeKioskToken,
  _internal: { hmacHex },
};

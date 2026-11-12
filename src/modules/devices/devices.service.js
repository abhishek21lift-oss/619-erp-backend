// src/modules/devices/devices.service.js
// The device registry behind push. A row is an FCM registration token and the
// account it belongs to, inside one tenant.
//
// Ownership is never taken from the request. `register` receives the user and
// organization that auth.js loaded from the database; the caller supplies only
// the token string. A token that already exists is moved to the current user,
// because Android reuses the same token for whoever is signed in on the device.

const pool = require('../../db/pool');

const MAX_TOKENS_PER_SEND = 20;

/** App identity is derived from the role, never trusted from the body. */
function appForRole(role) {
  if (role === 'member') return 'member';
  if (role === 'trainer') return 'studio';
  return null;
}

async function register({ userId, organizationId, role, token, platform = 'android' }) {
  const app = appForRole(role);
  // auth.js already refuses a tenant role without an organization; this keeps
  // the service honest for any future caller and fails closed.
  if (!app || !organizationId) {
    const err = new Error('A tenant account is required to register a device');
    err.status = 403;
    throw err;
  }

  const { rows } = await pool.query(
    `INSERT INTO device_tokens (user_id, organization_id, token, platform, app)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (token) DO UPDATE
        SET user_id         = EXCLUDED.user_id,
            organization_id = EXCLUDED.organization_id,
            platform        = EXCLUDED.platform,
            app             = EXCLUDED.app,
            last_seen_at    = NOW(),
            revoked_at      = NULL,
            revoked_reason  = NULL
     RETURNING id, app, created_at, last_seen_at`,
    [userId, organizationId, token, platform, app]
  );
  return rows[0];
}

/**
 * Revoke one token owned by this user. Deliberately silent when the token
 * belongs to somebody else or never existed: a logout must not become an
 * oracle for whether another account's token is registered.
 */
async function revoke({ userId, token, reason = 'logout' }) {
  await pool.query(
    `UPDATE device_tokens
        SET revoked_at = NOW(), revoked_reason = $3
      WHERE token = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [token, userId, reason]
  );
}

/**
 * Is this token still live for exactly this user and tenant?
 *
 * The sender calls this immediately before each FCM request. The initial
 * `activeTokens()` lookup is a snapshot; a shared device can be re-registered
 * to another account while the loop is running. Re-checking narrows that
 * window to the gap between this query and FCM accepting the message, and the
 * client invalidates the old token on an account switch for the rest.
 */
async function ownsToken({ userId, organizationId, token }) {
  if (!userId || !organizationId || !token) return false;
  const { rows } = await pool.query(
    `SELECT 1
       FROM device_tokens
      WHERE token = $1
        AND user_id = $2
        AND organization_id = $3
        AND revoked_at IS NULL
      LIMIT 1`,
    [token, userId, organizationId]
  );
  return rows.length > 0;
}

/**
 * Revoke tokens FCM has told us are dead (UNREGISTERED / wrong project).
 */
async function revokeDead(tokens, reason = 'fcm_invalid') {
  if (!tokens.length) return 0;
  const { rowCount } = await pool.query(
    `UPDATE device_tokens
        SET revoked_at = NOW(), revoked_reason = $2
      WHERE token = ANY($1::text[]) AND revoked_at IS NULL`,
    [tokens, reason]
  );
  return rowCount;
}

/**
 * Live devices for one recipient, inside one tenant.
 *
 * The organization filter is not decorative: a user id is unique, but a token
 * must never be reached through a tenant the sender does not own. Both values
 * come from the authenticated recipient, never from a request body.
 */
async function activeTokens({ userId, organizationId }) {
  if (!userId || !organizationId) return [];
  const { rows } = await pool.query(
    `SELECT token, app
       FROM device_tokens
      WHERE user_id = $1
        AND organization_id = $2
        AND revoked_at IS NULL
      ORDER BY last_seen_at DESC
      LIMIT $3`,
    [userId, organizationId, MAX_TOKENS_PER_SEND]
  );
  return rows;
}

module.exports = { register, revoke, revokeDead, activeTokens, ownsToken, appForRole };

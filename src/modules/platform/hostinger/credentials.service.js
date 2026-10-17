'use strict';
// The Hostinger API credential: connect, verify, rotate, revoke.
//
// ── The state machine, because the console needs to say which one it is ─────
//
//   not_configured  HOSTINGER_TOKEN_KEY is absent. The module is inert; the
//                   console offers a connect prompt, not an error.
//   not_connected   the key is present and no live credential exists.
//   connected       a live credential exists and decrypts.
//   unreadable      a row exists and will not decrypt — almost always the key
//                   was rotated without re-entering the token. This is its own
//                   state because the remedy is different from "connect": the
//                   operator must paste the token again, and telling them
//                   "not connected" would send them looking for a bug.
//
// Every write here is a single transaction. Rotation especially: the partial
// unique index on `status` allows exactly one live row, so "revoke the old one"
// and "insert the new one" have to be one unit or a failure between them leaves
// the platform with no credential at all.

const { pool, logger } = require('../super-admin/shared');
const crypto = require('../../../lib/hostinger/crypto');
const hostinger = require('../../../lib/hostinger/client');

/**
 * The read used to prove a token works.
 *
 * Chosen because it is the least invasive call in the catalogue: a paginated
 * list of the account's own websites, one item, no parameters. A verification
 * that restarted something would be a verification nobody runs.
 */
const VERIFY_OPERATION = 'hosting.website.list';

/** An error the route maps to a status. Carries a code so the UI can branch. */
class HostingerError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** The current state, described without the token. Safe for the browser. */
async function status() {
  const base = {
    key_configured: crypto.isConfigured(),
    key_problem: crypto.keyProblem(),
    state: 'not_configured',
    credential: null,
  };
  if (base.key_problem) {
    // Set but malformed. The process refuses to boot in production; in
    // development the console should still explain the state.
    base.state = 'not_configured';
    return base;
  }
  if (!base.key_configured) return base;

  const { rows } = await pool.query(
    `SELECT id, label, token_hint, token_fingerprint, status, created_at, rotated_at,
            revoked_at, last_verified_at, last_verified_status, last_error
       FROM platform_hostinger_credentials
      WHERE status = 'active'
      ORDER BY created_at DESC
      LIMIT 1`
  );
  base.state = rows.length ? 'connected' : 'not_connected';
  if (!rows.length) return base;

  const row = rows[0];
  let readable = true;
  try {
    crypto.decryptToken(
      (await pool.query('SELECT token_ciphertext FROM platform_hostinger_credentials WHERE id = $1', [row.id])).rows[0].token_ciphertext
    );
  } catch (err) {
    readable = false;
    logger.error({ err: err.message, credential: row.id }, 'hostinger credential does not decrypt');
  }

  base.state = readable ? 'connected' : 'unreadable';
  base.credential = {
    id: row.id,
    label: row.label,
    hint: row.token_hint,
    fingerprint: row.token_fingerprint,
    created_at: row.created_at,
    rotated_at: row.rotated_at,
    last_verified_at: row.last_verified_at,
    last_verified_status: row.last_verified_status,
    last_error: row.last_error,
    readable,
  };
  return base;
}

/** The decrypted token, for the operation services. Throws when unusable. */
async function activeToken() {
  if (!crypto.isConfigured()) {
    throw new HostingerError(409, 'HOSTINGER_NOT_CONFIGURED', 'The Hostinger integration is not configured on this server (HOSTINGER_TOKEN_KEY is unset).');
  }
  const { rows } = await pool.query(
    `SELECT id, token_ciphertext FROM platform_hostinger_credentials WHERE status = 'active' ORDER BY created_at DESC LIMIT 1`
  );
  if (!rows.length) {
    throw new HostingerError(409, 'HOSTINGER_NOT_CONNECTED', 'No Hostinger API token is connected.');
  }
  try {
    return { token: crypto.decryptToken(rows[0].token_ciphertext), credentialId: rows[0].id };
  } catch (err) {
    await recordVerificationFailure('The stored credential could not be decrypted with the current HOSTINGER_TOKEN_KEY.', err.message);
    throw new HostingerError(409, 'HOSTINGER_CREDENTIAL_UNREADABLE', 'The stored Hostinger credential cannot be decrypted. Re-enter the API token to fix this.');
  }
}

/**
 * Prove a token works against the live API.
 *
 * Returns the result rather than throwing so a caller can report *why* it
 * failed — a 401 means the token is wrong, a network error means we never
 * asked. Only a 2xx counts as verified; a 200 is the whole evidence.
 */
async function verifyToken(token) {
  const result = await hostinger.call({ operationId: VERIFY_OPERATION, query: { per_page: 1 }, token });
  if (result.ok) return { ok: true };
  return {
    ok: false,
    status: result.status,
    message: result.status === 401
      ? 'Hostinger rejected this API token. Check that it is current and belongs to the account you mean to manage.'
      : result.error.message,
    code: result.error.code,
  };
}

/** Record the outcome of a live check. Never throws — bookkeeping must not mask the answer. */
async function recordVerification(credentialId, outcome) {
  try {
    await pool.query(
      `UPDATE platform_hostinger_credentials
          SET last_verified_at = now(), last_verified_status = $2, last_error = $3
        WHERE id = $1`,
      [credentialId, outcome.ok ? 'ok' : 'failed', outcome.ok ? null : String(outcome.message || '').slice(0, 400)]
    );
  } catch (err) {
    logger.warn({ err: err.message, credential: credentialId }, 'hostinger verification bookkeeping failed');
  }
}

async function recordVerificationFailure(message, detail) {
  try {
    await pool.query(
      `UPDATE platform_hostinger_credentials
          SET last_verified_at = now(), last_verified_status = 'failed', last_error = $1
        WHERE status = 'active'`,
      [`${message}${detail ? ` (${String(detail).slice(0, 200)})` : ''}`.slice(0, 400)]
    );
  } catch (err) {
    logger.warn({ err: err.message }, 'hostinger verification-failure bookkeeping failed');
  }
}

/**
 * Store a token, after proving it works.
 *
 * Verification comes first: a token that was mistyped, expired or belongs to
 * the wrong account never reaches the table, so "connected" in the console
 * always means "this token answered a real request".
 *
 * Re-entering the SAME token (same fingerprint) is not a new connection; it
 * returns the existing row. Otherwise an operator clicking Connect twice gets
 * a rotation and a second row's worth of audit noise.
 */
async function connect({ token, label, actorId }) {
  if (!crypto.isConfigured()) {
    throw new HostingerError(409, 'HOSTINGER_NOT_CONFIGURED', 'The Hostinger integration is not configured on this server (HOSTINGER_TOKEN_KEY is unset).');
  }
  const value = String(token || '').trim();
  if (value.length < 20) {
    throw new HostingerError(400, 'HOSTINGER_TOKEN_INVALID', 'That does not look like a Hostinger API token.');
  }

  const fingerprint = crypto.fingerprint(value);
  const current = await status();
  if (current.credential && current.credential.fingerprint === fingerprint && current.state === 'connected') {
    return { state: 'connected', unchanged: true, credential: current.credential };
  }

  const check = await verifyToken(value);
  if (!check.ok) {
    throw new HostingerError(
      check.status === 401 ? 401 : 502,
      check.code === 'NETWORK' || check.code === 'TIMEOUT' ? 'HOSTINGER_UNREACHABLE' : 'HOSTINGER_TOKEN_REJECTED',
      check.message
    );
  }

  const envelope = crypto.encryptToken(value);
  const hint = crypto.maskToken(value);
  const name = String(label || '').trim().slice(0, 80) || 'Hostinger API token';

  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    // Retire whatever was live. Within the transaction, so a crash between the
    // two statements cannot leave zero live rows or two.
    await tx.query(
      `UPDATE platform_hostinger_credentials
          SET status = 'revoked', revoked_at = now(), revoked_by = $1
        WHERE status = 'active'`,
      [actorId || null]
    );
    const { rows } = await tx.query(
      `INSERT INTO platform_hostinger_credentials
         (label, token_ciphertext, token_fingerprint, token_hint, created_by, last_verified_at, last_verified_status)
       VALUES ($1,$2,$3,$4,$5, now(), 'ok')
       RETURNING id, label, token_hint, token_fingerprint, created_at`,
      [name, envelope, fingerprint, hint, actorId || null]
    );
    await tx.query('COMMIT');
    logger.info({ credential: rows[0].id, hint }, 'hostinger credential connected');
    return { state: 'connected', unchanged: false, credential: { ...rows[0], readable: true } };
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}

/** Rotate: verify the new token, then swap it in as one unit. */
async function rotate({ token, label, actorId }) {
  const result = await connect({ token, label, actorId });
  if (!result.unchanged) {
    await pool.query(
      `UPDATE platform_hostinger_credentials SET rotated_at = now() WHERE status = 'active'`
    );
  }
  return result;
}

/** Revoke the live credential. The row stays: the history is the point. */
async function revoke({ actorId }) {
  const { rows } = await pool.query(
    `UPDATE platform_hostinger_credentials
        SET status = 'revoked', revoked_at = now(), revoked_by = $1
      WHERE status = 'active'
      RETURNING id, label, token_hint`,
    [actorId || null]
  );
  if (!rows.length) {
    throw new HostingerError(409, 'HOSTINGER_NOT_CONNECTED', 'There is no connected Hostinger credential to revoke.');
  }
  logger.warn({ credential: rows[0].id }, 'hostinger credential revoked');
  return rows[0];
}

/** Every credential ever stored, newest first. Masked values only. */
async function history({ limit = 50 } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const { rows } = await pool.query(
    `SELECT c.id, c.label, c.token_hint, c.token_fingerprint, c.status, c.created_at,
            c.rotated_at, c.revoked_at, c.last_verified_at, c.last_verified_status, c.last_error,
            u.name AS created_by_name, r.name AS revoked_by_name
       FROM platform_hostinger_credentials c
       LEFT JOIN users u ON u.id = c.created_by
       LEFT JOIN users r ON r.id = c.revoked_by
      ORDER BY c.created_at DESC
      LIMIT $1`,
    [capped]
  );
  return rows;
}

/** Re-run the live check for the connected token and record the outcome. */
async function reverify() {
  const { token, credentialId } = await activeToken();
  const outcome = await verifyToken(token);
  await recordVerification(credentialId, outcome);
  return outcome;
}

module.exports = {
  HostingerError,
  VERIFY_OPERATION,
  status,
  activeToken,
  verifyToken,
  connect,
  rotate,
  revoke,
  history,
  reverify,
  recordVerification,
};

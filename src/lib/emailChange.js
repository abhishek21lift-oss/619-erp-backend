'use strict';
// Re-authentication for changing an account's sign-in email.
//
// The email is the account's identity: password reset is sent to it and
// Google sign-in (routes/auth-google.js) matches on it. Writing it on the
// strength of a session alone meant anyone holding a session — a stolen
// cookie, an unlocked laptop — could point the account at an address they
// control and keep it for good. So a CHANGE of email needs the current
// password and is refused outright under impersonation.
//
// The SQL lives here rather than in routes/profile.js, which is on the
// layering ratchet (architecture.layering.convention.test.js).

const bcrypt = require('bcryptjs');
const pool = require('../db/pool');

/**
 * The account's current email (normalised) and password hash, read from the
 * database rather than req.user — the session row is cached, and this is what
 * decides whether re-authentication is needed.
 *
 * @returns {Promise<{email:string, passwordHash:string|null}|null>}
 */
async function loadAccount(userId) {
  const { rows } = await pool.query(
    'SELECT email, password FROM users WHERE id = $1 AND deleted_at IS NULL',
    [userId]
  );
  if (!rows[0]) return null;
  return {
    email: String(rows[0].email || '').trim().toLowerCase(),
    passwordHash: rows[0].password || null,
  };
}

/** Whether another live account already uses this address. */
async function emailTaken(email, exceptUserId) {
  const { rows } = await pool.query(
    'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id <> $2 AND deleted_at IS NULL',
    [email, exceptUserId]
  );
  return rows.length > 0;
}

/**
 * Why this request may not change the email, or null when it may.
 *
 * @param {{impersonation?: object}} req
 * @param {string} suppliedPassword  what the caller typed, '' when absent
 * @param {string|null} passwordHash
 * @returns {Promise<{code:string, message:string}|null>}
 */
async function refusal(req, suppliedPassword, passwordHash) {
  if (req.impersonation) {
    return {
      code: 'EMAIL_CHANGE_IMPERSONATION',
      message: "An account's sign-in email cannot be changed while impersonating it.",
    };
  }
  if (!suppliedPassword) {
    return { code: 'REAUTH_REQUIRED', message: 'Enter your current password to change your email.' };
  }
  const valid = passwordHash ? await bcrypt.compare(suppliedPassword, passwordHash) : false;
  return valid ? null : { code: 'REAUTH_FAILED', message: 'Current password is incorrect.' };
}

module.exports = { loadAccount, emailTaken, refusal };

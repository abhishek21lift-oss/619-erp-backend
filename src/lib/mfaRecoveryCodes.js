'use strict';
// MFA recovery codes: issue, store, redeem.
//
// One module because the format has to be agreed by two places that are
// otherwise far apart — POST /profile/mfa/verify, which issues them, and
// POST /auth/login, which redeems them. They previously disagreed
// completely: enrolment minted eight hex codes and login validated
// mfa_code as /^\d{6}$/, so a recovery code was rejected as malformed
// before anything looked it up. Nothing stored them either, so there was
// nothing to look up. Both halves of that are fixed here, in one place, so
// they cannot drift apart again.
//
// ── The shape of a code ─────────────────────────────────────────────────
//
// Ten Crockford-base32 characters, displayed in two groups of five:
//
//     H4K2M-9PQR7
//
// Crockford's alphabet omits I, L, O and U, which removes the 1/I/l and
// 0/O confusions that matter when somebody is reading a code off paper
// after losing their phone — the exact situation these exist for. It also
// means normalise() can map the mistakes people still make (I→1, O→0)
// rather than rejecting them.
//
// 10 characters over a 32-symbol alphabet is 50 bits. Well past guessing,
// and every attempt goes through login's existing rate limiter anyway.

const crypto = require('node:crypto');

/** Crockford base32: no I, L, O or U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LEN = 10;
const CODE_COUNT = 8;

/**
 * Canonical form for comparison: upper-cased, separators dropped, and the
 * two substitutions a person reading handwriting actually makes.
 *
 * Applied identically when issuing and when redeeming, so a code typed as
 * "h4k2m-9pqr7" or "H4K2M 9PQR7" hashes to the same digest as the one that
 * was stored.
 */
function normalise(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/I/g, '1')
    .replace(/L/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');
}

/** True if `raw` could be a recovery code at all — used to route login input. */
function looksLikeRecoveryCode(raw) {
  const n = normalise(raw);
  return n.length === CODE_LEN && [...n].every((c) => ALPHABET.includes(c));
}

/**
 * SHA-256 hex of the normalised code.
 *
 * Not bcrypt: see migration 169. These are 50 bits of crypto.randomBytes,
 * not a human-chosen password, so the reason to use a slow KDF does not
 * apply — and a slow one would be harmful, since redemption is a hot path
 * on a login.
 */
function hashCode(raw) {
  return crypto.createHash('sha256').update(normalise(raw)).digest('hex');
}

/** Eight fresh codes, in display form. Never stored in this form. */
function generateCodes(count = CODE_COUNT) {
  const codes = [];
  for (let i = 0; i < count; i += 1) {
    let code = '';
    // rejection-free: randomInt over the alphabet length is already uniform.
    for (let c = 0; c < CODE_LEN; c += 1) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
    codes.push(`${code.slice(0, 5)}-${code.slice(5)}`);
  }
  return codes;
}

/**
 * Replace this user's codes with a fresh set, and return the plaintext ONCE.
 *
 * Old codes are deleted rather than marked used: re-enrolling is the point
 * at which a previous set stops being trustworthy — the user may be
 * re-enrolling precisely because the old ones leaked.
 *
 * The caller is responsible for showing the returned codes to the user; they
 * cannot be recovered afterwards, by design, because only their digests are
 * kept.
 */
async function issueForUser(db, userId, count = CODE_COUNT) {
  const codes = generateCodes(count);
  await db.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
  await db.query(
    `INSERT INTO mfa_recovery_codes (user_id, code_hash)
     SELECT $1, unnest($2::text[])`,
    [userId, codes.map(hashCode)]
  );
  return codes;
}

/**
 * Spend a code. Returns true only if it was this user's and unused.
 *
 * The UPDATE is the check: `used_at IS NULL` in the WHERE clause means two
 * concurrent logins presenting the same code cannot both succeed — the
 * second matches no row. Doing this as SELECT-then-UPDATE would leave
 * exactly that race open on the one credential that exists because
 * something has already gone wrong.
 */
async function redeem(db, userId, raw) {
  if (!looksLikeRecoveryCode(raw)) return false;
  const { rowCount } = await db.query(
    `UPDATE mfa_recovery_codes
        SET used_at = NOW()
      WHERE user_id = $1
        AND code_hash = $2
        AND used_at IS NULL`,
    [userId, hashCode(raw)]
  );
  return rowCount === 1;
}

/** How many codes this user has left. For display only. */
async function remainingForUser(db, userId) {
  const { rows } = await db.query(
    'SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL',
    [userId]
  );
  return rows[0] ? rows[0].n : 0;
}

module.exports = {
  ALPHABET, CODE_LEN, CODE_COUNT,
  normalise, looksLikeRecoveryCode, hashCode,
  generateCodes, issueForUser, redeem, remainingForUser,
};

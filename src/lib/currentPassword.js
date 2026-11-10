// Re-checking the signed-in account's own password before a security change.
//
// Two self-service routes need this: changing the password and disabling MFA.
// Both used to carry the same SELECT and bcrypt compare inline, which pushed
// the HTTP adapter's SQL budget over its recorded limit. The query belongs
// here, with the comparison it exists for.
'use strict';

const bcrypt = require('bcryptjs');
const pool = require('../db/pool');

/**
 * @returns {Promise<boolean|null>} true when the password matches, false when
 *   it does not, null when the account no longer exists.
 */
async function verifyCurrentPassword(userId, supplied, db = pool) {
  const { rows } = await db.query('SELECT password FROM users WHERE id = $1', [userId]);
  if (!rows[0]?.password) return null;
  return bcrypt.compare(String(supplied || ''), rows[0].password);
}

module.exports = { verifyCurrentPassword };

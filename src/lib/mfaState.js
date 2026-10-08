'use strict';
// The caller's two-factor state, for the checks that guard changing it
// (routes/profile.js). Kept out of the route by the layering rule.

const pool = require('../db/pool');

/** @returns {Promise<{ mfa_enabled: boolean, mfa_secret: string|null } | null>} */
async function mfaStateFor(userId) {
  const { rows: [row] } = await pool.query(
    'SELECT mfa_enabled, mfa_secret FROM user_profiles WHERE user_id = $1',
    [userId],
  );
  return row || null;
}

module.exports = { mfaStateFor };

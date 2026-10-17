'use strict';
// src/modules/pt-os/parq.repository.js
// Reads for the PAR-Q adapter (parq.routes.js), which by the layering rule
// holds no new SQL of its own.
const pool = require('../../db/pool');

/**
 * The latest consent record a form has produced, or null.
 *
 * The signing route reads it to tell a retry — the same two signatures
 * arriving twice — from a genuinely new signing.
 *
 * @returns {Promise<object|null>}
 */
async function latestConsent(parqFormId, orgId) {
  const { rows } = await pool.query(
    `SELECT * FROM pt_consent_records
      WHERE parq_form_id = $1 AND organization_id = $2
      ORDER BY created_at DESC LIMIT 1`,
    [parqFormId, orgId]
  );
  return rows[0] || null;
}

module.exports = { latestConsent };

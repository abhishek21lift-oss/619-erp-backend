'use strict';
// src/modules/pt-os/informed-consent.repository.js
// Reads for the Informed Consent adapter (informed-consent.routes.js), which
// by the layering rule holds no new SQL of its own.
const pool = require('../../db/pool');

/**
 * Every consent a client has in this studio, newest first — enough to tell
 * whether a live one exists and which version a new one follows.
 *
 * @returns {Promise<Array<{ id: string, status: string, version: number }>>}
 */
async function consentVersions(clientId, orgId) {
  const { rows } = await pool.query(
    `SELECT id, status, version FROM pt_informed_consents
      WHERE client_id = $1 AND organization_id = $2
      ORDER BY created_at DESC`,
    [clientId, orgId]
  );
  return rows;
}

module.exports = { consentVersions };

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

/**
 * Complete a fully signed consent — exactly once.
 *
 * Two signers finishing at once both see "both signed, not completed"; the
 * status guard lets only one of them complete the record, so one PDF is
 * generated and one completion logged. The other gets the record as it now
 * stands and `completed: false`.
 *
 * @returns {Promise<{ completed: boolean, record: object }>}
 */
async function completeConsent(id, { ip, device, browser }) {
  const { rows: [done] } = await pool.query(
    `UPDATE pt_informed_consents
        SET status = 'completed', completed_at = NOW(), ip_address = $2, device = $3, browser = $4, updated_at = NOW()
      WHERE id = $1 AND status <> 'completed' RETURNING *`,
    [id, ip, device, browser]
  );
  if (done) return { completed: true, record: done };
  const { rows: [current] } = await pool.query('SELECT * FROM pt_informed_consents WHERE id = $1', [id]);
  return { completed: false, record: current };
}

module.exports = { consentVersions, completeConsent };

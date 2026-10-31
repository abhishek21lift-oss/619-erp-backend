'use strict';
// src/modules/pt-os/churn.repository.js
// Reads and writes for the churn-risk list (churn.service.js). No LIMIT on the
// roster or on the follow-up lookup: the roster is the authority for who is
// assessed, and visibility must see every current mark. The 100-row cap on the
// response's `handled` list is applied in the service, after visibility.
const pool = require('../../db/pool');

/** Every live client in the studio, unscored and unpaged. */
async function listRoster(orgId) {
  const { rows } = await pool.query(
    `SELECT id, name, mobile, balance_amount, pt_end_date, status
       FROM pt_clients
      WHERE organization_id = $1 AND deleted_at IS NULL
      ORDER BY name`,
    [orgId]
  );
  return rows;
}

/**
 * The newest follow-up per client, whatever its `hide_until`.
 *
 * Visibility is the service's decision. Filtering by date *before*
 * `DISTINCT ON` would skip a newer mark that has expired and resurrect an
 * older, longer snooze behind it — hiding the client for weeks after the
 * trainer's latest action ran out.
 *
 * `hide_until` is returned as text: a DATE arrives as a JS Date and
 * `String(date).slice(0, 10)` is not a calendar day. The service compares
 * day strings in studio time.
 */
async function latestFollowups(orgId) {
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (client_id)
              client_id, outcome, to_char(hide_until, 'YYYY-MM-DD') AS hide_until,
              risk_score, note, created_at
         FROM pt_client_followups
        WHERE organization_id = $1
        ORDER BY client_id, created_at DESC
     ) latest
     ORDER BY hide_until, client_id`,
    [orgId]
  );
  return rows;
}

/** The FK on client_id does not imply the tenant; this check does. */
async function clientInOrg(orgId, clientId) {
  const { rows } = await pool.query(
    `SELECT id FROM pt_clients
      WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
    [clientId, orgId]
  );
  return rows.length > 0;
}

/** Append a mark and return it with the same date contract as the read. */
async function create({ orgId, clientId, outcome, hideUntil, riskScore, note }) {
  const { rows: [row] } = await pool.query(
    `INSERT INTO pt_client_followups
            (organization_id, client_id, outcome, hide_until, risk_score, note)
     VALUES ($1, $2, $3, $4::date, $5, $6)
     RETURNING id, client_id, outcome, to_char(hide_until, 'YYYY-MM-DD') AS hide_until,
               risk_score, note, created_at`,
    [orgId, clientId, outcome, hideUntil, riskScore, note ?? null]
  );
  return row;
}

module.exports = { listRoster, latestFollowups, clientInOrg, create };

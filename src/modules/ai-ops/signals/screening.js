'use strict';

// Screening completeness. One row per active/frozen client, carrying the
// latest PAR-Q, consent and clearance via LATERAL joins. A missing row and a
// draft both mean "not cleared"; only submitted/reviewed PAR-Q and completed
// consent clear the check.

const pool = require('../../../db/pool');
const { formatDay } = require('./dates');

const CLIENT_STATUSES = new Set(['active', 'frozen']);

function reasonsFromScreening(rows, today) {
  const out = [];
  for (const row of rows || []) {
    if (!row || !row.client_id || !CLIENT_STATUSES.has(row.client_status)) continue;
    const subject = { type: 'client', id: row.client_id, name: row.name, photo_url: row.photo_url ?? null };

    if (!row.parq_id || row.parq_status === 'draft') {
      out.push({
        subject,
        reason: {
          code: 'parq_missing',
          label: row.parq_id ? 'PAR-Q is still a draft' : 'No PAR-Q on file',
          evidence: { parq_id: row.parq_id ?? null },
          due_at: null,
        },
      });
    }

    if (!row.consent_id || row.consent_status !== 'completed') {
      out.push({
        subject,
        reason: {
          code: 'consent_missing',
          label: row.consent_id ? 'Informed consent is not signed' : 'No informed consent on file',
          evidence: { consent_id: row.consent_id ?? null, consent_status: row.consent_status ?? null },
          due_at: null,
        },
      });
    }

    if (row.approval_status === 'approved' && row.expiry_date && row.expiry_date < today) {
      out.push({
        subject,
        reason: {
          code: 'clearance_expired',
          label: `Medical clearance expired ${formatDay(row.expiry_date)}`,
          evidence: { clearance_id: row.clearance_id ?? null, expiry_date: row.expiry_date },
          due_at: null,
        },
      });
    }
  }
  return out;
}

async function collect({ orgId, today }) {
  const { rows } = await pool.query(
    `SELECT c.id AS client_id, c.name, c.photo_url, c.status AS client_status,
            p.id AS parq_id, p.status AS parq_status,
            ic.id AS consent_id, ic.status AS consent_status,
            mc.id AS clearance_id, mc.approval_status, mc.expiry_date::TEXT AS expiry_date
       FROM pt_clients c
       LEFT JOIN LATERAL (
         SELECT id, status FROM pt_parq_forms
          WHERE client_id = c.id AND organization_id = c.organization_id
            AND deleted_at IS NULL
          ORDER BY assessment_date DESC, created_at DESC LIMIT 1
       ) p ON TRUE
       LEFT JOIN LATERAL (
         SELECT id, status FROM pt_informed_consents
          WHERE client_id = c.id AND organization_id = c.organization_id
          ORDER BY version DESC, created_at DESC LIMIT 1
       ) ic ON TRUE
       LEFT JOIN LATERAL (
         SELECT id, approval_status, expiry_date FROM pt_medical_clearances
          WHERE client_id = c.id AND organization_id = c.organization_id
          ORDER BY created_at DESC LIMIT 1
       ) mc ON TRUE
      WHERE c.organization_id = $1
        AND c.deleted_at IS NULL
        AND c.status IN ('active','frozen')`,
    [orgId],
  );
  return reasonsFromScreening(rows, today);
}

module.exports = { collect, reasonsFromScreening };

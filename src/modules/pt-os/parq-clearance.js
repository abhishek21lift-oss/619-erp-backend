'use strict';
// src/modules/pt-os/parq-clearance.js
const pool = require('../../db/pool');

// An approved clearance is what lets a high-risk client train, so it has to
// rest on something a reviewer could check later: the doctor, the date they
// cleared the client, and the certificate itself — a certificate_url or a
// document uploaded against this form. Without this a single click marked any
// client "cleared" with nothing on file.
async function clearanceApprovalProblem(formId, c) {
  if (c.approval_status !== 'approved') return null;
  if (!c.doctor_name || !String(c.doctor_name).trim()) return 'Doctor name is required to approve a clearance.';
  if (!c.clearance_date) return 'Clearance date is required to approve a clearance.';
  const cleared = Date.parse(c.clearance_date);
  if (Number.isNaN(cleared)) return 'Clearance date is not a valid date.';
  if (cleared > Date.now() + 86400000) return 'Clearance date cannot be in the future.';
  if (c.expiry_date) {
    const expires = Date.parse(c.expiry_date);
    if (Number.isNaN(expires) || expires < cleared) return 'Expiry date must be on or after the clearance date.';
  }
  if (c.certificate_url && String(c.certificate_url).trim()) return null;
  const { rowCount } = await pool.query(
    `SELECT 1 FROM pt_parq_documents WHERE parq_form_id = $1 AND doc_type IN ('medical_certificate', 'medical_report') LIMIT 1`,
    [formId]
  );
  return rowCount ? null : 'Upload the medical certificate (or link it) before approving the clearance.';
}

module.exports = { clearanceApprovalProblem };

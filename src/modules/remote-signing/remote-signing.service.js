'use strict';
// src/modules/remote-signing/remote-signing.service.js
// Database access for remote screening links — both sides of them.
//
//   routes/form-links.js     the trainer issues a link; it needs the client
//                            and studio name the email is written from.
//   routes/form-signing.js   the client submits; one transaction writes the
//                            PAR-Q, its consent record and the informed
//                            consent.
//
// Both adapters are HTTP only — the layering rule keeps SQL out of them, and
// every query below takes the caller's transaction so the public submission
// stays one atomic write.

const pool = require('../../db/pool');

/** The client a link is being issued for, with the studio name the email
 *  signs off with. Scoped to the trainer's own organization. */
async function clientForLink(clientId, orgId, { client = pool } = {}) {
  const { rows } = await client.query(
    `SELECT c.id, c.name, c.email, c.trainer_name, o.name AS studio_name
       FROM pt_clients c
       LEFT JOIN organizations o ON o.id = c.organization_id
      WHERE c.id = $1 AND c.organization_id = $2 AND c.deleted_at IS NULL`,
    [clientId, orgId]
  );
  return rows[0] || null;
}

/**
 * Write everything one remote signature attests to, inside the caller's
 * transaction.
 *
 * @returns {Promise<{ formId: string, consentRecordId: string, informedConsentId: string|null }>}
 */
async function writeSignedForms(tx, link, b, analysis, bmi, { device, browser, ip }) {
  // Same per-client serialisation as the trainer's POST: assessment_number
  // is "this client's Nth PAR-Q".
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`parq:${link.client_id}`]);
  const { rows } = await tx.query(
    `INSERT INTO pt_parq_forms (
       client_id, assessment_date, assessment_number,
       full_name, gender, dob, mobile, email, emergency_contact, emergency_phone,
       height_cm, weight_kg, bmi, trainer_name,
       current_health, past_history, parq_answers, parq_yes_count,
       risk_level, risk_message, status, workout_gate_status,
       created_by, organization_id
     ) VALUES (
       $1, CURRENT_DATE,
       (SELECT COALESCE(MAX(assessment_number), 0) + 1 FROM pt_parq_forms WHERE client_id = $1 AND deleted_at IS NULL),
       $2,$3,$4,$5,$6,$7,$8,
       $9,$10,$11,$12,
       $13::jsonb,$14::jsonb,$15::jsonb,$16,
       $17,$18,'submitted',$19,
       $20,$21
     ) RETURNING id`,
    [
      link.client_id, link.client_name, link.gender || null, link.dob || null,
      link.mobile || null, link.email || null,
      link.emergency_contact || null, link.emergency_phone || null,
      b.height_cm ?? null, b.weight_kg ?? null, bmi, link.trainer_name || null,
      b.current_health ? JSON.stringify(b.current_health) : null,
      b.past_history ? JSON.stringify(b.past_history) : null,
      JSON.stringify(b.parq_answers), analysis.yesCount,
      analysis.riskLevel, analysis.riskMessage, gateStatusFor(analysis),
      link.created_by || null, link.organization_id,
    ]
  );
  const formId = rows[0].id;

  for (const fh of (b.family_history || [])) {
    await tx.query(
      `INSERT INTO pt_family_medical_history (
         parq_form_id, relation, heart_disease, diabetes, stroke, hypertension, cancer,
         hyperlipidemia, kidney_disease, sudden_death, age_of_onset, notes
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        formId, fh.relation,
        Boolean(fh.heart_disease), Boolean(fh.diabetes), Boolean(fh.stroke), Boolean(fh.hypertension),
        Boolean(fh.cancer), Boolean(fh.hyperlipidemia), Boolean(fh.kidney_disease), Boolean(fh.sudden_death),
        fh.age_of_onset ?? null, fh.notes || null,
      ]
    );
  }

  const { rows: consentRows } = await tx.query(
    `INSERT INTO pt_consent_records (
       parq_form_id, client_id, consent_checkboxes, client_signature,
       client_signed_at, ip_address, device, browser, organization_id
     ) VALUES ($1,$2,$3::jsonb,$4,NOW(),$5,$6,$7,$8) RETURNING id`,
    [
      formId, link.client_id, JSON.stringify({ info_true: true }),
      b.signature, ip, device, browser, link.organization_id,
    ]
  );
  const consentRecordId = consentRows[0].id;

  const informedConsentId = await signInformedConsent(tx, link, b, { device, browser, ip });
  return { formId, consentRecordId, informedConsentId };
}

function gateStatusFor(analysis) {
  return analysis.riskLevel === 'high' ? 'blocked' : 'cleared';
}

// Writes the informed consent, or returns null when the client already has a
// completed one. A live draft is signed in place; a completed consent is
// history and must not be rewritten by a second link.
async function signInformedConsent(tx, link, b, { device, browser, ip }) {
  const { rows: prior } = await tx.query(
    `SELECT id, status, version FROM pt_informed_consents
      WHERE client_id = $1 AND organization_id = $2
      ORDER BY created_at DESC`,
    [link.client_id, link.organization_id]
  );
  const active = prior.find((r) => !['archived', 'revoked', 'expired'].includes(r.status));
  if (active?.status === 'completed') return null;

  if (active) {
    const { rows } = await tx.query(
      `UPDATE pt_informed_consents SET
         acknowledgements = $2::jsonb,
         physician_advised_against = $3, physician_name = $4,
         hospital = $5, medical_condition = $6,
         exercise_consent_text = $7, exercise_consent_checked = TRUE,
         exercise_consent_date = CURRENT_DATE, exercise_consent_signature = $8,
         client_signature = $8, client_signed_at = NOW(),
         ip_address = $9, device = $10, browser = $11, updated_at = NOW()
       WHERE id = $1 AND status NOT IN ('completed', 'archived', 'revoked', 'expired')
       RETURNING id`,
      [
        active.id, JSON.stringify(b.acknowledgements), b.physician_advised_against ?? null,
        b.physician_name || null, b.hospital || null, b.medical_condition || null,
        b.exercise_consent_text, b.signature, ip, device, browser,
      ]
    );
    return rows[0]?.id ?? null;
  }

  const version = prior.reduce((max, r) => Math.max(max, Number(r.version) || 1), 0) + 1;
  const previous = prior.find((r) => r.status !== 'archived') || prior[0] || null;
  const { rows } = await tx.query(
    `INSERT INTO pt_informed_consents (
       client_id, trainer_id, status, version, previous_version_id,
       full_name, gender, dob, mobile, email, emergency_contact, emergency_phone, address, occupation,
       acknowledgements, physician_advised_against, physician_name, hospital, medical_condition,
       exercise_consent_text, exercise_consent_checked, exercise_consent_date, exercise_consent_signature,
       client_signature, client_signed_at, ip_address, device, browser,
       created_by, organization_id
     ) VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
       $14::jsonb,$15,$16,$17,$18,$19,TRUE,CURRENT_DATE,$20,$20,NOW(),$21,$22,$23,$24,$25)
     RETURNING id`,
    [
      link.client_id, link.trainer_id || null, version, previous ? previous.id : null,
      link.client_name, link.gender || null, link.dob || null, link.mobile || null,
      link.email || null, link.emergency_contact || null, link.emergency_phone || null,
      link.address || null, link.occupation || null,
      JSON.stringify(b.acknowledgements), b.physician_advised_against ?? null,
      b.physician_name || null, b.hospital || null, b.medical_condition || null,
      b.exercise_consent_text, b.signature,
      ip, device, browser, link.created_by || null, link.organization_id,
    ]
  );
  return rows[0]?.id ?? null;
}

/** The two rows the PDF is rendered from, after the transaction committed. */
async function loadSignedForms(formId, consentRecordId) {
  const [formRes, consentRes] = await Promise.all([
    pool.query('SELECT * FROM pt_parq_forms WHERE id = $1', [formId]),
    pool.query('SELECT * FROM pt_consent_records WHERE id = $1', [consentRecordId]),
  ]);
  return { form: formRes.rows[0], consent: consentRes.rows[0] };
}

async function attachConsentPdf(consentRecordId, pdfUrl) {
  await pool.query('UPDATE pt_consent_records SET pdf_url = $1 WHERE id = $2', [pdfUrl, consentRecordId]);
}

module.exports = {
  clientForLink, writeSignedForms, loadSignedForms, attachConsentPdf,
};

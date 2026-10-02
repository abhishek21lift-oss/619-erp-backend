'use strict';
// Test fixture: a screened client, written straight into a TEST database.
//
// Enrolling a client who has never had a PT term needs a completed Informed
// Consent and a fully answered PAR-Q (lib/screeningGate). Real-DB suites that
// enrol clients to test something else call this first. It is never imported
// by application code.

/** A completed consent and a submitted, all-"no", cleared PAR-Q. */
async function screenClient(pool, { clientId, orgId, name = 'Test Client' }) {
  await pool.query(
    `INSERT INTO pt_informed_consents (client_id, organization_id, full_name, status)
     VALUES ($1, $2, $3, 'completed')`,
    [clientId, orgId, name],
  );
  const answers = Array.from({ length: 10 }, (_, i) => ({ question_id: `q${i + 1}`, answer: 'no' }));
  await pool.query(
    `INSERT INTO pt_parq_forms (client_id, organization_id, full_name, parq_answers, status,
                                risk_level, workout_gate_status)
     VALUES ($1, $2, $3, $4::jsonb, 'submitted', 'low', 'cleared')`,
    [clientId, orgId, name, JSON.stringify(answers)],
  );
}

/** Remove what screenClient wrote, for a suite's afterAll. */
async function unscreenClients(pool, clientIds) {
  await pool.query('DELETE FROM pt_informed_consents WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM pt_parq_forms WHERE client_id = ANY($1)', [clientIds]);
}

module.exports = { screenClient, unscreenClients };

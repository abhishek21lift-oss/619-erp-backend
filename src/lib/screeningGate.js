// src/lib/screeningGate.js
// Shared PAR-Q + Informed Consent safety gate, extracted from
// src/routes/workouts.js POST /assign so the same check can also run
// before a Workout Log session is created (src/modules/pt-os/workout-log.routes.js).
// Always a live SELECT against the source-of-truth tables — never a
// cached/trusted client-submitted flag.
const pool = require('../db/pool');
const { logActivity } = require('./activityLog');

// Returns null when the client is cleared, or { status, body } describing
// the 403 to send when blocked. Also fires the workout.assign.blocked
// activity log entry (kept as the historical action name both gates use).
async function checkScreeningGate(req, clientId) {
  const { rows: gateRows } = await pool.query(
    `SELECT workout_gate_status FROM pt_parq_forms
      WHERE client_id = $1 AND deleted_at IS NULL
      ORDER BY assessment_date DESC LIMIT 1`,
    [clientId]
  );
  const gate = gateRows[0];
  if (!gate || gate.workout_gate_status !== 'cleared') {
    await logActivity(req, 'workout.assign.blocked', 'pt_client', clientId, {
      reason: gate ? 'gate_not_cleared' : 'no_parq_form',
    });
    return {
      status: 403,
      body: { error: 'PAR-Q health screening required before workout assignment', code: 'PARQ_REQUIRED' },
    };
  }

  const { rows: consentRows } = await pool.query(
    `SELECT status FROM pt_informed_consents
      WHERE client_id = $1 AND status NOT IN ('archived')
      ORDER BY created_at DESC LIMIT 1`,
    [clientId]
  );
  const consent = consentRows[0];
  if (!consent || consent.status !== 'completed') {
    await logActivity(req, 'workout.assign.blocked', 'pt_client', clientId, {
      reason: consent ? 'consent_not_completed' : 'no_informed_consent',
    });
    return {
      status: 403,
      body: { error: 'Personal Training Informed Consent required before workout assignment', code: 'CONSENT_REQUIRED' },
    };
  }

  return null;
}

module.exports = { checkScreeningGate };

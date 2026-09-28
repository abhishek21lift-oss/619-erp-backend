// src/lib/screeningGate.js
// Shared PAR-Q + Informed Consent safety gate, used by workout plan
// assignment (src/routes/workouts.js POST /assign), Workout Log session
// creation (src/modules/pt-os/workout-log.routes.js), fitness testing
// (src/modules/progress/progress.routes.js POST /assessments) and the member
// app's own workout log.
// Always a live SELECT against the source-of-truth tables — never a
// cached/trusted client-submitted flag.
//
// Semantics:
//   • HARD BLOCK (403) on a real medical or legal stop:
//       – the latest submitted PAR-Q is high risk and has no approved,
//         unexpired medical clearance (PARQ_BLOCKED). Expiry is checked HERE,
//         at read time: the stored workout_gate_status is only recomputed when
//         a form or clearance is written, so a clearance that lapsed since
//         then would otherwise keep a high-risk client cleared forever;
//       – the client has revoked their Informed Consent (CONSENT_REVOKED);
//       – the consent records that a physician advised against exercise and
//         no medical clearance has been uploaded (PHYSICIAN_ADVISED_AGAINST).
//   • Missing paperwork (no submitted PAR-Q on file, or no completed Informed
//     Consent) is a WARNING, not a block: the action proceeds and the
//     route returns the warnings so the UI can nudge the trainer to
//     complete screening. Blocking every unscreened client outright made
//     the whole workout system unusable on day one.
//
// Both reads are pinned to the client's OWN studio (the join on
// pt_clients.organization_id). A form or consent some other studio wrote
// against this client id can neither block nor clear them.
const pool = require('../db/pool');
const { logActivity } = require('./activityLog');

// Drafts are excluded: the PAR-Q wizard saves a draft with blank answers on
// its first step, and a blank draft must not become the "latest" form and
// hide a submitted high-risk one. Ties on assessment_date resolve to the most
// recently written form, so "latest" is deterministic.
const LATEST_PARQ_SQL = `
  SELECT f.risk_level, f.workout_gate_status,
         EXISTS (
           SELECT 1 FROM pt_medical_clearances mc
            WHERE mc.parq_form_id = f.id AND mc.approval_status = 'approved'
              AND (mc.expiry_date IS NULL OR mc.expiry_date >= CURRENT_DATE)
         ) AS has_valid_clearance
    FROM pt_parq_forms f
    JOIN pt_clients c ON c.id = f.client_id AND c.organization_id = f.organization_id
   WHERE f.client_id = $1 AND f.deleted_at IS NULL
     AND COALESCE(f.status, 'submitted') <> 'draft'
   ORDER BY f.assessment_date DESC NULLS LAST, f.created_at DESC
   LIMIT 1`;

const LATEST_CONSENT_SQL = `
  SELECT ic.status, ic.physician_advised_against, ic.medical_clearance_file_url
    FROM pt_informed_consents ic
    JOIN pt_clients c ON c.id = ic.client_id AND c.organization_id = ic.organization_id
   WHERE ic.client_id = $1 AND ic.status NOT IN ('archived')
   ORDER BY ic.created_at DESC
   LIMIT 1`;

const BLOCKS = {
  PARQ_BLOCKED: 'This client\'s PAR-Q screening flags them as medically blocked — clearance is required before training.',
  CONSENT_REVOKED: 'This client has revoked their Informed Consent — a new consent must be signed before training.',
  PHYSICIAN_ADVISED_AGAINST: 'This client\'s Informed Consent records that a physician advised against exercise — upload a medical clearance before training.',
};

function parqBlocks(form) {
  if (!form) return false;
  const high = form.risk_level === 'high' || form.workout_gate_status === 'blocked';
  return high && !form.has_valid_clearance;
}

// Reads both records and decides. Returns { code, parq, consent } where code
// is null when nothing hard-blocks.
async function evaluate(clientId) {
  const [{ rows: parqRows }, { rows: consentRows }] = await Promise.all([
    pool.query(LATEST_PARQ_SQL, [clientId]),
    pool.query(LATEST_CONSENT_SQL, [clientId]),
  ]);
  const parq = parqRows[0] || null;
  const consent = consentRows[0] || null;

  let code = null;
  if (parqBlocks(parq)) code = 'PARQ_BLOCKED';
  else if (consent && consent.status === 'revoked') code = 'CONSENT_REVOKED';
  else if (consent && consent.physician_advised_against === true && !consent.medical_clearance_file_url) {
    code = 'PHYSICIAN_ADVISED_AGAINST';
  }
  return { code, parq, consent };
}

// Returns { blocked, warnings }:
//   blocked  — null when the action may proceed, or { status, body } for
//              the 403 to send.
//   warnings — human-readable strings for missing screening paperwork;
//              include them in the success response as screening_warnings.
async function checkScreeningGate(req, clientId) {
  const warnings = [];
  const { code, parq, consent } = await evaluate(clientId);

  if (code) {
    await logActivity(req, 'workout.assign.blocked', 'pt_client', clientId, {
      reason: code === 'PARQ_BLOCKED' ? 'gate_blocked' : code.toLowerCase(),
    });
    return {
      blocked: { status: 403, body: { error: BLOCKS[code], code } },
      warnings,
    };
  }

  if (!parq) {
    warnings.push('No PAR-Q health screening on file for this client.');
  }
  if (!consent || consent.status !== 'completed') {
    warnings.push('Informed Consent is not completed for this client.');
  }

  if (warnings.length > 0) {
    await logActivity(req, 'workout.assign.warned', 'pt_client', clientId, {
      warnings,
    });
  }

  return { blocked: null, warnings };
}

/**
 * Is this client blocked from training by their screening?
 *
 * The quiet half of checkScreeningGate, for the member app: the member logging
 * their own workout is not a trainer assigning one, so there is nothing to
 * warn about and no audit event to write — only the hard stop applies.
 */
async function isTrainingBlocked(clientId) {
  const { code } = await evaluate(clientId);
  return code !== null;
}

module.exports = { checkScreeningGate, isTrainingBlocked, parqBlocks };

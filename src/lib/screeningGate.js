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
//   • Missing or unreliable paperwork is a WARNING, not a block: the action
//     proceeds and the route returns the warnings so the UI can nudge the
//     trainer. Blocking every unscreened client outright made the whole
//     workout system unusable on day one. Warned about:
//       – no submitted PAR-Q on file;
//       – a "submitted" PAR-Q with unanswered questions (it scores as zero
//         yeses, so it must not read as a clean screen);
//       – a PAR-Q older than 12 months (PAR-Q+ asks for a re-screen yearly);
//       – a medium-risk PAR-Q no trainer has marked reviewed;
//       – no completed Informed Consent.
//
// Both reads are pinned to the client's OWN studio (the join on
// pt_clients.organization_id). A form or consent some other studio wrote
// against this client id can neither block nor clear them.
const pool = require('../db/pool');
const { logActivity } = require('./activityLog');

// A clearance counts when the most recent DECISION on the form approved it
// and it has not expired. "Any approved row" let an old approval outlive a
// later rejection of the same client. Pending rows are not decisions: a
// renewal in progress must not suspend the clearance already on file.
// Shared with parq.routes.js recomputeGateStatus() so the stored
// workout_gate_status and this read-time check agree.
const validClearanceSql = (formIdExpr) => `COALESCE((
    SELECT mc.approval_status = 'approved'
           AND (mc.expiry_date IS NULL OR mc.expiry_date >= CURRENT_DATE)
      FROM pt_medical_clearances mc
     WHERE mc.parq_form_id = ${formIdExpr} AND mc.approval_status IN ('approved', 'rejected')
     ORDER BY COALESCE(mc.reviewed_at, mc.updated_at, mc.created_at) DESC
     LIMIT 1), false)`;

// The PAR-Q has ten fixed questions (see parq-scoring.js).
const PARQ_QUESTION_COUNT = 10;
const PARQ_STALE_MONTHS = 12;

// Drafts are excluded: the PAR-Q wizard saves a draft with blank answers on
// its first step, and a blank draft must not become the "latest" form and
// hide a submitted high-risk one. Ties on assessment_date resolve to the most
// recently written form, so "latest" is deterministic.
const LATEST_PARQ_SQL = `
  SELECT f.risk_level, f.workout_gate_status, f.status,
         ${validClearanceSql('f.id')} AS has_valid_clearance,
         (SELECT COUNT(DISTINCT a->>'question_id')
            FROM jsonb_array_elements(
                   CASE WHEN jsonb_typeof(f.parq_answers) = 'array' THEN f.parq_answers ELSE '[]'::jsonb END
                 ) a
           WHERE a->>'answer' IN ('yes', 'no'))::int AS answered_count,
         (f.assessment_date < CURRENT_DATE - INTERVAL '${PARQ_STALE_MONTHS} months') AS is_stale
    FROM pt_parq_forms f
    JOIN pt_clients c ON c.id = f.client_id AND c.organization_id = f.organization_id
   WHERE f.client_id = $1 AND f.deleted_at IS NULL
     AND COALESCE(f.status, 'submitted') <> 'draft'
   ORDER BY f.assessment_date DESC NULLS LAST, f.created_at DESC
   LIMIT 1`;

// The consent that decides is the newest one that was ever GIVEN or
// WITHDRAWN (completed / revoked / expired), not simply the newest row. A
// draft is neither: reading "newest row" let a fresh draft started after a
// revocation sit on top of it and turn the hard stop into a warning. A
// revocation therefore stands until a newer consent is actually completed.
//
// The physician check looks at the deciding record and anything newer — a
// draft that records a physician's advice against exercise is new medical
// information, and it binds from the moment it is written.
const LATEST_CONSENT_SQL = `
  WITH scoped AS (
    SELECT ic.status, ic.created_at, ic.physician_advised_against, ic.medical_clearance_file_url
      FROM pt_informed_consents ic
      JOIN pt_clients c ON c.id = ic.client_id AND c.organization_id = ic.organization_id
     WHERE ic.client_id = $1 AND ic.status <> 'archived'
  ), deciding AS (
    SELECT status, created_at FROM scoped
     WHERE status IN ('completed', 'revoked', 'expired')
     ORDER BY created_at DESC
     LIMIT 1
  )
  SELECT d.status,
         EXISTS (
           SELECT 1 FROM scoped s
            WHERE s.physician_advised_against IS TRUE
              AND s.medical_clearance_file_url IS NULL
              AND (d.created_at IS NULL OR s.created_at >= d.created_at)
         ) AS physician_block
    FROM (SELECT 1) one
    LEFT JOIN deciding d ON TRUE`;

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

// What is wrong with the PAR-Q on file short of a hard stop.
function parqWarnings(parq) {
  if (!parq) return ['No PAR-Q health screening on file for this client.'];
  const out = [];
  const answered = Number(parq.answered_count);
  if (Number.isFinite(answered) && answered < PARQ_QUESTION_COUNT) {
    out.push(`The PAR-Q on file is incomplete (${answered} of ${PARQ_QUESTION_COUNT} questions answered) — complete the screening.`);
  }
  if (parq.is_stale === true) {
    out.push(`The PAR-Q on file is over ${PARQ_STALE_MONTHS} months old — re-screen this client.`);
  }
  if (parq.risk_level === 'medium' && parq.status !== 'reviewed') {
    out.push('The PAR-Q has "yes" answers that need trainer review — review it and mark it reviewed.');
  }
  return out;
}

// Reads both records and decides. Returns { code, parq, consent } where code
// is null when nothing hard-blocks.
async function evaluate(clientId) {
  const [{ rows: parqRows }, { rows: consentRows }] = await Promise.all([
    pool.query(LATEST_PARQ_SQL, [clientId]),
    pool.query(LATEST_CONSENT_SQL, [clientId]),
  ]);
  const parq = parqRows[0] || null;
  // status is null when no consent was ever completed or revoked.
  const consent = consentRows[0] || { status: null, physician_block: false };

  let code = null;
  if (parqBlocks(parq)) code = 'PARQ_BLOCKED';
  else if (consent.status === 'revoked') code = 'CONSENT_REVOKED';
  else if (consent.physician_block === true) code = 'PHYSICIAN_ADVISED_AGAINST';
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

  warnings.push(...parqWarnings(parq));
  if (consent.status !== 'completed') {
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

// ── Training eligibility ────────────────────────────────────────────────────
//
// checkScreeningGate answers "is this person medically allowed to train". It
// never asked whether they are a client who SHOULD be training: a pending
// client nobody has enrolled, an expired one whose term ran out, a frozen one.
// Workout assignment, accepting a generated plan, booking or completing a PT
// session and logging a workout all went through on any of those.
//
// checkTrainingEligibility is that question, asked live of the database on
// every call (never of anything the browser sent), with one set of codes for
// every route:
//
//   404 NOT_FOUND           not a live client of this studio
//   409 CLIENT_NOT_ENROLLED no PT term yet — enrol them first
//   409 TERM_EXPIRED        their term has ended — renew first
//   409 CLIENT_FROZEN       membership is frozen
//   409 CLIENT_NOT_ACTIVE   any other non-active status
//   403 PARQ_BLOCKED / CONSENT_REVOKED / PHYSICIAN_ADVISED_AGAINST
//                           the medical hard stops, unchanged
//
// The term's end date is its LAST valid day, compared in the database's own
// session time zone (the studio's — see db/pool.js), so the final day is valid
// for the whole local day.
//
// Strict screening for NEW clients. A client who has never had a PT term must
// have a COMPLETED Informed Consent and a SUBMITTED, fully answered PAR-Q
// before anything that starts their training: enrolment and fitness testing
// (403 SCREENING_REQUIRED, with what is missing). Clients already enrolled or
// renewed keep the warn-only behaviour above — the studio decided not to lock
// out people who are training today (Phase 2, 2026-10-02).

const ELIGIBILITY_BLOCKS = {
  CLIENT_NOT_ENROLLED: 'This client is not enrolled in PT yet. Enrol them before assigning or starting training.',
  TERM_EXPIRED: 'This client\'s PT term has ended. Renew their PT before assigning or starting training.',
  CLIENT_FROZEN: 'This client\'s membership is frozen. Unfreeze it before assigning or starting training.',
  CLIENT_NOT_ACTIVE: 'This client is not active. Reactivate them before assigning or starting training.',
};

const SCREENING_REQUIRED_MESSAGE = 'Complete this client\'s screening first: a new client needs a completed '
  + 'Informed Consent and a fully answered PAR-Q before they can be enrolled or tested.';

/**
 * The client facts eligibility depends on, org-scoped and live.
 * `ended` is computed in SQL so "today" is the database session's — the
 * studio's — today, not the Node process's.
 */
async function loadClientFacts(orgId, clientId) {
  const { hasPtTermSql } = require('./ptTerm');
  const { rows } = await pool.query(
    `SELECT c.id, c.status,
            (c.pt_end_date IS NOT NULL AND c.pt_end_date < CURRENT_DATE) AS ended,
            ${hasPtTermSql('c')} AS has_pt_term
       FROM pt_clients c
      WHERE c.id = $1 AND c.organization_id = $2 AND c.deleted_at IS NULL`,
    [clientId, orgId],
  );
  return rows[0] || null;
}

/** Which status block applies, or null when the client may train. */
function statusBlock(facts) {
  if (!facts.has_pt_term || facts.status === 'pending') return 'CLIENT_NOT_ENROLLED';
  if (facts.status === 'expired' || (facts.status === 'active' && facts.ended)) return 'TERM_EXPIRED';
  if (facts.status === 'frozen') return 'CLIENT_FROZEN';
  if (facts.status !== 'active') return 'CLIENT_NOT_ACTIVE';
  return null;
}

/** What a new client's screening is missing, in the order they are done. */
function missingScreening(parq, consent) {
  const missing = [];
  if (consent.status !== 'completed') missing.push('informed_consent');
  const answered = Number(parq?.answered_count);
  if (!parq || !(answered >= PARQ_QUESTION_COUNT)) missing.push('parq');
  return missing;
}

/**
 * May this client be trained right now?
 *
 * @param {object} req       for the org and the audit row
 * @param {string} clientId
 * @param {object} [opts]
 * @param {boolean} [opts.requireActive=true]  false for fitness testing, which
 *        happens BEFORE enrolment in the intake journey
 * @param {string} [opts.action]  audit label
 * @returns {Promise<{ blocked: null | { status, body }, warnings: string[], facts: object|null }>}
 */
async function checkTrainingEligibility(req, clientId, { requireActive = true, action = 'training' } = {}) {
  const facts = await loadClientFacts(require('./tenant-db').orgIdOf(req), clientId);
  if (!facts) {
    return { blocked: { status: 404, body: { error: 'Client not found', code: 'NOT_FOUND' } }, warnings: [], facts: null };
  }

  if (requireActive) {
    const code = statusBlock(facts);
    if (code) {
      await logActivity(req, 'training.blocked', 'pt_client', clientId, { reason: code.toLowerCase(), action });
      return { blocked: { status: 409, body: { error: ELIGIBILITY_BLOCKS[code], code } }, warnings: [], facts };
    }
  }

  // Strict screening for a client who has never been enrolled. The medical
  // hard stops are checked first and win, because they say what to fix.
  if (!facts.has_pt_term) {
    const { code, parq, consent } = await evaluate(clientId);
    if (!code) {
      const missing = missingScreening(parq, consent);
      if (missing.length) {
        await logActivity(req, 'training.blocked', 'pt_client', clientId, { reason: 'screening_required', missing, action });
        return {
          blocked: { status: 403, body: { error: SCREENING_REQUIRED_MESSAGE, code: 'SCREENING_REQUIRED', missing } },
          warnings: [], facts,
        };
      }
    }
  }

  const { blocked, warnings } = await checkScreeningGate(req, clientId);
  return { blocked, warnings, facts };
}

/**
 * Enrolment's half: a client with no PT term may only be enrolled once their
 * screening is complete and nothing medically blocks them. Clients who
 * already have a term (renewals, edits) are not re-gated here.
 *
 * @returns {Promise<null | { status, body }>}
 */
async function enrolmentScreeningBlock(req, clientId) {
  const { code, parq, consent } = await evaluate(clientId);
  if (code) {
    await logActivity(req, 'enrolment.blocked', 'pt_client', clientId, { reason: code.toLowerCase() });
    return { status: 403, body: { error: BLOCKS[code], code } };
  }
  const missing = missingScreening(parq, consent);
  if (missing.length) {
    await logActivity(req, 'enrolment.blocked', 'pt_client', clientId, { reason: 'screening_required', missing });
    return { status: 403, body: { error: SCREENING_REQUIRED_MESSAGE, code: 'SCREENING_REQUIRED', missing } };
  }
  return null;
}

module.exports = {
  checkScreeningGate, isTrainingBlocked, parqBlocks, parqWarnings, validClearanceSql,
  checkTrainingEligibility, enrolmentScreeningBlock, statusBlock, missingScreening,
  ELIGIBILITY_BLOCKS, PARQ_QUESTION_COUNT,
};

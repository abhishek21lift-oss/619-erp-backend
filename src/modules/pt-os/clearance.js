'use strict';
// Clearance state machine, shared by the rules engine, the AI route and the
// PAR-Q routes.
//
// Four states, not two:
//
//   cleared      a screen exists and says the client may train.
//   conditional  a screen exists and the trainer must work around recorded
//                restrictions. Programming proceeds WITH those restrictions.
//   blocked      a screen exists and says not yet. Nothing is programmed.
//   unknown      no screen exists. This is NOT cleared — it is the absence of
//                a decision, and the caller decides whether to escalate or to
//                take an explicit, recorded override.
//
// The distinction is the point: `unknown` must never be coerced to `cleared`
// by a default, and `conditional` must never be treated as `cleared` without
// carrying its restrictions forward.

const STATUS = Object.freeze({
  CLEARED: 'cleared',
  CONDITIONAL: 'conditional',
  BLOCKED: 'blocked',
  UNKNOWN: 'unknown',
});

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** Stored status, normalised. Anything explicit but unrecognised is blocked. */
function normaliseStatus(parq) {
  if (!parq) return STATUS.UNKNOWN;
  const raw = str(parq.workout_gate_status).toLowerCase();
  if (raw === STATUS.CLEARED || raw === STATUS.CONDITIONAL || raw === STATUS.BLOCKED) return raw;
  // An explicit non-clearance (pending / referred / refused / anything else)
  // is a studio having looked and said not yet. Never read it as cleared.
  return raw ? STATUS.BLOCKED : STATUS.UNKNOWN;
}

/**
 * The restrictions a conditional clearance carries.
 *
 * Derived from the PAR-Q answers that were actually "yes", because that is the
 * only structured restriction data the form holds. A trainer's explanation is
 * carried verbatim; nothing is invented when the form recorded none.
 */
function restrictionsFrom(parq) {
  const answers = Array.isArray(parq?.parq_answers) ? parq.parq_answers : [];
  const out = answers
    .filter((a) => a && a.answer === 'yes')
    .map((a) => {
      const q = Number(a.question_id);
      const note = str(a.explanation) || str(a.notes) || str(a.treatment);
      return `PAR-Q question ${Number.isFinite(q) ? q : '?'} answered yes${note ? `: ${note}` : ''}`;
    });
  if (!out.length) {
    out.push('Conditional clearance — follow the restrictions recorded by the reviewing trainer.');
  }
  return out;
}

/**
 * @param {{ parq?: object|null }} input
 * @returns {{
 *   status: 'cleared'|'conditional'|'blocked'|'unknown',
 *   may_program: boolean,
 *   requires_ack: boolean,
 *   code: string|null,
 *   restrictions: string[],
 * }}
 */
function decision({ parq = null } = {}) {
  const status = normaliseStatus(parq);
  if (status === STATUS.CLEARED) {
    return { status, may_program: true, requires_ack: false, code: null, restrictions: [] };
  }
  if (status === STATUS.CONDITIONAL) {
    return {
      status,
      may_program: true,
      requires_ack: false,
      code: null,
      restrictions: restrictionsFrom(parq),
    };
  }
  if (status === STATUS.UNKNOWN) {
    return {
      status,
      may_program: false,
      requires_ack: true,
      code: 'CLEARANCE_REQUIRED',
      restrictions: [],
    };
  }
  return { status, may_program: false, requires_ack: false, code: 'NOT_CLEARED', restrictions: [] };
}

module.exports = { STATUS, normaliseStatus, restrictionsFrom, decision };

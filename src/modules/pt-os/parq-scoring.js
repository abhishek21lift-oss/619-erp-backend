'use strict';
// src/modules/pt-os/parq-scoring.js
// PAR-Q risk classification. The frontend twin is computeParqRisk() in
// src/lib/parq-calculations.ts, which previews the result live in the wizard;
// this copy is the one that is stored and gates training. The frontend's
// scripts/assert-scoring-parity.ts compares the two on every CI run, which is
// why computeParqRisk is exported here under the frontend's name as well.

// Rule: any "yes" to a RED-FLAG question is high risk on its own — a
// diagnosed heart condition (Q1), chest pain on exertion (Q3) or at rest
// (Q4), or dizziness / loss of consciousness (Q5). PAR-Q+ and ACSM
// pre-participation screening both require medical clearance before training
// for any one of those; counting them as "1 yes = medium" cleared a client
// reporting chest pain while blocking one with three minor yeses.
// Otherwise the count decides: 0 yes = low, 1-2 = medium, 3+ = high.
// Never trust a client-supplied risk level — a malicious/buggy client could
// self-report LOW risk to bypass the workout-assignment gate, so this is
// always recomputed server-side. Mirrored by computeParqRisk() in the
// frontend's src/lib/parq-calculations.ts.
const PARQ_RED_FLAG_QUESTIONS = new Set(['1', '3', '4', '5']);

function computeParqAnalysis(parqAnswers) {
  const answers = Array.isArray(parqAnswers) ? parqAnswers : [];
  const yes = answers.filter((a) => a && a.answer === 'yes');
  const yesCount = yes.length;
  const redFlag = yes.some((a) => PARQ_RED_FLAG_QUESTIONS.has(String(a.question_id)));
  let riskLevel;
  let riskMessage;
  if (redFlag || yesCount >= 3) {
    riskLevel = 'high';
    riskMessage = 'Medical Clearance Required — Workout Assignment Disabled';
  } else if (yesCount === 0) {
    riskLevel = 'low';
    riskMessage = 'Approved for Exercise';
  } else {
    riskLevel = 'medium';
    riskMessage = 'Trainer Review Required';
  }
  return { yesCount, riskLevel, riskMessage };
}

// Same function, frontend's name — for the parity check.
const computeParqRisk = computeParqAnalysis;

module.exports = { computeParqAnalysis, computeParqRisk, PARQ_RED_FLAG_QUESTIONS };

'use strict';
// Weighted scoring for post-session feedback.
//
// Each answer is normalised onto the same 0–5 scale before it is weighted:
//
//   · a four-option answer runs 5, 3.33, 1.67, 0 from best to worst;
//   · intensity's two non-perfect options are both 2.5 — "too easy" and "too
//     hard" are not the same as "bad", and neither is obviously worse;
//   · motivation's three options run 5, 2.5, 0;
//   · the overall 1–5 stars map linearly onto 0–5.
//
// The weights are configuration, not a database constant: a studio that
// values technique more can set FEEDBACK_WEIGHTS without a migration. The
// resulting score is stored on the feedback row, so changing the weights never
// rewrites a historic rating.

const DEFAULT_WEIGHTS = Object.freeze({
  behaviour: 0.20,
  technique: 0.25,
  intensity: 0.20,
  motivation: 0.15,
  overall: 0.20,
});

const OPTIONS = Object.freeze({
  trainer_behaviour: ['excellent', 'good', 'average', 'poor'],
  form_technique: ['always', 'mostly', 'sometimes', 'no'],
  workout_intensity: ['perfect', 'too_easy', 'too_hard'],
  motivation_guidance: ['absolutely', 'somewhat', 'not_really'],
});

const ANSWER_SCORES = Object.freeze({
  trainer_behaviour: { excellent: 5, good: 10 / 3, average: 5 / 3, poor: 0 },
  form_technique: { always: 5, mostly: 10 / 3, sometimes: 5 / 3, no: 0 },
  workout_intensity: { perfect: 5, too_easy: 2.5, too_hard: 2.5 },
  motivation_guidance: { absolutely: 5, somewhat: 2.5, not_really: 0 },
});

/** Round to the two decimals the NUMERIC(4,2) column stores. */
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * The configured weights. A malformed override is ignored rather than
 * throwing: a typo in one environment variable must not stop every client
 * submitting feedback. The defaults are the documented weights.
 */
function weightsFromEnv(env = process.env) {
  if (!env.FEEDBACK_WEIGHTS) return { ...DEFAULT_WEIGHTS };
  try {
    const raw = JSON.parse(env.FEEDBACK_WEIGHTS);
    const keys = Object.keys(DEFAULT_WEIGHTS);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_WEIGHTS };
    if (!keys.every((k) => Number.isFinite(Number(raw[k])) && Number(raw[k]) >= 0)) {
      return { ...DEFAULT_WEIGHTS };
    }
    const weights = Object.fromEntries(keys.map((k) => [k, Number(raw[k])]));
    const sum = keys.reduce((n, k) => n + weights[k], 0);
    if (Math.abs(sum - 1) > 0.001) return { ...DEFAULT_WEIGHTS };
    return weights;
  } catch {
    return { ...DEFAULT_WEIGHTS };
  }
}

/**
 * The weighted session score, 0–5, rounded to two decimals.
 *
 * @param {{ trainer_behaviour: string, form_technique: string, workout_intensity: string,
 *           motivation_guidance: string, overall_stars: number }} answers
 * @param {{ behaviour: number, technique: number, intensity: number,
 *           motivation: number, overall: number }} [weights]
 */
function scoreFeedback(answers, weights = weightsFromEnv()) {
  for (const [key, allowed] of Object.entries(OPTIONS)) {
    if (!allowed.includes(answers?.[key])) {
      throw new Error(`${key} must be one of: ${allowed.join(', ')}`);
    }
  }
  const stars = Number(answers.overall_stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    throw new Error('overall_stars must be a whole number between 1 and 5');
  }

  const total = (
    ANSWER_SCORES.trainer_behaviour[answers.trainer_behaviour] * weights.behaviour
    + ANSWER_SCORES.form_technique[answers.form_technique] * weights.technique
    + ANSWER_SCORES.workout_intensity[answers.workout_intensity] * weights.intensity
    + ANSWER_SCORES.motivation_guidance[answers.motivation_guidance] * weights.motivation
    + (stars - 1) * 1.25 * weights.overall
  );
  // Clamp so a future weight override can never store a value the CHECK
  // constraint rejects.
  return round2(Math.min(5, Math.max(0, total)));
}

module.exports = { DEFAULT_WEIGHTS, OPTIONS, ANSWER_SCORES, scoreFeedback, weightsFromEnv };

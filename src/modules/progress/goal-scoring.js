// src/modules/progress/goal-scoring.js
// Pure calculation/classification functions for the Goal Assessment
// module. Frontend twin: 619-erp-frontend/src/lib/goal-calculations.ts
// (same formulas, duplicated deliberately since there's no shared package
// between the two apps). Scores/analysis are always computed here
// (server-side), never trusted from client-submitted values.

const { z } = require('../../lib/validation');

function round(n, decimals = 2) {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

// ── Lifestyle Readiness ─────────────────────────────────────
// 6 yes/no questions. medical_restrictions is inverted: "No restrictions"
// is the favorable answer.
function calcLifestyleReadinessScore(answers) {
  if (!answers || typeof answers !== 'object') return null;
  const keys = ['can_train_4_6_days', 'meal_prep_possible', 'sleep_7_8_hours', 'drink_enough_water', 'family_support', 'medical_restrictions'];
  let favorable = 0;
  let answered = 0;
  for (const key of keys) {
    const v = answers[key];
    if (typeof v !== 'boolean') continue;
    answered++;
    const isFavorable = key === 'medical_restrictions' ? v === false : v === true;
    if (isFavorable) favorable++;
  }
  if (answered === 0) return null;
  // Out of the questions actually answered: an unanswered question is not an
  // unfavourable one, and dividing by all six marked a client who answered
  // three favourably as 50% ready rather than 100%.
  return Math.round((favorable / answered) * 100);
}

// ── Weight-change rate ──────────────────────────────────────
function goalDirection(startingWeight, targetWeight) {
  if (startingWeight == null || targetWeight == null) return null;
  if (targetWeight < startingWeight) return 'loss';
  if (targetWeight > startingWeight) return 'gain';
  return 'maintain';
}

// Signed kg/week required to hit the target by the deadline.
function calcRequiredWeeklyRate(startingWeight, targetWeight, daysRemaining) {
  if (startingWeight == null || targetWeight == null || daysRemaining == null || daysRemaining <= 0) return null;
  const weeksRemaining = daysRemaining / 7;
  if (weeksRemaining <= 0) return null;
  return round((targetWeight - startingWeight) / weeksRemaining);
}

// Conservative, general Phase-1 benchmarks — not clinical guidance.
// Fat loss: 0.75% of starting bodyweight/week. Muscle gain: ~0.35 kg/month.
function calcSafeWeeklyRate(startingWeight, direction) {
  if (direction === 'loss') {
    if (startingWeight == null) return null;
    return round(startingWeight * 0.0075);
  }
  if (direction === 'gain') {
    return round(0.35 / 4.33);
  }
  return null;
}

// ── K11 measurable targets ──────────────────────────────────
// Weight keeps the Phase-1 kg/week benchmarks above. The other metrics get
// conservative general-population benchmarks, not clinical guidance:
// body fat 0.25 percentage points/week, strength 0.5% of the current lift/
// week. A session count is a weekly frequency, so it has no rate at all.
const K11_METRICS = ['weight', 'body_fat', 'lift', 'sessions', 'custom'];

function calcSafeWeeklyRateFor(metric, current, direction) {
  if (direction == null || direction === 'maintain') return null;
  if (metric === 'body_fat') return 0.25;
  if (metric === 'lift') return current != null && current > 0 ? round(current * 0.005) : null;
  if (metric === 'sessions' || metric === 'custom') return null;
  return calcSafeWeeklyRate(current, direction);
}

const k11MeasureNumber = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? undefined : v),
  z.coerce.number().min(0).max(10000).optional()
);

// A target of zero is not a goal: it would divide the plan by nothing.
const k11TargetNumber = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? undefined : v),
  z.coerce.number().gt(0).max(10000)
);

const k11Schema = z.object({
  measure: z.object({
    metric: z.enum(K11_METRICS),
    exercise: z.string().max(100).optional().nullable(),
    label: z.string().max(100).optional().nullable(),
    current: k11MeasureNumber,
    target: k11TargetNumber,
    unit: z.string().max(20).optional().nullable(),
  }).optional().nullable(),
  client_agreement: z.boolean().optional(),
  client_expectation: z.string().max(1000).optional().nullable(),
});

/**
 * Validate the K11 block before it is stored in routine_blueprint.
 * null = absent, undefined = invalid (the route answers 400).
 */
function sanitizeK11(raw) {
  if (raw == null) return null;
  const parsed = k11Schema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

// ── Difficulty ───────────────────────────────────────────────
const DIFFICULTY_LEVELS = ['Easy', 'Moderate', 'Hard', 'Very Hard'];
function classifyGoalDifficulty(requiredRate, safeRate, lifestyleReadinessScore, motivationLevel, commitmentLevel) {
  if (requiredRate == null || safeRate == null || safeRate === 0) return null;
  const ratio = Math.abs(requiredRate) / safeRate;
  let level = ratio <= 0.6 ? 0 : ratio <= 1.0 ? 1 : ratio <= 1.5 ? 2 : 3;

  const lowSignal = (lifestyleReadinessScore != null && lifestyleReadinessScore < 40)
    || (motivationLevel != null && motivationLevel <= 3)
    || (commitmentLevel != null && commitmentLevel <= 3);
  const highSignal = (lifestyleReadinessScore != null && lifestyleReadinessScore >= 80)
    && (motivationLevel != null && motivationLevel >= 8)
    && (commitmentLevel != null && commitmentLevel >= 8);

  if (lowSignal) level += 1;
  else if (highSignal) level -= 1;

  level = Math.max(0, Math.min(DIFFICULTY_LEVELS.length - 1, level));
  return DIFFICULTY_LEVELS[level];
}

// ── Duration ─────────────────────────────────────────────────
// Realistic duration at the SAFE rate — independent of the user's chosen
// deadline. Powers the "unrealistic timeline" smart alert.
function calcEstimatedDurationWeeks(startingWeight, targetWeight, safeWeeklyRate) {
  if (startingWeight == null || targetWeight == null || !safeWeeklyRate) return null;
  const weeks = Math.abs(targetWeight - startingWeight) / safeWeeklyRate;
  return Math.max(1, Math.ceil(weeks));
}

function recommendPtDurationMonths(estimatedWeeks) {
  if (estimatedWeeks == null) return null;
  if (estimatedWeeks <= 4) return 1;
  if (estimatedWeeks <= 13) return 3;
  if (estimatedWeeks <= 26) return 6;
  return 12;
}

// ── Risk factors ─────────────────────────────────────────────
function buildRiskFactors({ requiredRate, safeRate, lifestyleReadinessScore, medicalRestrictions, daysRemaining, motivationLevel, commitmentLevel, metric }) {
  const risks = [];
  const ratio = requiredRate != null && safeRate ? Math.abs(requiredRate) / safeRate : null;

  if (ratio != null && ratio > 1.5) {
    if (metric === 'lift') {
      risks.push('Required weekly strength gain exceeds the 0.5% of current lift / week benchmark.');
    } else if (metric === 'body_fat') {
      risks.push('Required body-fat change exceeds the 0.25 percentage points / week benchmark.');
    } else {
      risks.push('Required weekly rate of change exceeds safe guidelines for this timeline.');
    }
  }
  if (lifestyleReadinessScore != null && lifestyleReadinessScore < 40) {
    risks.push('Low lifestyle readiness — schedule, sleep, or support may limit consistency.');
  }
  if (medicalRestrictions === true) {
    risks.push('Medical restrictions flagged — recommend physician clearance before starting.');
  }
  if (daysRemaining != null && daysRemaining < 14 && ratio != null && ratio > 1) {
    risks.push('Very short timeline for the required change.');
  }
  if (motivationLevel != null && motivationLevel <= 3) {
    risks.push('Low motivation score — consider addressing mindset before an aggressive plan.');
  }
  if (commitmentLevel != null && commitmentLevel <= 3) {
    risks.push('Low commitment score — a lighter, more sustainable plan may fit better.');
  }
  return risks;
}

module.exports = {
  K11_METRICS,
  sanitizeK11,
  calcLifestyleReadinessScore,
  goalDirection,
  calcRequiredWeeklyRate,
  calcSafeWeeklyRate,
  calcSafeWeeklyRateFor,
  classifyGoalDifficulty,
  calcEstimatedDurationWeeks,
  recommendPtDurationMonths,
  buildRiskFactors,
};

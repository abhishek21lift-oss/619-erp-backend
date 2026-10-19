'use strict';
// src/modules/progress/progress-comparison.js
// Pure seven-domain comparison for the existing seven-step fitness test.
// No database, no clock, no AI.
//
// Rules that matter:
//   • A missing value is missing. It is never coerced to 0, and a percentage
//     change with a zero baseline is null rather than Infinity.
//   • A different protocol is not a worse result. When the cardio test, body
//     composition method, lift or mobility test changed, the values are still
//     shown and the delta is withheld with a reason.
//   • "Improved" follows the metric's direction, not the sign of the number.
//     Waist down is an improvement; VO₂ max up is an improvement; weight is
//     direction-neutral because the goal decides what is better.

const DOMAINS = [
  {
    key: 'blood_pressure', label: 'Blood Pressure & Resting',
    metrics: [
      { key: 'bp_systolic', label: 'Systolic BP', unit: 'mmHg', higherIsBetter: false, decimals: 0 },
      { key: 'bp_diastolic', label: 'Diastolic BP', unit: 'mmHg', higherIsBetter: false, decimals: 0 },
      { key: 'resting_heart_rate', label: 'Resting heart rate', unit: 'bpm', higherIsBetter: false, decimals: 0 },
      { key: 'resting_spo2', label: 'Resting SpO₂', unit: '%', higherIsBetter: true, decimals: 1 },
    ],
  },
  {
    key: 'anthropometric', label: 'Anthropometric',
    metrics: [
      { key: 'weight', label: 'Weight', unit: 'kg', higherIsBetter: null, decimals: 1 },
      { key: 'bmi', label: 'BMI', unit: 'kg/m²', higherIsBetter: null, decimals: 1 },
      { key: 'waist_cm', label: 'Waist', unit: 'cm', higherIsBetter: false, decimals: 1 },
      { key: 'hips_cm', label: 'Hips', unit: 'cm', higherIsBetter: null, decimals: 1 },
      { key: 'waist_hip_ratio', label: 'Waist-to-hip ratio', unit: '', higherIsBetter: false, decimals: 2 },
      { key: 'neck_cm', label: 'Neck', unit: 'cm', higherIsBetter: null, decimals: 1 },
      { key: 'chest_cm', label: 'Chest', unit: 'cm', higherIsBetter: null, decimals: 1 },
      { key: 'arm_right_cm', label: 'Right arm', unit: 'cm', higherIsBetter: null, decimals: 1 },
      { key: 'arm_left_cm', label: 'Left arm', unit: 'cm', higherIsBetter: null, decimals: 1 },
      { key: 'thigh_right_cm', label: 'Right thigh', unit: 'cm', higherIsBetter: null, decimals: 1 },
      { key: 'thigh_left_cm', label: 'Left thigh', unit: 'cm', higherIsBetter: null, decimals: 1 },
      { key: 'calf_right_cm', label: 'Right calf', unit: 'cm', higherIsBetter: null, decimals: 1 },
      { key: 'calf_left_cm', label: 'Left calf', unit: 'cm', higherIsBetter: null, decimals: 1 },
    ],
  },
  {
    key: 'body_composition', label: 'Body Composition',
    metrics: [
      { key: 'body_fat_pct', label: 'Body fat', unit: '%', higherIsBetter: false, decimals: 1, protocol: 'body_comp_method' },
      { key: 'muscle_mass_pct', label: 'Muscle mass', unit: '%', higherIsBetter: true, decimals: 1, protocol: 'body_comp_method' },
      { key: 'lean_body_mass_kg', label: 'Lean body mass', unit: 'kg', higherIsBetter: true, decimals: 2 },
      { key: 'fat_mass_kg', label: 'Fat mass', unit: 'kg', higherIsBetter: false, decimals: 2 },
      { key: 'visceral_fat', label: 'Visceral fat', unit: 'level', higherIsBetter: false, decimals: 1 },
      { key: 'subcutaneous_fat_pct', label: 'Subcutaneous fat', unit: '%', higherIsBetter: false, decimals: 1 },
      { key: 'body_water_pct', label: 'Body water', unit: '%', higherIsBetter: null, decimals: 1 },
      { key: 'bone_mass_kg', label: 'Bone mass', unit: 'kg', higherIsBetter: null, decimals: 1 },
      { key: 'bmr', label: 'BMR', unit: 'kcal', higherIsBetter: null, decimals: 0 },
      { key: 'metabolic_age', label: 'Metabolic age', unit: 'years', higherIsBetter: false, decimals: 0 },
    ],
  },
  {
    key: 'cardio', label: 'Cardiorespiratory',
    metrics: [
      { key: 'vo2_max', label: 'VO₂ max', unit: 'mL/kg/min', higherIsBetter: true, decimals: 2, protocol: 'cardio_test_type' },
      { key: 'cardio_score_computed', label: 'Cardio score', unit: '/100', higherIsBetter: true, decimals: 0 },
    ],
  },
  {
    key: 'strength', label: 'Muscular Strength',
    metrics: [
      { key: 'strength_score_computed', label: 'Strength score', unit: '/100', higherIsBetter: true, decimals: 0 },
      { key: 'strength_test1_1rm', label: 'Lift 1 estimated 1RM', unit: 'kg', higherIsBetter: true, decimals: 1, protocol: 'strength_exercise' },
      { key: 'strength_test2_1rm', label: 'Lift 2 estimated 1RM', unit: 'kg', higherIsBetter: true, decimals: 1, protocol: 'strength_exercise_2' },
    ],
  },
  {
    key: 'endurance', label: 'Muscular Endurance',
    metrics: [
      { key: 'endurance_score_computed', label: 'Endurance score', unit: '/100', higherIsBetter: true, decimals: 0 },
      { key: 'endurance_test1_reps', label: 'Test 1 reps', unit: 'reps', higherIsBetter: true, decimals: 0, protocol: 'endurance_test_type' },
      { key: 'endurance_test1_duration', label: 'Test 1 duration', unit: 's', higherIsBetter: true, decimals: 0, protocol: 'endurance_test_type' },
      { key: 'endurance_test2_reps', label: 'Test 2 reps', unit: 'reps', higherIsBetter: true, decimals: 0, protocol: 'endurance_test_type_2' },
      { key: 'endurance_test2_duration', label: 'Test 2 duration', unit: 's', higherIsBetter: true, decimals: 0, protocol: 'endurance_test_type_2' },
    ],
  },
  {
    key: 'flexibility', label: 'Flexibility & Mobility',
    metrics: [
      { key: 'mobility_score_computed', label: 'Mobility score', unit: '/100', higherIsBetter: true, decimals: 0 },
      { key: 'flexibility_test1_score', label: 'Test 1 score', unit: 'score', higherIsBetter: true, decimals: 1, protocol: 'flexibility_test_type' },
      { key: 'flexibility_test1_right', label: 'Test 1 right', unit: 'cm', higherIsBetter: true, decimals: 1, protocol: 'flexibility_test_type' },
      { key: 'flexibility_test1_left', label: 'Test 1 left', unit: 'cm', higherIsBetter: true, decimals: 1, protocol: 'flexibility_test_type' },
      { key: 'flexibility_test2_score', label: 'Test 2 score', unit: 'score', higherIsBetter: true, decimals: 1, protocol: 'flexibility_test_type_2' },
      { key: 'flexibility_test2_right', label: 'Test 2 right', unit: 'cm', higherIsBetter: true, decimals: 1, protocol: 'flexibility_test_type_2' },
      { key: 'flexibility_test2_left', label: 'Test 2 left', unit: 'cm', higherIsBetter: true, decimals: 1, protocol: 'flexibility_test_type_2' },
      // K11 four-test battery (v3 payload). The legacy metrics above and the
      // v3 metrics below never both resolve on the same row — different
      // protocols, different units, so no cross-protocol delta is offered.
      { key: 'flex_quadriceps_left_cm', label: 'Quadriceps left (gap)', unit: 'cm', higherIsBetter: false, decimals: 1 },
      { key: 'flex_quadriceps_right_cm', label: 'Quadriceps right (gap)', unit: 'cm', higherIsBetter: false, decimals: 1 },
      { key: 'flex_hamstrings_left_deg', label: 'Hamstrings left', unit: 'deg', higherIsBetter: true, decimals: 0 },
      { key: 'flex_hamstrings_right_deg', label: 'Hamstrings right', unit: 'deg', higherIsBetter: true, decimals: 0 },
      { key: 'flex_sit_reach_score_in', label: 'Sit and reach score', unit: 'in', higherIsBetter: true, decimals: 1 },
    ],
  },
];

const NUMBER_FIELDS = new Set(DOMAINS.flatMap((d) => d.metrics.map((m) => m.key)));

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(n) ? n : null;
}

function round(n, decimals = 2) {
  if (n == null) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function json(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

function testObj(assessment, field, index) {
  return json(assessment?.[field])?.[`test${index}`] || {};
}

function estimateOneRm(test) {
  const direct = num(test.direct1RM ?? test.one_rm ?? test.oneRm);
  if (direct != null) return direct;
  const weight = num(test.weightKg ?? test.weight_kg);
  const reps = num(test.reps);
  if (weight == null || reps == null || reps < 1) return null;
  if (test.isDirect === true) return weight;
  if (test.formula === 'brzycki') return round(weight / (1.0278 - 0.0278 * reps), 1);
  return round(weight * (1 + reps / 30), 1);
}

/** Extract JSON-only metrics without changing the stored assessment. */
function derived(assessment) {
  const strength1 = estimateOneRm(testObj(assessment, 'strength_test_data', 1));
  const strength2 = estimateOneRm(testObj(assessment, 'strength_test_data', 2));
  const end1 = testObj(assessment, 'endurance_test_data', 1);
  const end2 = testObj(assessment, 'endurance_test_data', 2);
  const flex1 = testObj(assessment, 'flexibility_test_data', 1);
  const flex2 = testObj(assessment, 'flexibility_test_data', 2);
  const flexType = (t) => t.testType || t.customTestType || null;
  // The K11 battery stores raw values inside tests.<key>.sides[side].
  const flexBlob = json(assessment?.flexibility_test_data);
  const v3 = flexBlob.protocol_version && flexBlob.tests ? flexBlob.tests : null;
  const v3val = (test, side, key) => num(v3 && v3[test] && v3[test].sides && v3[test].sides[side] ? v3[test].sides[side][key] : null);
  return {
    strength_test1_1rm: strength1,
    strength_test2_1rm: strength2,
    endurance_test1_reps: num(end1.reps),
    endurance_test1_duration: num(end1.durationSec),
    endurance_test2_reps: num(end2.reps),
    endurance_test2_duration: num(end2.durationSec),
    flexibility_test1_score: num(flex1.score),
    flexibility_test1_right: num(flex1.right),
    flexibility_test1_left: num(flex1.left),
    flexibility_test2_score: num(flex2.score),
    flexibility_test2_right: num(flex2.right),
    flexibility_test2_left: num(flex2.left),
    flexibility_test_type: flexType(flex1),
    flexibility_test_type_2: flexType(flex2),
    flex_quadriceps_left_cm: v3val('quadriceps', 'left', 'distance_cm'),
    flex_quadriceps_right_cm: v3val('quadriceps', 'right', 'distance_cm'),
    flex_hamstrings_left_deg: v3val('hamstrings', 'left', 'hip_flexion_deg'),
    flex_hamstrings_right_deg: v3val('hamstrings', 'right', 'hip_flexion_deg'),
    flex_sit_reach_score_in: num(v3 && v3.sit_and_reach ? v3.sit_and_reach.score_inches : null),
  };
}

function valueOf(assessment, key) {
  const direct = num(assessment?.[key]);
  if (direct != null) return direct;
  return derived(assessment)[key] ?? null;
}

function protocolValue(assessment, key) {
  if (!key) return null;
  const d = derived(assessment);
  if (d[key] !== undefined) return d[key];
  const v = assessment?.[key];
  return v == null || v === '' ? null : String(v);
}

function protocolFor(metric, a, b) {
  if (!metric.protocol) return { comparable: true, reason: null };
  const pa = protocolValue(a, metric.protocol);
  const pb = protocolValue(b, metric.protocol);
  // One side unrecorded is unknown, not incompatible. Showing the values with
  // a "protocol not recorded" note is more honest than withholding them.
  if (!pa || !pb) {
    if (pa === pb) return { comparable: true, reason: null };
    return { comparable: false, reason: 'Test protocol is not recorded for both assessments' };
  }
  if (String(pa).trim().toLowerCase() === String(pb).trim().toLowerCase()) {
    return { comparable: true, reason: null };
  }
  return { comparable: false, reason: `Protocol changed: ${pa} → ${pb}` };
}

function outcomeFor(metric, a, b, comparable) {
  if (a == null && b == null) return 'missing';
  if (!comparable) return 'incomparable';
  if (a == null) return 'new_measurement';
  if (b == null) return 'not_remeasured';
  if (a === b) return 'unchanged';
  if (metric.higherIsBetter === null) return 'changed';
  const improved = metric.higherIsBetter ? b > a : b < a;
  return improved ? 'improved' : 'declined';
}

function compareMetric(metric, a, b) {
  const av = valueOf(a, metric.key);
  const bv = valueOf(b, metric.key);
  const { comparable, reason } = protocolFor(metric, a, b);
  const absolute = av != null && bv != null ? round(bv - av, metric.decimals) : null;
  const percent = absolute != null && av !== 0
    ? round(((bv - av) / Math.abs(av)) * 100, 1)
    : null;
  const outcome = outcomeFor(metric, av, bv, comparable);
  return {
    key: metric.key,
    label: metric.label,
    unit: metric.unit,
    baseline_value: av,
    latest_value: bv,
    absolute_change: comparable ? absolute : null,
    percent_change: comparable ? percent : null,
    comparable,
    incomparable_reason: comparable ? null : reason,
    outcome,
    improved: outcome === 'improved' ? true : outcome === 'declined' ? false : null,
    decimals: metric.decimals,
  };
}

function summarizeAssessment(a) {
  if (!a) return null;
  return {
    id: a.id || null,
    assessment_number: a.assessment_number ?? null,
    assessment_date: a.assessment_date ? String(a.assessment_date).slice(0, 10) : null,
    assessment_type: a.assessment_type || null,
    testing_conditions: a.testing_conditions || null,
    trainer_notes: a.trainer_notes || null,
    health_notes: a.health_notes || null,
    posture_notes: a.posture_notes || null,
    overall_fitness_score: num(a.overall_fitness_score),
  };
}

function emptySummary() {
  return {
    compared: 0, improved: 0, declined: 0, unchanged: 0, changed: 0,
    new_measurements: 0, not_remeasured: 0, missing: 0, incomparable: 0,
  };
}

/**
 * Compare two assessments across all seven domains.
 * `previous` is optional and only decorates the output for history context.
 */
function compareAssessments(baseline, latest, previous = null) {
  const summary = emptySummary();
  const SUMMARY_KEY = {
    new_measurement: 'new_measurements',
    not_remeasured: 'not_remeasured',
  };
  const domains = DOMAINS.map((domain) => {
    const metrics = domain.metrics.map((metric) => {
      const row = compareMetric(metric, baseline, latest);
      const summaryKey = SUMMARY_KEY[row.outcome] || row.outcome;
      if (summaryKey in summary) summary[summaryKey] += 1;
      if (row.outcome !== 'missing') summary.compared += 1;
      return row;
    });
    const changedProtocol = metrics.find((m) => !m.comparable && m.incomparable_reason);
    return {
      key: domain.key,
      label: domain.label,
      comparable: !changedProtocol,
      incomparable_reason: changedProtocol?.incomparable_reason || null,
      metrics,
    };
  });

  return {
    baseline: summarizeAssessment(baseline),
    latest: summarizeAssessment(latest),
    previous: summarizeAssessment(previous),
    domains,
    summary,
    conditions: {
      baseline: baseline?.testing_conditions || null,
      latest: latest?.testing_conditions || null,
      changed: Boolean(
        baseline?.testing_conditions && latest?.testing_conditions
        && String(baseline.testing_conditions).trim().toLowerCase() !== String(latest.testing_conditions).trim().toLowerCase()
      ),
    },
    trainer_observations: [baseline?.trainer_notes, latest?.trainer_notes].filter(Boolean),
  };
}

module.exports = { DOMAINS, NUMBER_FIELDS, compareAssessments, compareMetric, valueOf, derived, summarizeAssessment };
